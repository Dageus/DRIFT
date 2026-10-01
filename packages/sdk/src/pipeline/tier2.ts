/**
 * Tier 2 settlement through a Safe whose owners each run their own engine, in six steps:
 *
 *   propose      announces (client, safe, contextUID, epoch, safeNonce, commitDeadline,
 *                revealDeadline), signed by an owner. It discloses nothing that determines the
 *                root, so no owner can learn the root before committing to its own.
 *   commit       each owner, until commitDeadline: computes its own snapshot and root and posts a
 *                signed RootCommitment to keccak256(root, inputDigest, salt).
 *   reveal       each owner, after commitDeadline and until revealDeadline: records the
 *                commitments it can see, then posts a signed RootReveal carrying that snapshot.
 *   publishTree  any owner, after revealDeadline: if `threshold` valid reveals agree on
 *                (root, inputDigest) and this owner computed the same, uploads the canonical tree
 *                and posts the treeURI and the Safe transaction that settles it.
 *   sign         each owner whose valid reveal has that root: fetches the tree by treeURI, checks
 *                it against the root, pins and stores it, rebuilds the Safe transaction itself and
 *                signs it.
 *   execute      anyone: submits once `threshold` signatures from owners with a valid reveal of
 *                the root are on the relay.
 *
 * A reveal is valid when it is signed by a Safe owner, opens that owner's signed commitment, and
 * the commitment was timely. Signed messages carry no trusted time, so timeliness is judged from
 * the reveals themselves: a commitment is timely when at least `threshold` well-formed reveals
 * list it in their snapshot. An owner who commits only after seeing others' reveals is missing
 * from the snapshots of every reveal made before it committed.
 *
 * Every step is idempotent and non-blocking: it returns 'waiting' when its window has not opened
 * or its inputs are not on the relay yet, 'already-done' when its output is already there, and
 * throws on a permanent failure (window passed, no quorum, mismatch). A scheduler can call them
 * repeatedly; time comes from `now` (Unix seconds), injectable for tests.
 *
 * Enforcement is off-chain. The Safe accepts any `threshold` owner signatures over a transaction,
 * whatever happened on the relay. Commit-reveal gives honest owners and an honest executor a rule
 * to follow, and leaves signed, attributable evidence against an owner who copied a root instead of
 * computing it. It does not stop owners who collude to sign without following it.
 */
import { Contract, type Signer, type TransactionResponse } from 'ethers';
import { buildOneRoundSettlement, safeTxHash, type SafeSettler } from '../safe/SafeSettler.js';
import type { IEpochEngine } from '../engines/epoch/IEpochEngine.js';
import type { EpochResult } from '../engines/epoch/protocol.js';
import type { ITreeTransport } from '../merkle/ITreeTransport.js';
import type { IMerkleStore } from '../merkle/IMerkleStore.js';
import { buildEpochTree } from '../merkle/epochTree.js';
import { EpochNotSynchronizedError } from '../settler.js';
import { DriftConfigError, DriftEngineError, DriftValidationError } from '../errors.js';
import { loadEpochSnapshot, type EpochSnapshotParams } from './snapshot.js';
import type { ISettlementRelay, PublishedSettlement } from './relay.js';
import {
  commitmentHash,
  commitmentIsSigned,
  deriveSalt,
  proposalSigner,
  revealIsSigned,
  signCommitment,
  signProposal,
  signReveal,
  tier2ProposalId,
  type SignedCommitment,
  type SignedReveal,
  type Tier2Proposal
} from './commitments.js';

const CLIENT_ABI = [
  'function contextUID() view returns (bytes32)',
  'function settlementBond() view returns (uint256)',
  'function epochRoots(uint256) view returns (bytes32)'
];

export type StepStatus = 'done' | 'already-done' | 'waiting';

export interface Tier2Base {
  safeSettler: SafeSettler;
  relay: ISettlementRelay;
  /** Current Unix time in seconds. Default: Date.now() / 1000. */
  now?: () => number;
}

/** What an owner needs to compute the epoch itself. `client` and `epoch` come from the proposal. */
export interface OwnerCompute {
  snapshot: Omit<EpochSnapshotParams, 'client' | 'epoch'>;
  engine: IEpochEngine;
}

const nowOf = (b: Tier2Base) => BigInt(Math.floor((b.now ?? (() => Date.now() / 1000))()));
const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();

async function requireOwner(safeSettler: SafeSettler, who: Signer): Promise<string> {
  const [addr, owners] = await Promise.all([who.getAddress(), safeSettler.owners()]);
  if (!owners.some((o) => same(o, addr))) {
    throw new DriftConfigError(`DRIFT SDK: ${addr} is not an owner of Safe ${safeSettler.safe}.`);
  }
  return addr;
}

// PROPOSE ===================================================================

export interface ProposeEpochTier2Params extends Tier2Base {
  proposer: Signer;
  epoch: bigint;
  /** Seconds from now until commitDeadline. Default 600. */
  commitWindow?: number;
  /** Seconds from commitDeadline until revealDeadline. Default 600. */
  revealWindow?: number;
}

export async function proposeEpochTier2(p: ProposeEpochTier2Params): Promise<Tier2Proposal> {
  const commitWindow = BigInt(p.commitWindow ?? 600);
  const revealWindow = BigInt(p.revealWindow ?? 600);
  if (commitWindow <= 0n || revealWindow <= 0n) throw new DriftConfigError('DRIFT SDK: commit and reveal windows must be positive.');
  await requireOwner(p.safeSettler, p.proposer);

  const client = new Contract(p.safeSettler.client, CLIENT_ABI, p.safeSettler.runner);
  const [contextUID, safeNonce, chainId] = (await Promise.all([
    client.contextUID!(),
    p.safeSettler.nonce(),
    p.safeSettler.chainId()
  ])) as [string, bigint, bigint];
  const proposalId = tier2ProposalId(p.safeSettler.client, contextUID, p.epoch, safeNonce);

  const existing = await p.relay.getProposal(proposalId);
  if (existing) return loadProposal(p, proposalId);

  const commitDeadline = nowOf(p) + commitWindow;
  const proposal = await signProposal(p.proposer, {
    proposalId,
    chainId,
    safe: p.safeSettler.safe,
    client: p.safeSettler.client,
    contextUID,
    epoch: p.epoch,
    safeNonce,
    commitDeadline,
    revealDeadline: commitDeadline + revealWindow
  });
  await p.relay.putProposal(proposal);
  return proposal;
}

/** Reads a proposal from the relay and checks it names this Safe and client and is owner-signed. */
export async function loadProposal(b: Tier2Base, proposalId: string): Promise<Tier2Proposal> {
  const proposal = await b.relay.getProposal(proposalId);
  if (!proposal) throw new DriftValidationError(`DRIFT SDK: no proposal ${proposalId} on the relay.`);
  const [chainId, owners] = await Promise.all([b.safeSettler.chainId(), b.safeSettler.owners()]);
  const signer = proposalSigner(proposal);
  const ok =
    proposal.chainId === chainId &&
    same(proposal.safe, b.safeSettler.safe) &&
    same(proposal.client, b.safeSettler.client) &&
    same(proposal.proposalId, tier2ProposalId(proposal.client, proposal.contextUID, proposal.epoch, proposal.safeNonce)) &&
    proposal.commitDeadline < proposal.revealDeadline &&
    signer !== null &&
    same(signer, proposal.proposer) &&
    owners.some((o) => same(o, signer));
  if (!ok) throw new DriftValidationError(`DRIFT SDK: proposal ${proposalId} is not a valid owner-signed proposal for this Safe.`);
  return proposal;
}

// SHARED CHECKS =============================================================

async function computeOwn(proposal: Tier2Proposal, c: OwnerCompute): Promise<EpochResult> {
  const snapshot = await loadEpochSnapshot({ ...c.snapshot, client: proposal.client, epoch: proposal.epoch });
  if (!same(snapshot.input.contextUID, proposal.contextUID)) {
    throw new DriftValidationError('DRIFT SDK: the client reports a different context than the proposal names.');
  }
  return c.engine.computeEpoch(snapshot.input);
}

export interface RevealEvaluation {
  /** Reveals that open a timely commitment of a Safe owner. */
  valid: SignedReveal[];
  /** Valid reveals grouped by `${root}:${inputDigest}`. */
  groups: Map<string, SignedReveal[]>;
}

/** Applies the validity and timeliness rules in the module comment. Pure given its inputs. */
export function evaluateReveals(
  proposal: Tier2Proposal,
  commitments: SignedCommitment[],
  reveals: SignedReveal[],
  owners: string[],
  threshold: bigint
): RevealEvaluation {
  const isOwner = (a: string) => owners.some((o) => same(o, a));
  const committed = new Map<string, string>();
  for (const c of commitments) {
    if (same(c.proposalId, proposal.proposalId) && isOwner(c.owner) && commitmentIsSigned(proposal.chainId, proposal.safe, c)) {
      committed.set(c.owner.toLowerCase(), c.commitment.toLowerCase());
    }
  }
  const wellFormed = reveals.filter((r) => {
    const own = committed.get(r.owner.toLowerCase());
    return (
      own !== undefined &&
      same(r.proposalId, proposal.proposalId) &&
      revealIsSigned(proposal.chainId, proposal.safe, r) &&
      same(commitmentHash(r.root, r.inputDigest, r.salt), own) &&
      r.seen.some((s) => same(s.owner, r.owner) && same(s.commitment, own))
    );
  });
  const timely = (owner: string, commitment: string) =>
    BigInt(wellFormed.filter((r) => r.seen.some((s) => same(s.owner, owner) && same(s.commitment, commitment))).length) >= threshold;
  const valid = wellFormed.filter((r) => timely(r.owner, committed.get(r.owner.toLowerCase())!));
  const groups = new Map<string, SignedReveal[]>();
  for (const r of valid) {
    const key = `${r.root.toLowerCase()}:${r.inputDigest.toLowerCase()}`;
    groups.set(key, [...(groups.get(key) ?? []), r]);
  }
  return { valid, groups };
}

async function evaluate(b: Tier2Base, proposal: Tier2Proposal): Promise<RevealEvaluation & { threshold: bigint }> {
  const [commitments, reveals, owners, threshold] = await Promise.all([
    b.relay.listCommitments(proposal.proposalId),
    b.relay.listReveals(proposal.proposalId),
    b.safeSettler.owners(),
    b.safeSettler.threshold()
  ]);
  return { ...evaluateReveals(proposal, commitments, reveals, owners, threshold), threshold };
}

// COMMIT ====================================================================

export interface OwnerStepParams extends Tier2Base {
  owner: Signer;
  proposalId: string;
}

export interface CommitRevealParams extends OwnerStepParams {
  compute: OwnerCompute;
  /** Explicit salt, for signers whose signatures are not deterministic. */
  salt?: string;
}

export async function commitEpochTier2(p: CommitRevealParams): Promise<{ status: StepStatus }> {
  const proposal = await loadProposal(p, p.proposalId);
  const owner = await requireOwner(p.safeSettler, p.owner);
  if ((await p.relay.listCommitments(proposal.proposalId)).some((c) => same(c.owner, owner))) return { status: 'already-done' };
  if (nowOf(p) > proposal.commitDeadline) {
    throw new DriftValidationError(`DRIFT SDK: the commit window of ${proposal.proposalId} closed at ${proposal.commitDeadline}.`);
  }

  let result: EpochResult;
  try {
    result = await computeOwn(proposal, p.compute);
  } catch (err) {
    if (err instanceof EpochNotSynchronizedError) return { status: 'waiting' };
    throw err;
  }
  const salt = p.salt ?? (await deriveSalt(p.owner, proposal.chainId, proposal.safe, proposal.proposalId));
  const signed = await signCommitment(p.owner, proposal.chainId, proposal.safe, {
    proposalId: proposal.proposalId,
    owner,
    commitment: commitmentHash(result.merkleRoot, result.inputDigest, salt)
  });
  await p.relay.putCommitment(signed);
  return { status: 'done' };
}

// REVEAL ====================================================================

export async function revealEpochTier2(p: CommitRevealParams): Promise<{ status: StepStatus }> {
  const proposal = await loadProposal(p, p.proposalId);
  const owner = await requireOwner(p.safeSettler, p.owner);
  const now = nowOf(p);
  if (now <= proposal.commitDeadline) return { status: 'waiting' };
  if ((await p.relay.listReveals(proposal.proposalId)).some((r) => same(r.owner, owner))) return { status: 'already-done' };
  if (now > proposal.revealDeadline) {
    throw new DriftValidationError(`DRIFT SDK: the reveal window of ${proposal.proposalId} closed at ${proposal.revealDeadline}.`);
  }

  // The snapshot of commitments is taken before anything else, so it reflects what was on the
  // relay when this owner started revealing.
  const [commitments, owners] = await Promise.all([p.relay.listCommitments(proposal.proposalId), p.safeSettler.owners()]);
  const seen = commitments
    .filter((c) => owners.some((o) => same(o, c.owner)) && commitmentIsSigned(proposal.chainId, proposal.safe, c))
    .map((c) => ({ owner: c.owner, commitment: c.commitment }));
  const own = seen.find((c) => same(c.owner, owner));
  if (!own) throw new DriftValidationError(`DRIFT SDK: ${owner} has no commitment for ${proposal.proposalId} to reveal.`);

  const result = await computeOwn(proposal, p.compute);
  const salt = p.salt ?? (await deriveSalt(p.owner, proposal.chainId, proposal.safe, proposal.proposalId));
  if (!same(commitmentHash(result.merkleRoot, result.inputDigest, salt), own.commitment)) {
    throw new DriftValidationError(
      'DRIFT SDK: the recomputed root does not open this owner\'s commitment. Either the input changed since committing, ' +
        'or the signer does not sign deterministically and the salt must be passed explicitly.'
    );
  }
  await p.relay.putReveal(
    await signReveal(p.owner, proposal.chainId, proposal.safe, {
      proposalId: proposal.proposalId,
      owner,
      root: result.merkleRoot,
      inputDigest: result.inputDigest,
      salt,
      seen
    })
  );
  return { status: 'done' };
}

// PUBLISH TREE ==============================================================

export interface PublishEpochTreeTier2Params extends OwnerStepParams {
  compute: OwnerCompute;
  transport: ITreeTransport;
  store?: IMerkleStore;
  /** Default: true. */
  pin?: boolean;
}

function quorumRoot(e: RevealEvaluation & { threshold: bigint }): { root: string; inputDigest: string } | null {
  for (const [key, group] of e.groups) {
    if (BigInt(group.length) >= e.threshold) {
      const [root, inputDigest] = key.split(':') as [string, string];
      return { root, inputDigest };
    }
  }
  return null;
}

async function expectedSettlementTx(
  b: Tier2Base,
  proposal: Tier2Proposal,
  root: string,
  treeURI: string
): Promise<{ tx: PublishedSettlement['tx']; hash: string; bond: bigint }> {
  const client = new Contract(proposal.client, CLIENT_ABI, b.safeSettler.runner);
  const [bond, clientDomain, nonce] = await Promise.all([
    client.settlementBond!() as Promise<bigint>,
    b.safeSettler.clientDomain(),
    b.safeSettler.nonce()
  ]);
  if (nonce !== proposal.safeNonce) {
    throw new DriftValidationError(`DRIFT SDK: the Safe nonce moved to ${nonce}; proposal ${proposal.proposalId} (nonce ${proposal.safeNonce}) is stale.`);
  }
  const tx = buildOneRoundSettlement(
    proposal.client,
    { clientDomain, contextUID: proposal.contextUID, epoch: proposal.epoch, merkleRoot: root, treeURI, bond: BigInt(bond) },
    proposal.safeNonce
  );
  return { tx, hash: safeTxHash(proposal.safe, proposal.chainId, tx), bond: BigInt(bond) };
}

export async function publishEpochTreeTier2(p: PublishEpochTreeTier2Params): Promise<{ status: StepStatus; settlement?: PublishedSettlement }> {
  const proposal = await loadProposal(p, p.proposalId);
  await requireOwner(p.safeSettler, p.owner);
  const existing = await p.relay.getSettlement(proposal.proposalId);
  if (existing) return { status: 'already-done', settlement: existing };
  if (nowOf(p) <= proposal.revealDeadline) return { status: 'waiting' };

  const agreed = quorumRoot(await evaluate(p, proposal));
  if (!agreed) throw new DriftValidationError(`DRIFT SDK: no root reached the Safe threshold of valid reveals for ${proposal.proposalId}.`);

  const result = await computeOwn(proposal, p.compute);
  if (!same(result.merkleRoot, agreed.root) || !same(result.inputDigest, agreed.inputDigest)) {
    throw new DriftValidationError('DRIFT SDK: this owner computed a different root than the agreed one; another owner must publish the tree.');
  }
  const tree = buildEpochTree(proposal.contextUID, proposal.epoch, result.entries);
  if (!same(tree.root, agreed.root)) throw new DriftEngineError(`DRIFT SDK: tree root ${tree.root} differs from the agreed root ${agreed.root}.`);

  const treeURI = await p.transport.uploadTree(tree);
  if ((p.pin ?? true) && p.transport.pin) await p.transport.pin(treeURI);
  if (p.store) await p.store.saveTree(proposal.contextUID, proposal.epoch, tree);

  const { tx, hash, bond } = await expectedSettlementTx(p, proposal, agreed.root, treeURI);
  const settlement: PublishedSettlement = {
    proposalId: proposal.proposalId,
    root: agreed.root,
    inputDigest: agreed.inputDigest,
    treeURI,
    bond,
    tx,
    safeTxHash: hash
  };
  await p.relay.putSettlement(settlement);
  return { status: 'done', settlement };
}

// SIGN ======================================================================

export interface SignEpochTier2Params extends OwnerStepParams {
  transport: ITreeTransport;
  store?: IMerkleStore;
  /** Default: true. */
  pin?: boolean;
}

export async function signEpochTier2(p: SignEpochTier2Params): Promise<{ status: StepStatus }> {
  const proposal = await loadProposal(p, p.proposalId);
  const owner = await requireOwner(p.safeSettler, p.owner);
  const settlement = await p.relay.getSettlement(proposal.proposalId);
  if (!settlement) return { status: 'waiting' };
  if ((await p.relay.listSignatures(proposal.proposalId)).some((s) => same(s.signer, owner))) return { status: 'already-done' };

  const e = await evaluate(p, proposal);
  const mine = e.valid.find((r) => same(r.owner, owner));
  if (!mine || !same(mine.root, settlement.root) || !same(mine.inputDigest, settlement.inputDigest)) {
    throw new DriftValidationError(`DRIFT SDK: ${owner} has no valid reveal of root ${settlement.root}; it does not sign.`);
  }
  const agreed = quorumRoot(e);
  if (!agreed || !same(agreed.root, settlement.root)) {
    throw new DriftValidationError(`DRIFT SDK: root ${settlement.root} does not have a threshold of valid reveals.`);
  }

  // The tree must be retrievable and be the agreed tree before this owner vouches for it.
  const tree = await p.transport.fetchTree(settlement.treeURI, {
    root: settlement.root,
    contextUID: proposal.contextUID,
    epoch: proposal.epoch
  });
  if ((p.pin ?? true) && p.transport.pin) await p.transport.pin(settlement.treeURI);
  if (p.store) await p.store.saveTree(proposal.contextUID, proposal.epoch, tree);

  // Sign only a transaction rebuilt here from the agreed root, never the relay's bytes as given.
  const { tx, hash } = await expectedSettlementTx(p, proposal, settlement.root, settlement.treeURI);
  if (!same(hash, settlement.safeTxHash)) {
    throw new DriftValidationError('DRIFT SDK: the published Safe transaction is not the settlement of the agreed root.');
  }
  await p.relay.putSignature(proposal.proposalId, await p.safeSettler.sign(p.owner, tx));
  return { status: 'done' };
}

// EXECUTE ===================================================================

export interface ExecuteEpochTier2Params extends Tier2Base {
  sender: Signer;
  proposalId: string;
}

export async function executeEpochTier2(
  p: ExecuteEpochTier2Params
): Promise<{ status: StepStatus; tx?: TransactionResponse }> {
  const proposal = await loadProposal(p, p.proposalId);
  const settlement = await p.relay.getSettlement(proposal.proposalId);
  if (!settlement) return { status: 'waiting' };

  const client = new Contract(proposal.client, CLIENT_ABI, p.safeSettler.runner);
  const posted = (await client.epochRoots!(proposal.epoch)) as string;
  if (same(posted, settlement.root)) return { status: 'already-done' };

  const e = await evaluate(p, proposal);
  const eligible = new Set(
    e.valid.filter((r) => same(r.root, settlement.root) && same(r.inputDigest, settlement.inputDigest)).map((r) => r.owner.toLowerCase())
  );
  const signatures = (await p.relay.listSignatures(proposal.proposalId)).filter((s) => eligible.has(s.signer.toLowerCase()));
  if (BigInt(signatures.length) < e.threshold) return { status: 'waiting' };

  const tx = await p.safeSettler.execute(p.sender, settlement.tx, signatures);
  await tx.wait();
  return { status: 'done', tx };
}

import { Contract } from 'ethers';
import type { DriftSettler } from '@drift-network/sdk';
import { ReputationModule } from '@drift-network/sdk';
import type { IEpochEngine } from '@drift-network/sdk/engines';
import type { EpochResult } from '@drift-network/sdk/engines';
import type { ITreeTransport } from '@drift-network/sdk/merkle';
import type { IMerkleStore } from '@drift-network/sdk/merkle';
import type { EpochTree } from '@drift-network/sdk/merkle';
import { DriftConfigError, DriftEngineError } from '@drift-network/sdk';
import type { EpochSnapshot } from './snapshot.js';
import { emitTrace, type Trace } from '../recorder/recorder.js';

const CLIENT_ABI = [
  'function trustedSettler() view returns (address)',
  'function settlementBond() view returns (uint256)'
];

export interface SettleEpochTier1Params {
  /** Signs and posts. Its signer must be the client's trustedSettler and have a provider. */
  settler: DriftSettler;
  client: string;
  /** From loadEpochSnapshot, which has already enforced O1. */
  snapshot: EpochSnapshot;
  engine: IEpochEngine;
  transport: ITreeTransport;
  /** Local copy of the tree, kept to answer omission challenges. Strongly recommended. */
  store?: IMerkleStore;
  /** Pin the uploaded tree when the transport supports it. Default: true. */
  pin?: boolean;
  /** Settlement bond to attach. Default: the client's current settlementBond(). */
  bond?: bigint;
  /** Recorder hook for root.computed, tree.uploaded and tree.pinned. Does not affect the result. */
  trace?: Trace;
}

export interface SettleEpochTier1Result {
  result: EpochResult;
  tree: EpochTree;
  root: string;
  treeURI: string;
  signature: string;
  txHash: string;
}

/**
 * Tier 1 settlement of one epoch by the trusted settler key:
 *
 *  1. checks the signer is the client's trustedSettler, before any upload;
 *  2. computes Phi_c with `engine` over the snapshot;
 *  3. builds the canonical tree, uploads it, and signs the root with its treeURI
 *     (DriftSettler.buildAndSignEpochRoot), checking the root matches the engine's;
 *  4. pins the tree, and saves it to `store`, before posting: once the root is on chain the
 *     settler must be able to answer challenges from its own copy, even if posting is retried;
 *  5. posts the root with the bond and waits for it to be mined.
 */
export async function settleEpochTier1(p: SettleEpochTier1Params): Promise<SettleEpochTier1Result> {
  const provider = p.settler.signer.provider;
  if (!provider) throw new DriftConfigError('DRIFT SDK: settleEpochTier1 needs a settler signer with a provider.');
  const client = new Contract(p.client, CLIENT_ABI, provider);
  const [trusted, currentBond, sender] = (await Promise.all([
    client.trustedSettler!(),
    p.bond === undefined ? client.settlementBond!() : Promise.resolve(p.bond),
    p.settler.signer.getAddress()
  ])) as [string, bigint, string];
  if (trusted.toLowerCase() !== sender.toLowerCase()) {
    throw new DriftConfigError(
      `DRIFT SDK: signer ${sender} is not the trusted settler ${trusted} of ${p.client}; a Safe settler uses the Tier 2 path.`
    );
  }

  const { input } = p.snapshot;
  let t = performance.now();
  const result = await p.engine.computeEpoch(input);
  emitTrace(p.trace, 'root.computed', {
    epoch: input.epoch,
    root: result.merkleRoot,
    inputDigest: result.inputDigest,
    nodes: result.scores.size,
    members: input.members.length,
    durationMs: performance.now() - t
  });
  const signed = await p.settler.buildAndSignEpochRoot(p.client, input.contextUID, input.epoch, result.entries, async (tree) => {
    const u = performance.now();
    const uri = await p.transport.uploadTree(tree);
    emitTrace(p.trace, 'tree.uploaded', { epoch: input.epoch, root: tree.root, treeURI: uri, leaves: result.entries.length, durationMs: performance.now() - u });
    return uri;
  });
  if (signed.root.toLowerCase() !== result.merkleRoot.toLowerCase()) {
    throw new DriftEngineError(
      `DRIFT SDK: settlement tree root ${signed.root} differs from the engine's root ${result.merkleRoot}.`
    );
  }

  if ((p.pin ?? true) && p.transport.pin) {
    t = performance.now();
    await p.transport.pin(signed.treeURI);
    emitTrace(p.trace, 'tree.pinned', { epoch: input.epoch, treeURI: signed.treeURI, durationMs: performance.now() - t });
  }
  if (p.store) await p.store.saveTree(input.contextUID, input.epoch, signed.tree);

  const txHash = await new ReputationModule(p.settler.signer).postEpochRoot(
    p.client,
    input.epoch,
    signed.root,
    signed.treeURI,
    signed.signature,
    BigInt(currentBond)
  );

  return { result, tree: signed.tree, root: signed.root, treeURI: signed.treeURI, signature: signed.signature, txHash };
}

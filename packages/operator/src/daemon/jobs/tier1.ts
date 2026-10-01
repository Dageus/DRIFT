import type { Logger } from 'pino';
import { DriftContractRevertError, DriftNotFoundError, EpochNotSynchronizedError } from '@drift-network/sdk';
import { findLeaves, type IMerkleStore } from '@drift-network/sdk/merkle';
import { isFinalized, type ClientActions, type ClientChain, type ClientState } from '../chain.js';
import type { ContextStatus } from '../status.js';

export interface SettledEpoch {
  root: string;
  treeURI: string;
  txHash: string;
}

export interface Tier1JobDeps {
  chain: ClientChain;
  /** Sent from the hot wallet. */
  actions: ClientActions;
  /** Holds every tree this settler posted, written before posting (settleEpochTier1). */
  store: IMerkleStore;
  /** Address of the settler key; must equal the client's trustedSettler. */
  settler: string;
  /** Snapshot, compute, upload, sign and post `epoch` (loadEpochSnapshot + settleEpochTier1). */
  settle: (epoch: bigint) => Promise<SettledEpoch>;
  bondScanDepth: number;
  log: Logger;
}

const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();
const revertName = (err: unknown) => (err instanceof DriftContractRevertError ? err.revertName : undefined);

/**
 * One reconcile step for a Tier 1 settler, safe to repeat and to run beside another instance:
 *
 *  1. answers open challenges against the current root from the stored tree, first because the
 *     response window is the tightest deadline the settler has;
 *  2. settles the next epoch once its boundary has passed, the previous epoch has finalized, and
 *     the chain has finalized past the boundary (O1, enforced inside `settle`);
 *  3. withdraws the bonds of finalized epochs.
 *
 * Every write is guarded by a chain read, and a revert showing another instance got there first
 * (already answered, already posted, already withdrawn) is treated as success.
 */
export async function runTier1(d: Tier1JobDeps, status: ContextStatus): Promise<void> {
  const state = await d.chain.state();
  const now = await d.chain.headTimestamp();
  status.contextUID = state.contextUID;
  status.currentEpoch = state.currentEpoch.toString();
  const alert = (level: 'warn' | 'error', message: string) => {
    status.alerts.push({ level, message, at: Number(now) });
    d.log[level]({ alert: message }, message);
  };

  if (state.currentEpoch > 0n) await answerChallenges(d, state, now, status, alert);

  const settlerOk = same(state.trustedSettler, d.settler);
  if (!settlerOk) {
    alert('error', `configured settler ${d.settler} is not the client's trustedSettler ${state.trustedSettler}; not settling`);
  } else {
    await settleNext(d, state, now, status, alert);
  }

  await withdrawBonds(d, state, now);
}

async function answerChallenges(
  d: Tier1JobDeps,
  state: ClientState,
  now: bigint,
  status: ContextStatus,
  alert: (level: 'warn' | 'error', message: string) => void
): Promise<void> {
  // challengeOmission only admits challenges against the current epoch.
  const epoch = state.currentEpoch;
  const open = (await d.chain.challenges(epoch)).filter((c) => !c.resolved);
  if (open.length === 0) return;

  const root = await d.chain.epochRoot(epoch);
  let tree;
  try {
    tree = await d.store.loadTree(state.contextUID, epoch);
  } catch (err) {
    if (!(err instanceof DriftNotFoundError)) throw err;
  }
  if (tree && tree.root.toLowerCase() !== root.toLowerCase()) {
    alert('error', `stored tree for epoch ${epoch} has root ${tree.root}, but ${root} is committed; cannot answer challenges`);
    tree = undefined;
  } else if (!tree) {
    alert('error', `no stored tree for epoch ${epoch}; cannot answer ${open.length} open challenge(s)`);
  }

  for (const c of open) {
    const base = { epoch: epoch.toString(), node: c.node, role: c.role, deadline: c.deadline.toString() };
    if (now > c.deadline) {
      alert('error', `challenge for ${c.node} role ${c.role} at epoch ${epoch} expired unanswered; the bond is forfeit`);
      status.challenges.push({ ...base, state: 'expired' });
      continue;
    }
    const leaf = tree ? findLeaves(tree, c.node, c.role)[0] : undefined;
    if (!leaf) {
      if (tree) alert('error', `no leaf for ${c.node} role ${c.role} at epoch ${epoch}: a genuine omission, the bond will be lost`);
      status.challenges.push({ ...base, state: 'unanswerable' });
      continue;
    }
    try {
      await d.actions.respondToChallenge(epoch, c.node, c.role, BigInt(leaf.value[3]!), leaf.proof);
      d.log.info({ epoch: epoch.toString(), node: c.node, role: c.role }, 'answered challenge');
    } catch (err) {
      if (revertName(err) !== 'ChallengeAlreadyResolved') throw err;
      d.log.info({ epoch: epoch.toString(), node: c.node, role: c.role }, 'challenge already answered');
    }
    status.challenges.push({ ...base, state: 'answered' });
  }
}

async function settleNext(
  d: Tier1JobDeps,
  state: ClientState,
  now: bigint,
  status: ContextStatus,
  alert: (level: 'warn' | 'error', message: string) => void
): Promise<void> {
  if (state.epochLength === 0n) {
    status.nextAction = 'waiting: the client has no epoch length configured';
    return;
  }
  const next = state.currentEpoch + 1n;
  const boundary = state.epochAnchorTimestamp + state.epochLength * next;
  if (now <= boundary) {
    status.nextAction = `settle epoch ${next} after its boundary ${boundary} (chain time ${now})`;
    return;
  }
  if (state.currentEpoch > 0n && !(await isFinalized(d.chain, state, state.currentEpoch, now))) {
    status.nextAction = `settle epoch ${next} once epoch ${state.currentEpoch} finalizes`;
    return;
  }
  try {
    const r = await d.settle(next);
    status.lastSettled = { epoch: next.toString(), ...r };
    status.nextAction = `settled epoch ${next}`;
    d.log.info({ epoch: next.toString(), root: r.root, treeURI: r.treeURI, tx: r.txHash }, 'settled epoch');
  } catch (err) {
    if (err instanceof EpochNotSynchronizedError) {
      status.nextAction = `settle epoch ${next} once the chain has finalized past ${boundary} (O1)`;
      return;
    }
    const name = revertName(err);
    if (name === 'InvalidEpoch' || name === 'EpochAlreadyPosted') {
      status.nextAction = `epoch ${next} was settled by another instance`;
      d.log.info({ epoch: next.toString(), revert: name }, 'epoch already settled elsewhere');
      return;
    }
    if (name === 'InsufficientBond' || name === 'BondBelowFloor') {
      alert('error', `settling epoch ${next} reverted with ${name}; check the settler's balance and the client's bond`);
      return;
    }
    throw err;
  }
}

async function withdrawBonds(d: Tier1JobDeps, state: ClientState, now: bigint): Promise<void> {
  const lowest = state.currentEpoch > BigInt(d.bondScanDepth) ? state.currentEpoch - BigInt(d.bondScanDepth) + 1n : 1n;
  for (let e = state.currentEpoch; e >= lowest; e--) {
    if ((await d.chain.epochBondAmount(e)) === 0n) continue;
    if (!(await isFinalized(d.chain, state, e, now))) continue;
    try {
      await d.actions.withdrawSettlementBond(e);
      d.log.info({ epoch: e.toString() }, 'withdrew settlement bond');
    } catch (err) {
      if (revertName(err) !== 'NoBondToWithdraw') throw err;
    }
  }
}

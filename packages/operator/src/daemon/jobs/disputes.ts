import type { Logger } from 'pino';
import { DriftContractRevertError, DriftNotFoundError } from '@drift-network/sdk';
import { findLeaves, type IMerkleStore } from '@drift-network/sdk/merkle';
import { isFinalized, type ClientActions, type ClientChain, type ClientState } from '../chain.js';
import type { ContextStatus } from '../status.js';

// Duties every settling role shares, whoever the trusted settler is: answering omission
// challenges against the current root, and withdrawing the bonds of finalized epochs. Both go
// through the hot wallet, which the contract accepts from any caller.

export interface DisputeDeps {
  chain: ClientChain;
  /** Sent from the hot wallet. */
  actions: ClientActions;
  /** Holds every tree this operator posted or signed for. */
  store: IMerkleStore;
  bondScanDepth: number;
  log: Logger;
}

export type Alert = (level: 'warn' | 'error', message: string) => void;

export const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();
export const revertName = (err: unknown) => (err instanceof DriftContractRevertError ? err.revertName : undefined);

/** Records an alert in this tick's status and logs it at the same level. */
export function alerter(status: ContextStatus, log: Logger, now: bigint): Alert {
  return (level, message) => {
    status.alerts.push({ level, message, at: Number(now) });
    log[level]({ alert: message }, message);
  };
}

/**
 * Answers every open challenge against the current epoch from the stored tree. challengeOmission
 * admits challenges only against the current epoch, and the next epoch cannot be posted while one
 * is open, so no other epoch can hold an answerable challenge.
 */
export async function answerChallenges(
  d: DisputeDeps,
  state: ClientState,
  now: bigint,
  status: ContextStatus,
  alert: Alert
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

/** Withdraws the bonds of finalized epochs among the latest `bondScanDepth`. */
export async function withdrawBonds(d: DisputeDeps, state: ClientState, now: bigint): Promise<void> {
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

/**
 * Whether the next epoch can be settled now: its boundary has passed in chain time and the
 * current epoch has finalized. Returns the epoch to settle, or why not yet (for /status). O1, the
 * chain having finalized past the boundary, is checked later by the snapshot itself.
 */
export async function nextSettlement(
  chain: ClientChain,
  state: ClientState,
  now: bigint
): Promise<{ epoch: bigint; boundary: bigint; ready: true } | { epoch: bigint; ready: false; reason: string }> {
  const epoch = state.currentEpoch + 1n;
  if (state.epochLength === 0n) return { epoch, ready: false, reason: 'waiting: the client has no epoch length configured' };
  const boundary = state.epochAnchorTimestamp + state.epochLength * epoch;
  if (now <= boundary) return { epoch, ready: false, reason: `settle epoch ${epoch} after its boundary ${boundary} (chain time ${now})` };
  if (state.currentEpoch > 0n && !(await isFinalized(chain, state, state.currentEpoch, now))) {
    return { epoch, ready: false, reason: `settle epoch ${epoch} once epoch ${state.currentEpoch} finalizes` };
  }
  return { epoch, boundary, ready: true };
}

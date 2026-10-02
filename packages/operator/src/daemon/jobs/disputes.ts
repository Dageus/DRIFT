import type { Logger } from 'pino';
import { DriftContractRevertError, DriftNotFoundError } from '@drift-network/sdk';
import { findLeaves, type IMerkleStore } from '@drift-network/sdk/merkle';
import { isFinalized, type ClientActions, type ClientChain, type ClientState } from '../chain.js';
import type { ContextStatus } from '../status.js';
import { NOOP_RECORDER, type ScopedRecorder } from '../../recorder/recorder.js';

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
  /** Event recorder for this context and tier. Default: off. */
  rec?: ScopedRecorder;
}

export const recOf = (d: { rec?: ScopedRecorder }): ScopedRecorder => d.rec ?? NOOP_RECORDER;

/**
 * Records, once each, the current epoch's root appearing on chain and its finalization, plus the
 * settlement itself (`settle.posted`, unless the job already recorded it with its transaction).
 * Reads only when recording is on.
 */
export async function observeEpoch(d: DisputeDeps, state: ClientState, now: bigint): Promise<void> {
  const rec = recOf(d);
  const epoch = state.currentEpoch;
  if (!rec.active || epoch === 0n) return;
  const [root, postedAt] = await Promise.all([d.chain.epochRoot(epoch), d.chain.epochPostedAt(epoch)]);
  if (/^0x0+$/.test(root)) return;
  const key = `${epoch}:${root.toLowerCase()}`;
  rec.once(`posted:${key}`, 'epoch.posted', { epoch, root, disputeWindowEndsAt: postedAt + state.disputeWindow, chainTime: Number(postedAt) });
  rec.once(`settled:${key}`, 'settle.posted', { epoch, root });
  if (await isFinalized(d.chain, state, epoch, now)) rec.once(`final:${key}`, 'epoch.finalized', { epoch, chainTime: Number(now) });
}

export type Alert = (level: 'warn' | 'error', message: string) => void;

export const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();
export const revertName = (err: unknown) => (err instanceof DriftContractRevertError ? err.revertName : undefined);

/** Fills the status fields every role reports from the client's state. */
export async function recordClientState(chain: ClientChain, state: ClientState, status: ContextStatus): Promise<void> {
  status.contextUID = state.contextUID;
  status.currentEpoch = state.currentEpoch.toString();
  status.pendingPayout = (await chain.pendingPayouts(state.trustedSettler)).toString();
}

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

  const rec = recOf(d);
  for (const c of open) {
    const base = { epoch: epoch.toString(), node: c.node, role: c.role, deadline: c.deadline.toString() };
    const ckey = `${epoch}:${c.node}:${c.role}:${c.openedAt}`;
    const at = { epoch, node: c.node, role: c.role };
    rec.once(`detected:${ckey}`, 'challenge.detected', { ...at, openedAt: c.openedAt, deadline: c.deadline, chainTime: Number(now) });
    if (now > c.deadline) {
      rec.once(`expired:${ckey}`, 'challenge.expired', at);
      alert('error', `challenge for ${c.node} role ${c.role} at epoch ${epoch} expired unanswered; the bond is forfeit`);
      status.challenges.push({ ...base, state: 'expired' });
      continue;
    }
    const leaf = tree ? findLeaves(tree, c.node, c.role)[0] : undefined;
    if (!leaf) {
      if (tree) alert('error', `no leaf for ${c.node} role ${c.role} at epoch ${epoch}: a genuine omission, the bond will be lost`);
      rec.once(`unanswerable:${ckey}`, 'challenge.unanswerable', at);
      status.challenges.push({ ...base, state: 'unanswerable' });
      continue;
    }
    try {
      await rec.action('challenge.respond', () => d.actions.respondToChallenge(epoch, c.node, c.role, BigInt(leaf.value[3]!), leaf.proof), { epoch });
      d.log.info({ epoch: epoch.toString(), node: c.node, role: c.role }, 'answered challenge');
    } catch (err) {
      if (revertName(err) !== 'ChallengeAlreadyResolved') throw err;
      d.log.info({ epoch: epoch.toString(), node: c.node, role: c.role }, 'challenge already answered');
    }
    rec.once(`answered:${ckey}`, 'challenge.answered', at);
    status.challenges.push({ ...base, state: 'answered' });
  }
}

/**
 * Withdraws the bonds of finalized epochs among the latest `bondScanDepth`. `delay(epoch)` defers
 * this operator's withdrawal by that many seconds past the end of the dispute window, so several
 * operators of one settler (the owners of a Safe) do not all send it and all but one revert.
 */
export async function withdrawBonds(d: DisputeDeps, state: ClientState, now: bigint, delay?: (epoch: bigint) => Promise<bigint>): Promise<void> {
  const lowest = state.currentEpoch > BigInt(d.bondScanDepth) ? state.currentEpoch - BigInt(d.bondScanDepth) + 1n : 1n;
  for (let e = state.currentEpoch; e >= lowest; e--) {
    if ((await d.chain.epochBondAmount(e)) === 0n) continue;
    if (!(await isFinalized(d.chain, state, e, now))) continue;
    if (delay) {
      const wait = await delay(e);
      if (wait > 0n && now <= (await d.chain.epochPostedAt(e)) + state.disputeWindow + wait) continue;
    }
    const rec = recOf(d);
    try {
      await rec.action('bond.withdraw', () => d.actions.withdrawSettlementBond(e), { epoch: e });
      d.log.info({ epoch: e.toString() }, 'withdrew settlement bond');
      rec.once(`bond:${e}`, 'bond.withdrawn', { epoch: e });
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

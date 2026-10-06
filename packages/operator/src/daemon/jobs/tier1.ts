import { EpochNotSynchronizedError } from '@drift-network/sdk';
import type { ClientState } from '../chain.js';
import type { ContextStatus } from '../status.js';
import {
  alerter,
  answerChallenges,
  nextSettlement,
  observeEpoch,
  recOf,
  recordClientState,
  revertName,
  same,
  withdrawBonds,
  type Alert,
  type DisputeDeps
} from './disputes.js';

export interface SettledEpoch {
  root: string;
  treeURI: string;
  txHash: string;
}

export interface Tier1JobDeps extends DisputeDeps {
  /** Address of the settler key; must equal the client's trustedSettler. */
  settler: string;
  /** Snapshot, compute, upload, sign and post `epoch` (loadEpochSnapshot + settleEpochTier1). */
  settle: (epoch: bigint) => Promise<SettledEpoch>;
}

/**
 * One reconcile step for a Tier 1 settler, safe to repeat and to run beside another instance:
 *
 *  1. answers open challenges against the current root from the stored tree, first because the
 *     response window is the tightest deadline the settler has;
 *  2. settles the next epoch once its boundary has passed, the previous epoch has finalized, and
 *     the chain has finalized past the boundary (O1, enforced inside `settle`);
 *  3. withdraws the bonds of finalized epochs.
 *
 * Deferred payouts (a forfeited challenge bond the contract could not push to the settler, held
 * in `pendingPayouts`) are only reported: `withdrawPendingPayout` pays its caller, so collecting
 * them needs the settler key itself, or a Safe transaction for a Safe settler.
 *
 * Every write is guarded by a chain read, and a revert showing another instance got there first
 * (already answered, already posted, already withdrawn) is treated as success.
 */
export async function runTier1(d: Tier1JobDeps, status: ContextStatus): Promise<void> {
  const state = await d.chain.state();
  const now = await d.chain.headTimestamp();
  await recordClientState(d.chain, state, status);
  const alert = alerter(status, d.log, now);

  if (state.currentEpoch > 0n) await answerChallenges(d, state, now, status, alert);
  await observeEpoch(d, state, now);

  const settlerOk = same(state.trustedSettler, d.settler);
  if (!settlerOk) {
    alert('error', `configured settler ${d.settler} is not the client's trustedSettler ${state.trustedSettler}; not settling`);
  } else {
    await settleNext(d, state, now, status, alert);
  }

  await withdrawBonds(d, state, now);
}

async function settleNext(
  d: Tier1JobDeps,
  state: ClientState,
  now: bigint,
  status: ContextStatus,
  alert: Alert
): Promise<void> {
  const plan = await nextSettlement(d.chain, state, now);
  if (!plan.ready) {
    status.nextAction = plan.reason;
    return;
  }
  const { epoch: next, boundary } = plan;
  const rec = recOf(d);
  rec.once(`due:${next}`, 'epoch.due', { epoch: next, chainTime: Number(boundary) });
  try {
    const r = await rec.action('settle.post', () => d.settle(next), { epoch: next });
    rec.once(`settled:${next}:${r.root.toLowerCase()}`, 'settle.posted', { epoch: next, root: r.root, treeURI: r.treeURI, txHash: r.txHash });
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

import type { Logger } from 'pino';
import type { EpochResult } from '@drift-network/sdk/engines';
import { findLeaves, type EpochTree } from '@drift-network/sdk/merkle';
import type { ClientActions, ClientChain } from '../chain.js';
import type { ContextStatus, WatchFinding } from '../status.js';
import { alerter, recOf, recordClientState, revertName, same } from './disputes.js';
import type { ScopedRecorder } from '../../recorder/recorder.js';

export interface WatcherJobDeps {
  chain: ClientChain;
  /** Sent from the hot wallet; used only when `challenge` is on. */
  actions: ClientActions;
  /** This watcher's own snapshot and engine run for `epoch` (loadEpochSnapshot + computeEpoch). */
  compute: (epoch: bigint) => Promise<EpochResult>;
  /** The posted tree, resolved from chain state and checked against the committed root. */
  fetchPosted: (epoch: bigint) => Promise<EpochTree>;
  /** Input digest behind the posted root, where knowable (a Tier 2 relay). */
  postedInputDigest?: (epoch: bigint) => Promise<string | undefined>;
  /** Open omission challenges for pairs missing from the posted tree. Default off. */
  challenge: boolean;
  /** Hot wallet address: the challenger. A pair naming it is a self-challenge. */
  challenger: string;
  /** Pad on the required challenge bond, in percent; the contract refunds the excess. Default 20. */
  bondPadPercent?: number;
  log: Logger;
  /** Event recorder for this context. Default: off. */
  rec?: ScopedRecorder;
}

/** Reverts that mean this watcher may not or need not challenge; reported, not failures. */
const STANDING = new Set([
  'ChallengerNotAdmitted',
  'ThirdPartyChallengeNotPermitted',
  'AlreadyChallengedThisEpoch',
  'ChallengeAlreadyOpen',
  'DisputeWindowClosed',
  'RoleNotHeldAtBoundary',
  'NodeNotEligibleForDispute',
  'EpochNotFound'
]);

/**
 * Watches one context. Once per posted root (the result is cached by epoch and root, so a
 * rollback and repost is checked again) it recomputes the epoch from its own snapshot and engine,
 * compares roots, fetches the posted tree and lists every pair of its own member set missing from
 * it. With `challenge` on, it opens at most one omission challenge per posting, which is the
 * contract's per-challenger limit, preferring a pair that names the watcher itself (self-challenge
 * needs no standing) and only while the dispute window is open.
 *
 * Divergence alone is not challengeable on chain: only omissions are. A wrong score inside a
 * complete tree is reported for people to act on.
 */
export function createWatcher(d: WatcherJobDeps): (status: ContextStatus) => Promise<void> {
  const checked = new Map<string, WatchFinding>();

  return async (status) => {
    const state = await d.chain.state();
    const now = await d.chain.headTimestamp();
    await recordClientState(d.chain, state, status);
    const alert = alerter(status, d.log, now);
    const epoch = state.currentEpoch;
    if (epoch === 0n) {
      status.nextAction = 'watching: no epoch posted yet';
      return;
    }
    const root = (await d.chain.epochRoot(epoch)).toLowerCase();
    const key = `${epoch}:${root}`;

    const rec = recOf(d);
    const postedAt = rec.active ? await d.chain.epochPostedAt(epoch) : 0n;
    rec.once(`seen:${key}`, 'watch.root_seen', { epoch, root, chainTime: Number(postedAt) });

    let finding = checked.get(key);
    if (!finding) {
      const started = performance.now();
      const ours = await d.compute(epoch);
      let tree: EpochTree | undefined;
      try {
        tree = await d.fetchPosted(epoch);
      } catch (err) {
        alert('error', `posted tree for epoch ${epoch} is not retrievable: ${(err as Error).message}`);
      }
      const omitted = tree
        ? ours.entries.filter((e) => findLeaves(tree, e.node, e.role).length === 0).map((e) => ({ node: e.node, role: e.role }))
        : [];
      finding = {
        epoch: epoch.toString(),
        postedRoot: root,
        ourRoot: ours.merkleRoot.toLowerCase(),
        ourInputDigest: ours.inputDigest,
        postedInputDigest: await d.postedInputDigest?.(epoch),
        agrees: same(ours.merkleRoot, root),
        treeAvailable: tree !== undefined,
        omitted
      };
      rec.emit('watch.recomputed', {
        epoch,
        postedRoot: root,
        ourRoot: finding.ourRoot,
        agrees: finding.agrees,
        treeAvailable: finding.treeAvailable,
        omitted: omitted.length,
        durationMs: performance.now() - started
      });
      if (!finding.agrees || omitted.length) {
        rec.once(`divergence:${key}`, 'watch.divergence', {
          epoch,
          postedRoot: root,
          ourRoot: finding.ourRoot,
          omitted: omitted.length,
          postedAt,
          chainTime: Number(now)
        });
      }
      if (!finding.agrees) {
        alert(
          'error',
          `epoch ${epoch} root ${root} differs from this watcher's ${finding.ourRoot} ` +
            `(input digest ${finding.ourInputDigest}${finding.postedInputDigest ? ` vs posted ${finding.postedInputDigest}` : ''})`
        );
      }
      if (omitted.length) alert('error', `epoch ${epoch} omits ${omitted.length} pair(s) this watcher holds at the boundary`);
      if (tree) checked.set(key, finding); // an unavailable tree is retried next tick
    }
    status.watch = finding;
    status.nextAction = finding.agrees ? `epoch ${epoch} verified` : `epoch ${epoch} diverges`;

    if (d.challenge && finding.omitted.length && !finding.challenged && !finding.challengeSkipped) {
      await challengeOne(d, finding, epoch, now, alert);
    }
  };
}

async function challengeOne(
  d: WatcherJobDeps,
  finding: WatchFinding,
  epoch: bigint,
  now: bigint,
  alert: (level: 'warn' | 'error', message: string) => void
): Promise<void> {
  const state = await d.chain.state();
  const postedAt = await d.chain.epochPostedAt(epoch);
  if (now > postedAt + state.disputeWindow) {
    finding.challengeSkipped = 'dispute window closed';
    recOf(d).emit('watch.challenge_skipped', { epoch, reason: finding.challengeSkipped });
    alert('warn', `dispute window for epoch ${epoch} closed; the omission can no longer be challenged`);
    return;
  }
  const existing = new Set((await d.chain.challenges(epoch)).map((c) => `${c.node}:${c.role}`));
  const candidates = finding.omitted.filter((p) => !existing.has(`${p.node.toLowerCase()}:${p.role.toLowerCase()}`));
  const pick = candidates.find((p) => same(p.node, d.challenger)) ?? candidates[0];
  if (!pick) return;

  const required = await d.chain.requiredChallengeBond();
  const bond = required + (required * BigInt(d.bondPadPercent ?? 20)) / 100n;
  try {
    await recOf(d).action('challenge.open', () => d.actions.challengeOmission(epoch, pick.node, pick.role, bond), { epoch });
    finding.challenged = pick;
    recOf(d).emit('watch.challenge_opened', { epoch, node: pick.node, role: pick.role, bond });
    d.log.warn({ epoch: epoch.toString(), node: pick.node, role: pick.role, bond: bond.toString() }, 'opened omission challenge');
  } catch (err) {
    const name = revertName(err);
    if (!name || !STANDING.has(name)) throw err;
    // One attempt per posting: standing does not change within an epoch round.
    finding.challengeSkipped = name;
    recOf(d).emit('watch.challenge_skipped', { epoch, reason: name });
    alert('warn', `cannot challenge ${pick.node} role ${pick.role} at epoch ${epoch}: ${name}`);
  }
}

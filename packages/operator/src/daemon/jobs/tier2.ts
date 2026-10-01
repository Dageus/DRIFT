import { DriftValidationError } from '@drift-network/sdk';
import type { RoundStatus, StepStatus } from '../../pipeline/tier2.js';
import type { ContextStatus, Tier2RoundStatus } from '../status.js';
import {
  alerter,
  answerChallenges,
  nextSettlement,
  observeEpoch,
  recOf,
  recordClientState,
  same,
  withdrawBonds,
  type DisputeDeps
} from './disputes.js';

/**
 * The Tier 2 pipeline steps for one owner of one Safe, bound to their relay, engine and keys.
 * makeTier2Steps (wiring) builds them over src/pipeline/tier2.ts; unit tests fake them.
 */
export interface Tier2Steps {
  /** The current round of `epoch` at the Safe's current nonce (latestRoundTier2), or null. */
  currentRound(epoch: bigint): Promise<{ round: bigint; proposalId: string } | null>;
  /** open, agreed or dead (roundStatusTier2). */
  roundStatus(proposalId: string): Promise<RoundStatus>;
  propose(epoch: bigint, round: bigint): Promise<void>;
  commit(proposalId: string): Promise<StepStatus>;
  reveal(proposalId: string): Promise<StepStatus>;
  publish(proposalId: string): Promise<StepStatus>;
  sign(proposalId: string): Promise<StepStatus>;
  /** Submits from the hot wallet once a threshold of eligible signatures exists. */
  execute(proposalId: string): Promise<StepStatus>;
}

export interface Tier2JobDeps extends DisputeDeps {
  /** The Safe; must be the client's trustedSettler. */
  safe: string;
  steps: Tier2Steps;
  /** Rounds tried per epoch before stopping for an operator decision. */
  maxRounds: number;
}

const STEPS = ['commit', 'reveal', 'publish', 'sign', 'execute'] as const;

/**
 * One reconcile step for a Safe owner. Like Tier 1 it first answers challenges and last withdraws
 * bonds (the Safe is the trusted settler, so both pay the Safe), and in between drives the Tier 2
 * round for the next epoch:
 *
 *  - Proposing: any owner may propose round 0 once the next epoch's boundary has passed and the
 *    current epoch has finalized, and round r+1 once round r is dead (past its reveal deadline
 *    without a quorum; see src/pipeline/tier2.ts). The proposalId is a function of (client,
 *    context, epoch, Safe nonce, round), so every owner derives the same id, and the relay keeps
 *    the first proposal written for it. An owner that loses that race follows the stored proposal.
 *    After `maxRounds` dead rounds the job stops proposing and raises an error alert.
 *  - Then commit, reveal, publish, sign and execute are attempted on every tick. Each returns
 *    'waiting' until its window or its inputs are ready and is a no-op once done, so the order of
 *    ticks across owners does not matter.
 *
 * A step that can never succeed for this owner (its window closed, its root lost the vote) is an
 * error alert, not a job failure, so the other steps and the dispute duties still run.
 */
export async function runTier2Owner(d: Tier2JobDeps, status: ContextStatus): Promise<void> {
  const state = await d.chain.state();
  const now = await d.chain.headTimestamp();
  await recordClientState(d.chain, state, status);
  const alert = alerter(status, d.log, now);

  if (state.currentEpoch > 0n) await answerChallenges(d, state, now, status, alert);
  await observeEpoch(d, state, now);

  if (!same(state.trustedSettler, d.safe)) {
    alert('error', `configured Safe ${d.safe} is not the client's trustedSettler ${state.trustedSettler}; not settling`);
  } else {
    const plan = await nextSettlement(d.chain, state, now);
    if (!plan.ready) {
      status.nextAction = plan.reason;
    } else {
      recOf(d).once(`due:${plan.epoch}`, 'epoch.due', { epoch: plan.epoch, chainTime: Number(plan.boundary) });
      await driveRound(d, plan.epoch, status, alert);
    }
  }

  await withdrawBonds(d, state, now);
}

async function driveRound(
  d: Tier2JobDeps,
  epoch: bigint,
  status: ContextStatus,
  alert: (level: 'warn' | 'error', message: string) => void
): Promise<void> {
  // Start round 0, or replace a dead round with the next one, unless maxRounds is reached.
  let proposed: 'done' | 'already-done' = 'already-done';
  let current = await d.steps.currentRound(epoch);
  if (!current) {
    proposed = await propose(d, epoch, 0n);
    current = await d.steps.currentRound(epoch);
    if (!current) throw new Error(`round 0 of epoch ${epoch} is still missing after proposing it`);
  } else if ((await d.steps.roundStatus(current.proposalId)) === 'dead') {
    outcome(d, epoch, current, 'dead');
    const next = current.round + 1n;
    if (next >= BigInt(d.maxRounds)) {
      status.tier2 = { epoch: epoch.toString(), round: current.round.toString(), proposalId: current.proposalId, state: 'dead', steps: emptySteps() };
      alert('error', `Tier 2 epoch ${epoch}: round ${current.round} is dead and maxRounds (${d.maxRounds}) is reached; it needs an operator decision.`);
      status.nextAction = `epoch ${epoch}: stopped after ${d.maxRounds} rounds`;
      return;
    }
    alert('warn', `Tier 2 epoch ${epoch}: round ${current.round} reached no quorum; proposing round ${next}`);
    proposed = await propose(d, epoch, next);
    current = (await d.steps.currentRound(epoch)) ?? current;
  }

  const proposalId = current.proposalId;
  const round: Tier2RoundStatus = {
    epoch: epoch.toString(),
    round: current.round.toString(),
    proposalId,
    state: await d.steps.roundStatus(proposalId),
    steps: { ...emptySteps(), propose: proposed }
  };
  status.tier2 = round;
  if (round.state !== 'open') outcome(d, epoch, current, round.state);
  const log = d.log.child({ epoch: epoch.toString(), round: current.round.toString(), proposalId });
  const rec = recOf(d);

  for (const step of STEPS) {
    try {
      const run = () => d.steps[step](proposalId);
      const result = step === 'execute' ? await rec.action('tier2.execute', run, { epoch, round: current.round }) : await run();
      round.steps[step] = result;
      if (result === 'done') log.info({ step }, `${step} done`);
    } catch (err) {
      if (!(err instanceof DriftValidationError)) throw err;
      round.steps[step] = 'failed';
      alert('error', `Tier 2 ${step} for epoch ${epoch} round ${current.round}: ${err.message}`);
    }
  }

  const pending = STEPS.find((s) => round.steps[s] === 'waiting');
  status.nextAction =
    round.steps.execute === 'done' || round.steps.execute === 'already-done'
      ? `epoch ${epoch} settled through the Safe`
      : pending
        ? `epoch ${epoch} round ${current.round}: waiting to ${pending}`
        : `epoch ${epoch} round ${current.round}: in progress`;
}

const emptySteps = (): Tier2RoundStatus['steps'] => ({
  propose: 'pending',
  commit: 'pending',
  reveal: 'pending',
  publish: 'pending',
  sign: 'pending',
  execute: 'pending'
});

/** Proposes `round`; another owner's proposal landing first counts as already done. */
async function propose(d: Tier2JobDeps, epoch: bigint, round: bigint): Promise<'done' | 'already-done'> {
  try {
    await d.steps.propose(epoch, round);
    d.log.info({ epoch: epoch.toString(), round: round.toString() }, 'proposed round');
    return 'done';
  } catch (err) {
    const current = await d.steps.currentRound(epoch);
    if (current && current.round >= round) return 'already-done';
    throw err;
  }
}

/** Records a round's outcome the first time this process sees it. */
function outcome(d: Tier2JobDeps, epoch: bigint, r: { round: bigint; proposalId: string }, value: string): void {
  recOf(d).once(`outcome:${r.proposalId}`, 'tier2.round_outcome', { epoch, round: r.round, proposalId: r.proposalId, outcome: value });
}

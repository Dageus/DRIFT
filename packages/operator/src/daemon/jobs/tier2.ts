import { DriftValidationError } from '@drift-network/sdk';
import type { StepStatus } from '../../pipeline/tier2.js';
import type { ContextStatus, Tier2RoundStatus } from '../status.js';
import { alerter, recordClientState, answerChallenges, nextSettlement, same, withdrawBonds, type DisputeDeps } from './disputes.js';

/**
 * The Tier 2 pipeline steps for one owner of one Safe, bound to their relay, engine and keys.
 * makeTier2Steps (wiring) builds them over src/pipeline/tier2.ts; unit tests fake them.
 */
export interface Tier2Steps {
  /** proposalId for `epoch` at the Safe's current nonce. */
  proposalId(epoch: bigint): Promise<string>;
  hasProposal(proposalId: string): Promise<boolean>;
  propose(epoch: bigint): Promise<void>;
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
}

const STEPS = ['commit', 'reveal', 'publish', 'sign', 'execute'] as const;

/**
 * One reconcile step for a Safe owner. Like Tier 1 it first answers challenges and last withdraws
 * bonds (the Safe is the trusted settler, so both pay the Safe), and in between drives the Tier 2
 * round for the next epoch:
 *
 *  - Proposing: any owner may propose once the next epoch's boundary has passed and the current
 *    epoch has finalized. The proposalId is a function of (client, context, epoch, Safe nonce), so
 *    every owner derives the same id, and the relay keeps the first proposal written for it. An
 *    owner that loses that race uses the stored proposal, deadlines included.
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

  if (!same(state.trustedSettler, d.safe)) {
    alert('error', `configured Safe ${d.safe} is not the client's trustedSettler ${state.trustedSettler}; not settling`);
  } else {
    const plan = await nextSettlement(d.chain, state, now);
    if (!plan.ready) {
      status.nextAction = plan.reason;
    } else {
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
  const proposalId = await d.steps.proposalId(epoch);
  const round: Tier2RoundStatus = {
    epoch: epoch.toString(),
    proposalId,
    steps: { propose: 'pending', commit: 'pending', reveal: 'pending', publish: 'pending', sign: 'pending', execute: 'pending' }
  };
  status.tier2 = round;
  const log = d.log.child({ epoch: epoch.toString(), proposalId });

  if (await d.steps.hasProposal(proposalId)) {
    round.steps.propose = 'already-done';
  } else {
    try {
      await d.steps.propose(epoch);
      round.steps.propose = 'done';
      log.info('proposed round');
    } catch (err) {
      // Another owner's proposal landed first; the relay keeps it and this owner follows it.
      if (!(await d.steps.hasProposal(proposalId))) throw err;
      round.steps.propose = 'already-done';
    }
  }

  for (const step of STEPS) {
    try {
      const result = await d.steps[step](proposalId);
      round.steps[step] = result;
      if (result === 'done') log.info({ step }, `${step} done`);
    } catch (err) {
      if (!(err instanceof DriftValidationError)) throw err;
      round.steps[step] = 'failed';
      const hint =
        step === 'publish' && /no root reached/.test(err.message)
          ? ' The round cannot be retried while the Safe nonce is unchanged; it needs an operator decision.'
          : '';
      alert('error', `Tier 2 ${step} for epoch ${epoch}: ${err.message}${hint}`);
    }
  }

  const pending = STEPS.find((s) => round.steps[s] === 'waiting');
  status.nextAction =
    round.steps.execute === 'done' || round.steps.execute === 'already-done'
      ? `epoch ${epoch} settled through the Safe`
      : pending
        ? `epoch ${epoch}: waiting to ${pending}`
        : `epoch ${epoch}: round in progress`;
}

import type { ExperimentConfig } from './config.js';

/** Time from sending a transaction to its receipt on a chain with 12-second blocks, roughly. */
const INCLUSION_SECONDS = 24;

export interface TierSchedule {
  tier: 'tier1' | 'tier2';
  epochs: number;
  /**
   * Seconds from an epoch's boundary until that epoch can finalize when nothing goes wrong: the
   * wait for finality (O1), the settlement itself and the dispute window. The next epoch can be
   * posted only once this one is final, so a path longer than the epoch makes the tier fall behind.
   */
  criticalPathSeconds: number;
  /** epochLength - criticalPath; negative means the tier falls further behind every epoch. */
  slackSeconds: number;
  /** Extra time the adversarial scenarios on this tier add. */
  adversarialSeconds: number;
  durationSeconds: number;
  notes: string[];
}

export interface Schedule {
  tiers: TierSchedule[];
  /** The tiers run side by side: the run lasts as long as the slower one. */
  durationSeconds: number;
  warnings: string[];
}

/**
 * Estimates how long the run takes and whether each tier keeps pace with its epochs. Pure; the
 * figures are planning estimates (finality varies between 768 and 1152 s on Sepolia).
 */
export function estimateSchedule(cfg: ExperimentConfig): Schedule {
  const { epochLengthSeconds: len, disputeWindowSeconds: dispute, responseWindowSeconds: response, finalitySeconds: finality } = cfg.timing;
  const poll = cfg.run.pollIntervalSeconds;
  const tiers: TierSchedule[] = [];
  const warnings: string[] = [];

  const tier = (name: 'tier1' | 'tier2', epochs: number, path: number, adversarial: number, notes: string[]) => {
    if (epochs === 0) return;
    const slack = len - path;
    const drift = slack < 0 ? -slack * epochs : 0;
    const duration = epochs * len + drift + adversarial + path;
    if (slack < 0) {
      warnings.push(
        `${name}: each epoch needs about ${path} s from its boundary to finality, more than the ${len} s epoch; it falls ${-slack} s further behind every epoch (about ${Math.round(drift / 60)} min over ${epochs} epochs), and its settlement latency then includes that backlog.`
      );
    } else if (slack < poll * 3) {
      warnings.push(`${name}: only ${slack} s of slack per epoch; a slow finality or a missed tick makes it fall behind.`);
    }
    tiers.push({ tier: name, epochs, criticalPathSeconds: path, slackSeconds: slack, adversarialSeconds: adversarial, durationSeconds: duration, notes });
  };

  const repost = response + poll + INCLUSION_SECONDS + dispute + poll + INCLUSION_SECONDS;
  const om = cfg.adversarial.omissionChallenges + cfg.adversarial.watcherChallenges;
  tier('tier1', cfg.tier1.epochs, finality + poll + INCLUSION_SECONDS + dispute, om * repost, [
    `path = finality ${finality} + tick ${poll} + inclusion ${INCLUSION_SECONDS} + dispute ${dispute}`,
    `each of ${om} omission(s) adds about ${repost} s (response window, claim, repost, a new dispute window)`
  ]);

  const { commitWindowSeconds: commit, revealWindowSeconds: reveal } = cfg.tier2;
  // Propose after O1, then commit, reveal, publish, sign and execute, each on a daemon tick.
  const t2path = finality + poll + commit + reveal + 3 * poll + INCLUSION_SECONDS + dispute;
  tier('tier2', cfg.tier2.epochs, t2path, cfg.adversarial.deadRounds * (commit + reveal + 2 * poll), [
    `path = finality ${finality} + propose tick ${poll} + commit ${commit} + reveal ${reveal} + publish/sign/execute ticks ${3 * poll} + inclusion ${INCLUSION_SECONDS} + dispute ${dispute}`,
    `each of ${cfg.adversarial.deadRounds} dead round(s) adds about ${commit + reveal + 2 * poll} s`
  ]);

  return { tiers, durationSeconds: Math.max(0, ...tiers.map((t) => t.durationSeconds)), warnings };
}

export function formatDuration(s: number): string {
  const h = Math.floor(s / 3600);
  const m = Math.round((s % 3600) / 60);
  return h > 0 ? `${h} h ${m} min` : `${m} min`;
}

import type { ExperimentConfig } from '../config.js';

/**
 * The member workload, as pure functions of the config, so a resumed run computes exactly the
 * same plan. Nodes are referred to by ordinal (0..N-1).
 */

/** The attestations of one node in one wave: distinct other nodes, rotating with the wave. */
export function attestSubjects(cfg: ExperimentConfig, node: number, wave: number): number[] {
  const n = cfg.nodes;
  const k = cfg.attestations.perNodePerRound;
  const out: number[] = [];
  for (let j = 1; out.length < k; j++) {
    const s = (node + j + wave * k) % n;
    if (s !== node && !out.includes(s)) out.push(s);
  }
  return out;
}

/** A score in 1..100, deterministic per (attester, subject, wave). */
export function attestScore(attester: number, subject: number, wave: number): bigint {
  return BigInt(1 + ((attester * 31 + subject * 17 + wave * 7) % 100));
}

/**
 * The epoch (1-based, of the longer tier) whose first part each attestation wave falls in: waves
 * are spread evenly over the run, and wave 0 comes before the first boundary.
 */
export function waveEpochs(cfg: ExperimentConfig): number[] {
  const epochs = Math.max(cfg.tier1.epochs, cfg.tier2.epochs);
  const r = cfg.attestations.rounds;
  return Array.from({ length: r }, (_, w) => Math.floor((w * epochs) / Math.max(1, r)) + 1);
}

/** Node ordinals that claim after `epoch` of `tier` finalizes. */
export function claimers(cfg: ExperimentConfig, tier: 'tier1' | 'tier2', epoch: number): number[] {
  const k = Math.min(cfg.claims.perEpoch, cfg.nodes);
  const offset = tier === 'tier2' ? Math.floor(cfg.nodes / 2) : 0;
  return Array.from({ length: k }, (_, i) => (offset + epoch * k + i) % cfg.nodes);
}

export interface ProposalPlan {
  index: number;
  tier: 'tier1' | 'tier2';
  /** Created right after this epoch finalizes, so it is the proposal's snapshot epoch. */
  epoch: number;
  proposer: number;
  voters: number[];
}

/** Proposals alternate between the tiers that run, spread evenly over each tier's epochs. */
export function proposals(cfg: ExperimentConfig): ProposalPlan[] {
  const tiers = ([['tier1', cfg.tier1.epochs], ['tier2', cfg.tier2.epochs]] as const).filter(([, e]) => e > 0);
  if (tiers.length === 0) return [];
  const p = cfg.governance.proposals;
  const out: ProposalPlan[] = [];
  for (let i = 0; i < p; i++) {
    const [tier, epochs] = tiers[i % tiers.length]!;
    const nth = Math.floor(i / tiers.length);
    const perTier = Math.ceil(p / tiers.length);
    const epoch = Math.max(1, Math.floor(((nth + 1) * epochs) / (perTier + 1)));
    const proposer = (i * 7) % cfg.nodes;
    const voters: number[] = [];
    for (let j = 1; voters.length < Math.min(cfg.governance.votersPerProposal, cfg.nodes - 1); j++) {
      const v = (proposer + j) % cfg.nodes;
      if (v !== proposer) voters.push(v);
    }
    out.push({ index: i, tier, epoch, proposer, voters });
  }
  return out;
}

/**
 * Where the adversarial scenarios happen: early enough that a short run still has them, late
 * enough that they do not hit epoch 1, and on different epochs so they do not interact.
 * Tier 1: the spurious (answered) challenge and the watcher-caught omission. Tier 2: the dead round.
 */
export function scenarioEpochs(cfg: ExperimentConfig): { answered: number[]; omission: number[]; deadRound: number[] } {
  const pick = (count: number, epochs: number, start: number, step: number) =>
    Array.from({ length: count }, (_, i) => start + i * step).filter((e) => e >= 2 && e <= epochs);
  const e1 = cfg.tier1.epochs;
  const e2 = cfg.tier2.epochs;
  return {
    answered: pick(cfg.adversarial.answeredChallenges, e1, Math.max(2, Math.floor(e1 / 4)), 3),
    omission: pick(cfg.adversarial.watcherChallenges, e1, Math.max(3, Math.floor(e1 / 2)), 3),
    deadRound: pick(cfg.adversarial.deadRounds, e2, Math.max(2, Math.floor(e2 / 3)), 3)
  };
}

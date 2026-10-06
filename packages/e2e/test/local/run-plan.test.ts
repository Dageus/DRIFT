import { describe, it, expect } from 'vitest';
import { parseExperimentConfig } from '../../src/config.js';
import { estimateSchedule } from '../../src/schedule.js';
import { attestSubjects, claimers, proposals, scenarioEpochs, waveEpochs } from '../../src/run/workload.js';
import { inParallel } from '../../src/journal.js';
import { baseConfig } from './fixtures.js';

const cfg = (over: Record<string, unknown> = {}) => parseExperimentConfig(baseConfig({ nodes: 10, ...over }));

describe('workload', () => {
  it('attests to distinct other nodes, rotating between waves', () => {
    const c = cfg({ attestations: { perNodePerRound: 3, rounds: 4 } });
    for (let node = 0; node < 10; node++) {
      for (let wave = 0; wave < 4; wave++) {
        const s = attestSubjects(c, node, wave);
        expect(s).toHaveLength(3);
        expect(new Set(s).size).toBe(3);
        expect(s).not.toContain(node);
      }
    }
    expect(attestSubjects(c, 0, 0)).not.toEqual(attestSubjects(c, 0, 1));
  });

  it('spreads waves over the run, the first in epoch 1', () => {
    const w = waveEpochs(cfg({ attestations: { perNodePerRound: 2, rounds: 4 }, tier1: { epochs: 40 }, tier2: { epochs: 40 } }));
    expect(w).toEqual([1, 11, 21, 31]);
  });

  it('claims with different nodes per tier and epoch, never more than the nodes', () => {
    const c = cfg({ claims: { perEpoch: 3 } });
    expect(claimers(c, 'tier1', 1)).toHaveLength(3);
    expect(claimers(c, 'tier1', 1)).not.toEqual(claimers(c, 'tier2', 1));
    expect(new Set(claimers(c, 'tier1', 2)).size).toBe(3);
  });

  it('alternates proposals between the tiers, within each tier, with voters other than the proposer', () => {
    const c = cfg({ governance: { proposals: 4, votersPerProposal: 5 }, tier1: { epochs: 10 }, tier2: { epochs: 10 } });
    const ps = proposals(c);
    expect(ps.map((p) => p.tier)).toEqual(['tier1', 'tier2', 'tier1', 'tier2']);
    for (const p of ps) {
      expect(p.epoch).toBeGreaterThanOrEqual(1);
      expect(p.epoch).toBeLessThanOrEqual(10);
      expect(p.voters).toHaveLength(5);
      expect(p.voters).not.toContain(p.proposer);
    }
  });

  it('places one of each scenario on distinct epochs after the first', () => {
    const c = cfg({ tier1: { epochs: 40 }, tier2: { epochs: 40 }, adversarial: { omissionChallenges: 0, answeredChallenges: 1, watcherChallenges: 1, deadRounds: 1 } });
    const s = scenarioEpochs(c);
    expect(s.answered).toHaveLength(1);
    expect(s.omission).toHaveLength(1);
    expect(s.deadRound).toHaveLength(1);
    expect(s.answered[0]).not.toBe(s.omission[0]);
    expect(Math.min(...s.answered, ...s.omission, ...s.deadRound)).toBeGreaterThanOrEqual(2);
  });
});

describe('schedule', () => {
  it('reports the critical path per tier and warns when a tier cannot keep pace', () => {
    const ok = estimateSchedule(cfg({ timing: { epochLengthSeconds: 1800, disputeWindowSeconds: 600, responseWindowSeconds: 600, finalitySeconds: 960 }, tier2: { epochs: 4, commitWindowSeconds: 60, revealWindowSeconds: 60 } }));
    expect(ok.tiers.find((t) => t.tier === 'tier2')!.slackSeconds).toBeGreaterThan(0);
    expect(ok.warnings).toEqual([]);
    const slow = estimateSchedule(cfg({ timing: { epochLengthSeconds: 1800, disputeWindowSeconds: 600, responseWindowSeconds: 600, finalitySeconds: 960 }, tier2: { epochs: 4, commitWindowSeconds: 300, revealWindowSeconds: 300 } }));
    expect(slow.warnings.join()).toMatch(/tier2: .* falls \d+ s further behind every epoch/);
  });
});

describe('inParallel', () => {
  it('bounds concurrency and reports a failure after the others finish', async () => {
    let inFlight = 0;
    let peak = 0;
    const done: number[] = [];
    await expect(
      inParallel([1, 2, 3, 4, 5, 6], 2, async (i) => {
        inFlight++;
        peak = Math.max(peak, inFlight);
        await new Promise((r) => setTimeout(r, 5));
        inFlight--;
        if (i === 3) throw new Error('boom');
        done.push(i);
      })
    ).rejects.toThrow('boom');
    expect(peak).toBe(2);
    expect(done.sort()).toEqual([1, 2, 4, 5, 6]);
  });
});

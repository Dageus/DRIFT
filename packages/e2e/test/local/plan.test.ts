import { describe, it, expect } from 'vitest';
import { parseEther, parseUnits } from 'ethers';
import { parseExperimentConfig } from '../../src/config.js';
import { deriveSlots, slotIndices } from '../../src/keys.js';
import { ESTIMATES, gasTable } from '../../src/gas.js';
import { buildPlan, challengeBondWei, keyActions, share, topUps } from '../../src/plan.js';
import { sweepAmount } from '../../src/ops.js';
import { ANVIL_MNEMONIC, baseConfig } from './fixtures.js';

const cfg = parseExperimentConfig(baseConfig());
const slots = deriveSlots(ANVIL_MNEMONIC, slotIndices(cfg));
const gwei10 = parseUnits('10', 'gwei');

describe('funding plan', () => {
  it('share distributes exactly', () => {
    for (const [total, n] of [[0, 3], [7, 3], [3, 7], [100, 6]] as const) {
      const parts = Array.from({ length: n }, (_, i) => share(total, n, i));
      expect(parts.reduce((a, b) => a + b, 0)).toBe(total);
      expect(Math.max(...parts) - Math.min(...parts)).toBeLessThanOrEqual(1);
    }
  });

  it("computes a key's target as gas x maxFee x margin + capital, plus one sweep transfer", () => {
    const plan = buildPlan(cfg, slots, gasTable());
    const settler = plan.keys.find((k) => k.role === 'tier1-settler')!;
    // 4 epochs + 1 omission + 1 watcher re-post, then one sweep transfer.
    expect(settler.actions).toEqual([
      { action: 'postEpochRoot', count: 6, gasEach: ESTIMATES.postEpochRoot.gas, source: 'estimate' },
      { action: 'transfer', count: 1, gasEach: 21_000n, source: 'estimate' }
    ]);
    const units = 6n * ESTIMATES.postEpochRoot.gas + 21_000n;
    expect(settler.gasUnits).toBe(units);
    expect(settler.gasWei).toBe((units * gwei10 * 15_000n) / 10_000n);
    expect(settler.capitalWei).toBe(4n * parseEther('0.001'));
    expect(settler.targetWei).toBe(settler.gasWei + settler.capitalWei);
  });

  it('gives owners nothing, and accounts for the funder fees and reserve', () => {
    const plan = buildPlan(cfg, slots, gasTable());
    for (const k of plan.keys.filter((k) => k.role === 'tier2-owner')) expect(k.targetWei).toBe(0n);
    const funded = plan.keys.filter((k) => k.targetWei > 0n).length;
    expect(plan.funderFeeWei).toBe((BigInt(funded) * 21_000n * gwei10 * 15_000n) / 10_000n);
    expect(plan.requiredWei).toBe(plan.totalTargetWei + plan.funderFeeWei + parseEther('0.01'));
  });

  it('assigns challenge duties to distinct nodes and spreads claims and votes', () => {
    const node = (i: number) => keyActions(cfg, slots.find((s) => s.role === 'node' && s.ordinal === i)!);
    expect(node(0).actions.map(([a]) => a)).toContain('claimUnansweredChallenge');
    expect(node(1).actions.map(([a]) => a)).toContain('challengeOmission');
    expect(node(1).actions.map(([a]) => a)).not.toContain('claimUnansweredChallenge');
    expect(node(2).actions.map(([a]) => a)).not.toContain('challengeOmission');
    const total = (a: string) => slots.filter((s) => s.role === 'node').reduce((s, slot) => s + (keyActions(cfg, slot).actions.find(([x]) => x === a)?.[1] ?? 0), 0);
    expect(total('claimReputation')).toBe(2 * (4 + 3));
    expect(total('castVote')).toBe(2 * 3);
    expect(total('easAttest')).toBe(6 * 2 * 3);
  });

  it('sizes the challenge bond for the worst base fee once responseGasEstimate is set', () => {
    expect(challengeBondWei(cfg)).toBe(parseEther('0.001'));
    const hot = parseExperimentConfig(baseConfig({ bonds: { responseGasEstimate: 200_000 }, gas: { maxFeeGwei: '50', priorityFeeGwei: '1' } }));
    // 200000 x 50 gwei x 1.2 = 0.012 ETH > the 0.001 floor.
    expect(challengeBondWei(hot)).toBe(parseEther('0.012'));
  });

  it('lists estimated actions, and measured entries override them', () => {
    const est = buildPlan(cfg, slots, gasTable());
    expect(est.estimatedActions).toContain('easAttest');
    const measured = buildPlan(cfg, slots, gasTable({ easAttest: { gas: 180_000n, source: 'measured', note: 'fork' } }));
    expect(measured.estimatedActions).not.toContain('easAttest');
    expect(measured.totalTargetWei).toBeLessThan(est.totalTargetWei);
  });

  it('tops up only the shortfall, so a second run after funding sends nothing', () => {
    const plan = buildPlan(cfg, slots, gasTable());
    const empty = new Map(plan.keys.map((k) => [k.address.toLowerCase(), 0n]));
    const first = topUps(plan, empty);
    expect(first).toHaveLength(plan.keys.filter((k) => k.targetWei > 0n).length);
    const funded = new Map(plan.keys.map((k) => [k.address.toLowerCase(), k.targetWei]));
    expect(topUps(plan, funded)).toEqual([]);
    const k0 = plan.keys.find((k) => k.targetWei > 0n)!;
    const partial = new Map(funded);
    partial.set(k0.address.toLowerCase(), k0.targetWei - 5n);
    expect(topUps(plan, partial)).toEqual([{ address: k0.address, role: k0.role, ordinal: k0.ordinal, amount: 5n }]);
  });

  it('sweeps the balance minus the transfer fee, and skips dust', () => {
    expect(sweepAmount(parseEther('1'), gwei10, 0n)).toBe(parseEther('1') - 21_000n * gwei10);
    expect(sweepAmount(21_000n * gwei10, gwei10, 0n)).toBe(0n);
    expect(sweepAmount(21_000n * gwei10 + 5n, gwei10, 10n)).toBe(0n);
  });
});

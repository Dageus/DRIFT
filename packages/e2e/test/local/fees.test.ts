import { describe, it, expect } from 'vitest';
import { parseUnits, type Provider } from 'ethers';
import { feeReport, percentile, waitForFeesUnderCap } from '../../src/fees.js';

const gwei = (s: string) => parseUnits(s, 'gwei');

describe('fees', () => {
  it('computes nearest-rank percentiles', () => {
    const v = [5n, 1n, 3n, 2n, 4n];
    expect(percentile(v, 50)).toBe(3n);
    expect(percentile(v, 100)).toBe(5n);
    expect(percentile(v, 1)).toBe(1n);
  });

  it('reports how often base fee + priority would exceed each cap, in the order given', () => {
    const h = { fromBlock: 1, toBlock: 4, baseFees: [gwei('1'), gwei('1'), gwei('2'), gwei('5')], medianTips: [] };
    const r = feeReport(h, gwei('0.5'), ['2', '1.5', '10']);
    expect(r.exceeded).toEqual([
      { capGwei: '2', share: 0.5 },
      { capGwei: '1.5', share: 0.5 },
      { capGwei: '10', share: 0 }
    ]);
  });

  it('waits while the base fee is above the cap and proceeds once it drops, never above the cap', async () => {
    const fees = [gwei('5'), gwei('4'), gwei('1')];
    let calls = 0;
    const provider = { getBlock: async () => ({ baseFeePerGas: fees[Math.min(calls++, fees.length - 1)] }) } as unknown as Provider;
    const lines: string[] = [];
    const r = await waitForFeesUnderCap(provider, gwei('3'), gwei('0.2'), { waitMs: 10_000, pollMs: 1, log: (l) => void lines.push(l) });
    expect(r.maxFeePerGas).toBe(gwei('3'));
    expect(r.baseFee).toBe(gwei('1'));
    expect(lines.some((l) => l.includes('waiting'))).toBe(true);
  });

  it('gives up after the wait instead of paying more', async () => {
    const provider = { getBlock: async () => ({ baseFeePerGas: gwei('9') }) } as unknown as Provider;
    await expect(waitForFeesUnderCap(provider, gwei('3'), gwei('0.2'), { waitMs: 20, pollMs: 5 })).rejects.toThrow(/nothing above the cap is ever sent/);
  });
});

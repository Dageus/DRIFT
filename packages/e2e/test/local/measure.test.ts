import { describe, it, expect } from 'vitest';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { measuredTable, writeMeasured, type MeasureResult } from '../../src/measure.js';
import { gasTable, loadMeasured } from '../../src/gas.js';
import { buildPlan } from '../../src/plan.js';
import { parseExperimentConfig } from '../../src/config.js';
import { deriveSlots, slotIndices } from '../../src/keys.js';
import { experimentDeployer, forgeEnv } from '../../src/deploy.js';
import { ANVIL_MNEMONIC, baseConfig } from './fixtures.js';

const result: MeasureResult = {
  forkBlock: 100,
  forkChainId: 11155111n,
  date: '2026-10-01T00:00:00Z',
  samples: [
    { action: 'registerNode', gas: 78_309n, note: '', tx: '0x1' },
    { action: 'registerNode', gas: 78_321n, note: '', tx: '0x2' },
    { action: 'easMultiAttest1', gas: 209_893n, note: '', tx: '0x3' },
    { action: 'easMultiAttest4', gas: 712_940n, note: '', tx: '0x4' },
    { action: 'easMultiAttest12', gas: 2_054_708n, note: '', tx: '0x5' }
  ]
};

describe('measured gas', () => {
  it('keeps the largest sample per action', () => {
    expect(measuredTable(result).registerNode!.gas).toBe('78321');
  });

  it('fits multiAttest so the fit is at or above every measured batch', () => {
    const t = measuredTable(result);
    const base = BigInt(t.easMultiAttestBase!.gas);
    const per = BigInt(t.easMultiAttestPerItem!.gas);
    for (const [k, g] of [[1n, 209_893n], [4n, 712_940n], [12n, 2_054_708n]] as const) expect(base + per * k).toBeGreaterThanOrEqual(g);
    expect(base + per * 12n - 2_054_708n).toBeLessThan(1_000n);
  });

  it('round-trips through the file, and a batched plan prices each multiAttest at its largest size', () => {
    const dir = mkdtempSync(join(tmpdir(), 'drift-measured-'));
    writeMeasured(join(dir, 'gas.json'), result);
    const measured = loadMeasured(join(dir, 'gas.json'));
    expect(measured.registerNode!.source).toBe('measured');
    const cfg = parseExperimentConfig(baseConfig({ attestations: { perNodePerRound: 3, rounds: 2, batch: 2 } }));
    const plan = buildPlan(cfg, deriveSlots(ANVIL_MNEMONIC, slotIndices(cfg)), gasTable(measured));
    const node = plan.keys.find((k) => k.role === 'node')!;
    const multi = node.actions.find((a) => a.action === 'easMultiAttest')!;
    // 3 per round in batches of 2: 2 transactions per round, each priced at k = 2.
    expect(multi.count).toBe(4);
    expect(multi.gasEach).toBe(measured.easMultiAttestBase!.gas + 2n * measured.easMultiAttestPerItem!.gas);
    expect(multi.source).toBe('measured');
    expect(node.actions.some((a) => a.action === 'easAttest')).toBe(false);
  });

  it('rejects a file that is not a measured table', () => {
    const dir = mkdtempSync(join(tmpdir(), 'drift-measured-'));
    writeFileSync(join(dir, 'x.json'), JSON.stringify({ registerNode: { gas: '1' } }));
    expect(() => loadMeasured(join(dir, 'x.json'))).toThrow(/not a measured gas table/);
  });
});

describe('deployment guard', () => {
  it('replaces an inherited MNEMONIC with the experiment mnemonic', () => {
    const before = process.env.MNEMONIC;
    process.env.MNEMONIC = 'the funded account';
    try {
      const env = forgeEnv(ANVIL_MNEMONIC, { X: '1' });
      expect(env.MNEMONIC).toBe(ANVIL_MNEMONIC);
      expect(env.X).toBe('1');
    } finally {
      if (before === undefined) delete process.env.MNEMONIC;
      else process.env.MNEMONIC = before;
    }
  });

  it("refuses when the experiment mnemonic's deployer is not the plan's", () => {
    const cfg = parseExperimentConfig(baseConfig());
    const plan = buildPlan(cfg, deriveSlots(ANVIL_MNEMONIC, slotIndices(cfg)), gasTable());
    expect(experimentDeployer(ANVIL_MNEMONIC, plan)).toBe('0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266');
    const other = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';
    expect(() => experimentDeployer(other, plan)).toThrow(/refusing to deploy/);
  });
});

// Runs analyze on the event logs real daemons write: the operator's daemon anvil e2e (Tier 1 with an
// answered challenge, three Tier 2 owners where round 0 dies and round 1 settles, a watcher that
// catches an omission) is run with DRIFT_E2E_KEEP_EVENTS, then its logs are analysed. Opt-in:
// DRIFT_E2E_ANVIL, and anvil and forge on PATH. Takes about a minute.
import { describe, it, expect, afterAll } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { analyze, loadEvents, renderFiles } from '../../src/analyze/index.js';

const OPERATOR = fileURLToPath(new URL('../../../operator', import.meta.url));
const tools = ['anvil', 'forge'].every((t) => spawnSync('which', [t]).status === 0);
const enabled = !!process.env.DRIFT_E2E_ANVIL && tools;

describe.skipIf(!enabled)('analyze on daemon logs from anvil', () => {
  const keep = mkdtempSync(join(tmpdir(), 'drift-analyze-anvil-'));
  afterAll(() => rmSync(keep, { recursive: true, force: true }));

  it('turns the daemon e2e logs into complete tables', () => {
    const run = spawnSync('npx', ['vitest', 'run', 'daemon-anvil'], {
      cwd: OPERATOR,
      encoding: 'utf8',
      env: { ...process.env, DRIFT_E2E_ANVIL: '1', DRIFT_E2E_KEEP_EVENTS: keep },
      timeout: 600_000
    });
    expect(run.status, run.stdout + run.stderr).toBe(0);
    expect(readdirSync(keep).filter((f) => f.endsWith('.jsonl')).length).toBeGreaterThanOrEqual(5);

    const a = analyze(loadEvents([keep]));
    // Every line is valid; a stopped daemon may leave a tx without receipt, which is reported, not hidden.
    expect(a.issues.filter((i) => i.kind !== 'tx_without_receipt')).toEqual([]);

    const has = (latency: string, tier: string) => a.latency.some((r) => r.latency === latency && r.tier === tier && r.n > 0);
    for (const l of ['o1_wait', 'snapshot', 'compute', 'tree_upload', 'settle_total', 'finalization', 'bond_withdrawal', 'challenge_response']) expect(has(l, 'tier1'), l).toBe(true);
    expect(has('settle_total', 'tier2')).toBe(true);
    expect(has('watch_detection', 'watcher')).toBe(true);

    // The three owners' contexts are one group; its epoch took two rounds, the first dead.
    const t2 = a.counts.groups.filter((g) => g.split('+').length === 3);
    expect(t2).toHaveLength(1);
    expect(a.roundsPerEpoch.find((r) => r.context === t2[0])).toMatchObject({ rounds: 2, dead: 1, settled: true });
    expect(a.disputes.settler.find((d) => d.tier === 'tier1')).toMatchObject({ detected: 1, answered: 1 });
    expect(a.disputes.watcher.divergences).toBe(1);
    expect(a.gas.find((g) => g.action === 'settle.post')!.gas.median).toBeGreaterThan(100_000n);

    const files = renderFiles(a);
    expect(files.get('latency.tex')).toContain('\\bottomrule');
    expect(renderFiles(analyze(loadEvents([keep]))).get('summary.json')).toBe(files.get('summary.json'));
  }, 900_000);
});

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Interface, type Log } from 'ethers';
import { analyze, indexerCheck, loadEvents, renderFiles, type Analysis } from '../../src/analyze/index.js';
import { percentile, summarize, texNumber, weiToEth } from '../../src/analyze/stats.js';
import { main } from '../../src/cli.js';
import { writeFixture } from './analyze-fixtures.js';

const GOLDEN = fileURLToPath(new URL('../golden', import.meta.url));
let work: string;
let a: Analysis;

beforeAll(() => {
  work = mkdtempSync(join(tmpdir(), 'drift-analyze-'));
  writeFixture(join(work, 'logs'));
  a = analyze(loadEvents([join(work, 'logs')]));
});
afterAll(() => rmSync(work, { recursive: true, force: true }));

const lat = (name: string, tier: string, label = '') => a.latency.find((r) => r.latency === name && r.tier === tier && r.label === label);

describe('stats', () => {
  it('uses nearest-rank percentiles', () => {
    const s = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
    expect(percentile(s, 50)).toBe(5);
    expect(percentile(s, 90)).toBe(9);
    expect(percentile(s, 99)).toBe(10);
    expect(percentile([7], 99)).toBe(7);
    expect(summarize([3, 1, 2])).toEqual({ n: 3, median: 2, p90: 3, p99: 3, min: 1, max: 3 });
  });

  it('formats numbers the way the dissertation does', () => {
    expect(texNumber(125375)).toBe('125{,}375');
    expect(texNumber(1234567n)).toBe('1{,}234{,}567');
    expect(texNumber(1234.5, 2)).toBe('1{,}234.50');
    expect(texNumber(999)).toBe('999');
    expect(weiToEth(1_234_567_890_123_456_789n)).toBe('1.234568');
    expect(weiToEth(500n)).toBe('0.000000');
  });
});

describe('data quality', () => {
  it('reports every problem instead of dropping data', () => {
    const kinds = a.issues.map((i) => i.kind).sort();
    expect(kinds).toEqual(['invalid_event', 'invalid_json', 'seq_gap', 'tx_without_receipt']);
    expect(a.issues.find((i) => i.kind === 'seq_gap')).toMatchObject({ file: 'r1.settler.1.jsonl', detail: expect.stringContaining('1 line(s) missing') });
    expect(a.issues.find((i) => i.kind === 'tx_without_receipt')!.detail).toContain('tier2.execute');
    expect(a.inputs.find((f) => f.file === 'r1.watcher.1.jsonl')).toEqual({ file: 'r1.watcher.1.jsonl', lines: 8, valid: 6 });
  });
});

describe('merging processes', () => {
  it('groups the Tier 2 owners by shared proposals and merges repeated milestones', () => {
    expect(a.counts.groups).toEqual(['ownerA+ownerB+ownerC', 'settler', 'watch']);
    // epoch.due x3, round_outcome dead x2, published x2, settle.posted x2 (A, C): 1 + 1 + 1 + 1 extra each.
    expect(a.counts.duplicates).toBe(5);
  });

  it('takes the earliest observation of each milestone (union across owners)', () => {
    // epoch.due by A at 20.0 s; settle.posted first by C at 69.5 s.
    expect(lat('settle_total', 'tier2')).toMatchObject({ n: 1, median: 49.5 });
  });
});

describe('latencies', () => {
  it('computes Tier 1 settlement latencies from the shared definitions', () => {
    expect(lat('o1_wait', 'tier1')).toMatchObject({ n: 2, median: 13, max: 13 });
    expect(lat('settle_total', 'tier1')).toMatchObject({ n: 2 });
    expect(lat('settle_total', 'tier1')!.median).toBeCloseTo(4.1, 9);
    expect(lat('finalization', 'tier1')).toMatchObject({ n: 2, median: 110 });
    expect(lat('bond_withdrawal', 'tier1')).toMatchObject({ n: 2, median: 1 });
    expect(lat('compute', 'tier1')).toMatchObject({ n: 2, median: 0.2 });
    expect(lat('tx_inclusion', 'tier1', 'settle.post')).toMatchObject({ n: 2 });
    expect(lat('tx_inclusion', 'tier1', 'settle.post')!.median).toBeCloseTo(1.6, 9);
  });

  it('computes dispute and watcher latencies', () => {
    expect(lat('challenge_detection', 'tier1')).toMatchObject({ n: 1, median: 2 });
    expect(lat('challenge_response', 'tier1')).toMatchObject({ n: 1, median: 1 });
    expect(lat('watch_detection', 'watcher')).toMatchObject({ n: 1, median: 22 });
    expect(a.disputes.settler).toEqual([{ tier: 'tier1', detected: 1, answered: 1, unanswerable: 0, expired: 0, claimed: 0 }]);
    expect(a.disputes.watcher).toMatchObject({ divergences: 1, omittedPairs: 1, challengesOpened: 1 });
  });
});

describe('Tier 2 rounds', () => {
  it('counts rounds per epoch and their outcomes', () => {
    expect(a.rounds.map((r) => [r.round, r.outcome, r.commits, r.reveals, r.signatures, r.executed])).toEqual([
      ['0', 'dead', 1, 0, 0, false],
      ['1', 'agreed', 3, 3, 2, true]
    ]);
    expect(a.roundsPerEpoch).toEqual([{ run: 'r1', context: 'ownerA+ownerB+ownerC', epoch: '1', rounds: 2, dead: 1, settled: true }]);
  });

  it('measures each step from its window', () => {
    const step = (s: string) => a.tier2Steps.find((x) => x.step === s)!.summary;
    expect(step('commit')).toMatchObject({ n: 4, min: 1 });
    expect(step('reveal')).toMatchObject({ n: 3, min: 1, max: 2 });
    expect(step('publish')).toMatchObject({ n: 1, median: 1 });
    expect(step('sign')).toMatchObject({ n: 2, min: 1, max: 1.5 });
    expect(step('execute').n).toBe(1);
    expect(step('execute').median).toBeCloseTo(4.1, 9);
  });
});

describe('gas and cost', () => {
  it('summarises gas per action and cost per epoch from receipts', () => {
    const post = a.gas.find((g) => g.tier === 'tier1' && g.action === 'settle.post')!;
    expect([post.gas.n, post.gas.median, post.gas.max, post.reverted]).toEqual([2, 150_000n, 152_000n, 0]);
    // A reverted execute (owners racing) is counted apart, but its fee is part of the total.
    const exec = a.gas.find((g) => g.action === 'tier2.execute')!;
    expect([exec.gas.n, exec.gas.median, exec.reverted, exec.revertedGas]).toEqual([1, 255_000n, 1, 52_000n]);
    expect(exec.totalFeeWei).toBe((255_000n + 52_000n) * 1_200_000_000n);
    const t1 = a.tierCosts.find((t) => t.tier === 'tier1')!;
    expect(t1.epochs).toBe(2);
    expect(t1.totalFeeWei).toBe((150_000n + 61_000n + 50_000n + 152_000n + 50_000n) * 1_200_000_000n);
    const tl = a.timeline.find((t) => t.tier === 'tier1' && t.epoch === '1')!;
    expect(tl).toMatchObject({ tE: 1000, o1Wait: 13, finalization: 110, txs: 3 });
    expect(tl.settleTotal).toBeCloseTo(4.1, 9);
    expect(a.timeline.find((t) => t.tier === 'tier2')).toMatchObject({ rounds: 2, txs: 2, settleTotal: 49.5 });
  });
});

describe('outputs', () => {
  it('are byte-identical across runs of the same input', () => {
    const one = renderFiles(analyze(loadEvents([join(work, 'logs')])));
    const two = renderFiles(analyze(loadEvents([join(work, 'logs')])));
    expect([...one.keys()]).toEqual([...two.keys()]);
    for (const [name, body] of one) expect(two.get(name), name).toBe(body);
  });

  it('match the golden files (UPDATE_GOLDEN=1 to regenerate after a deliberate change)', () => {
    const files = renderFiles(a);
    for (const name of ['latency.tex', 'gas.csv']) {
      const path = join(GOLDEN, name);
      if (process.env.UPDATE_GOLDEN) writeFileSync(path, files.get(name)!);
      expect(files.get(name), name).toBe(readFileSync(path, 'utf8'));
    }
  });

  it('writes booktabs LaTeX with dissertation number formatting', () => {
    const gas = renderFiles(a).get('gas.tex')!;
    expect(gas).toContain('\\toprule');
    expect(gas).toContain('\\bottomrule');
    expect(gas).toContain('150{,}000');
    expect(gas).toContain('\\texttt{settle.post}');
  });

  it('runs from the CLI', async () => {
    const out = join(work, 'out');
    const log: string[] = [];
    expect(await main(['analyze', join(work, 'logs'), '--out', out], {}, (l) => log.push(l))).toBe(0);
    expect(readdirSync(out)).toEqual(expect.arrayContaining(['latency.csv', 'latency.tex', 'gas.tex', 'tier2.tex', 'disputes.tex', 'timeline.csv', 'quality.csv', 'summary.json']));
    expect(existsSync(join(out, 'indexer.csv'))).toBe(false);
    expect(log.join('\n')).toContain('4 issue(s)');
    expect(JSON.parse(readFileSync(join(out, 'summary.json'), 'utf8')).method.percentiles).toContain('nearest-rank');
  });
});

describe('indexer check', () => {
  const eas = new Interface([
    'event Attested(address indexed recipient, address indexed attester, bytes32 uid, bytes32 indexed schemaUID)',
    'event Revoked(address indexed recipient, address indexed attester, bytes32 uid, bytes32 indexed schemaUID)'
  ]);
  const SCHEMA = '0x' + '5c'.repeat(32);
  const EAS = '0x' + 'ea'.repeat(20);

  it('compares each snapshot with Attested minus Revoked up to t_E', async () => {
    // 43 attestations before t_E=1000 (block 1..43 at time 900+i), one revoked before t_E, one after.
    const logsOf = (name: 'Attested' | 'Revoked', blocks: number[]): Log[] =>
      blocks.map((b) => {
        const { data, topics } = eas.encodeEventLog(name, ['0x' + '01'.repeat(20), '0x' + '02'.repeat(20), '0x' + b.toString(16).padStart(64, '0'), SCHEMA]);
        return { address: EAS, data, topics, blockNumber: b } as unknown as Log;
      });
    const attested = logsOf('Attested', Array.from({ length: 43 }, (_, i) => i + 1));
    const revoked = logsOf('Revoked', [5, 2000]).map((l, i) => ({ ...l, blockNumber: i === 0 ? 50 : 2000 }) as unknown as Log);
    const provider = {
      getBlock: async (n: number | string) => (n === 'latest' ? { number: 3000, timestamp: 5000 } : { number: n, timestamp: Number(n) === 50 ? 950 : Number(n) === 2000 ? 2500 : 900 + Number(n) }),
      getLogs: async (f: { topics: (string | null)[]; fromBlock: number; toBlock: number }) => {
        const all = f.topics[0] === eas.getEvent('Attested')!.topicHash ? attested : revoked;
        return all.filter((l) => l.blockNumber >= f.fromBlock && l.blockNumber <= f.toBlock);
      }
    };
    const rows = await indexerCheck(a.events, { provider: provider as never, eas: EAS, schemaUID: SCHEMA, fromBlock: 0, chunk: 1000 });
    expect(rows.map((r) => [r.tier, r.epoch, r.tE, r.snapshot, r.chain, r.match])).toEqual([
      ['tier1', '1', 1000, 42, 42, true],
      ['tier1', '2', 2000, 42, 42, true]
    ]);
    const files = renderFiles(a, rows);
    expect(files.get('indexer.tex')).toContain('Mismatching & 0');
  });
});

import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { id, Wallet } from 'ethers';
import { pino } from 'pino';
import { buildEpochTree } from '@drift-network/sdk/merkle';
import { EVENT_TYPES, validateEvent, type RecorderEvent } from '../../src/recorder/events.js';
import { JsonlSink, MemorySink, Recorder, type EventSink } from '../../src/recorder/recorder.js';
import { MetricsSink } from '../../src/recorder/metrics.js';
import { runTier1, type Tier1JobDeps } from '../../src/daemon/jobs/tier1.js';
import { runTier2Owner, type Tier2Steps } from '../../src/daemon/jobs/tier2.js';
import { createWatcher } from '../../src/daemon/jobs/watcher.js';
import { newContextStatus } from '../../src/daemon/status.js';
import { LocalEpochEngine, DEFAULT_EIGENTRUST_PARAMS } from '@drift-network/sdk/engines';
import type { RoundStatus, StepStatus } from '../../src/pipeline/tier2.js';
import { FakeActions, FakeChain, MemoryStore } from './daemon-fakes.js';

const CTX = id('recorder.test').toLowerCase();
const ROLE = id('MEMBER').toLowerCase();
const SETTLER = Wallet.createRandom().address;
const [A, B] = [1, 2].map(() => Wallet.createRandom().address.toLowerCase()) as [string, string];
const log = pino({ level: 'silent' });
const treeFor = (epoch: bigint, nodes = [A, B]) => buildEpochTree(CTX, epoch, nodes.map((node, i) => ({ node, role: ROLE, score: BigInt(10 + i) })));

const base = (over: Partial<RecorderEvent> = {}): RecorderEvent =>
  ({ v: 1, type: 'epoch.due', runId: 'r1', process: 'p', seq: 1, wallMs: 1000, context: 'c', tier: 'tier1', epoch: '1', ...over });

describe('event schema', () => {
  it('accepts well-formed events and reports every problem with bad ones', () => {
    expect(validateEvent(base({ chainTime: 1100 }))).toEqual([]);
    expect(validateEvent(base({ type: 'tx.mined', action: 'settle.post', tx: { hash: '0x1', from: '0x2', gasUsed: '1', effectiveGasPrice: '2', feeWei: '2', status: 1, block: 3 } }))).toEqual([]);
    expect(validateEvent(base({ v: 2 as never }))).toContain('unsupported schema version 2');
    expect(validateEvent(base({ type: 'nope' as never }))).toContain('unknown event type nope');
    expect(validateEvent(base({ type: 'snapshot.done' }))).toEqual(
      expect.arrayContaining(['snapshot.done: missing records', 'snapshot.done: missing durationMs'])
    );
    expect(validateEvent(base({ extra: 1 }))).toContain('epoch.due: unexpected field extra');
    expect(validateEvent(base({ type: 'tx.mined', action: 'x', tx: { hash: '0x1' } }))).toContain('tx.mined: missing tx.gasUsed');
    expect(validateEvent(base({ epoch: 1 as never, seq: 0 }))).toEqual(
      expect.arrayContaining(['epoch must be a decimal string', 'seq must be a positive integer'])
    );
    expect(EVENT_TYPES).toContain('client.claim');
  });
});

describe('Recorder', () => {
  let dir: string | undefined;
  afterEach(() => dir && rmSync(dir, { recursive: true, force: true }));

  it('appends valid, sequenced JSON lines to a per-process file', () => {
    dir = mkdtempSync(join(tmpdir(), 'drift-rec-'));
    const sink = new JsonlSink(dir, 'run-1', 'settler/a');
    const r = new Recorder([sink], 'run-1', 'settler/a');
    const s = r.scope({ context: 'uni', tier: 'tier1' });
    s.emit('epoch.due', { epoch: 3n, chainTime: 1100 });
    s.emit('snapshot.done', { epoch: 3n, records: 4, rawRecords: 5, members: 3, durationMs: 12.5 });
    s.once('k', 'epoch.finalized', { epoch: 3n });
    s.once('k', 'epoch.finalized', { epoch: 3n });
    sink.close();

    expect(readdirSync(dir)).toEqual([`run-1.settler_a.${process.pid}.jsonl`]);
    const lines = readFileSync(sink.path, 'utf8').trim().split('\n').map((l) => JSON.parse(l) as RecorderEvent);
    expect(lines.map((e) => [e.seq, e.type, e.epoch])).toEqual([
      [1, 'epoch.due', '3'],
      [2, 'snapshot.done', '3'],
      [3, 'epoch.finalized', '3']
    ]);
    for (const e of lines) expect(validateEvent(e)).toEqual([]);
  });

  it('keeps recording to healthy sinks when one fails, and never throws', () => {
    const memory = new MemorySink();
    const broken: EventSink = { write: () => { throw new Error('disk full'); } };
    const r = new Recorder([broken, memory], 'r', 'p', log);
    const s = r.scope({ tier: 'tier1' });
    expect(() => s.emit('epoch.due', { epoch: 1n })).not.toThrow();
    s.emit('epoch.finalized', { epoch: 1n });
    expect(memory.events.map((e) => e.type)).toEqual(['epoch.due', 'epoch.finalized']);
  });
});

describe('MetricsSink', () => {
  it('derives latency histograms and gas counters from the events', () => {
    const m = new MetricsSink();
    const ev = (over: Partial<RecorderEvent>) => m.write(base(over));
    ev({ type: 'epoch.due', chainTime: 1100, wallMs: 0 });
    ev({ type: 'o1.checked', synced: false, boundary: '1100', chainTime: 1090, wallMs: 1000 });
    ev({ type: 'o1.checked', synced: true, boundary: '1100', chainTime: 1124, wallMs: 2000 });
    ev({ type: 'tx.sent', action: 'settle.post', hash: '0xAB', from: '0x1', wallMs: 3000 });
    ev({ type: 'tx.mined', action: 'settle.post', tx: { hash: '0xab', from: '0x1', gasUsed: '125375', effectiveGasPrice: '2', feeWei: '250750', status: 1, block: 9 }, wallMs: 15_000, chainTime: 1140 });
    ev({ type: 'settle.posted', root: '0x01', wallMs: 15_500 });
    const text = m.render();
    expect(text).toContain('drift_o1_wait_seconds_sum{tier="tier1"} 24');
    expect(text).toContain('drift_tx_inclusion_seconds_sum{action="settle.post",tier="tier1"} 12');
    expect(text).toContain('drift_settle_total_seconds_sum{tier="tier1"} 15.5');
    expect(text).toContain('drift_gas_used_total{action="settle.post",tier="tier1"} 125375');
    expect(text).toContain('drift_fee_wei_total{action="settle.post",tier="tier1"} 250750');
    expect(text).toContain('drift_o1_wait_seconds_count{tier="tier1"} 1');
  });
});

// INSTRUMENTED JOBS ===========================================================

const recorded = () => {
  const memory = new MemorySink();
  return { memory, recorder: new Recorder([memory], 'r', 'p') };
};
const types = (m: MemorySink) => m.events.map((e) => e.type);

describe('instrumented jobs', () => {
  it('Tier 1: due, settled, posted, challenge detected and answered, finalized, bond withdrawn', async () => {
    const { memory, recorder } = recorded();
    const chain = new FakeChain(CTX, SETTLER);
    const actions = new FakeActions();
    const store = new MemoryStore();
    const deps: Tier1JobDeps = {
      chain,
      actions,
      store,
      settler: SETTLER,
      bondScanDepth: 8,
      log,
      rec: recorder.scope({ context: 'uni', tier: 'tier1' }),
      settle: async (e) => {
        const tree = treeFor(e);
        await store.saveTree(CTX, e, tree);
        chain.post(e, tree.root, chain.now);
        return { root: tree.root, treeURI: 'ipfs://t', txHash: '0xtx' };
      }
    };
    const status = newContextStatus('uni', '0x' + 'c1'.repeat(20), ['tier1']);
    chain.now = 1101n;
    await runTier1(deps, status);
    chain.open.set(1n, 1n);
    chain.chs.push({ epoch: 1n, node: A, role: ROLE, openedAt: 1102n, deadline: 1112n, resolved: false });
    chain.now = 1104n;
    await runTier1(deps, status);
    chain.chs[0]!.resolved = true;
    chain.open.set(1n, 0n);
    chain.now = 1120n;
    await runTier1(deps, status);
    await runTier1(deps, status);

    expect(types(memory)).toEqual([
      'epoch.due',
      'settle.posted',
      'challenge.detected',
      'challenge.answered',
      'epoch.posted',
      'epoch.finalized',
      'bond.withdrawn'
    ]);
    for (const e of memory.events) expect(validateEvent(e), JSON.stringify(e)).toEqual([]);
    expect(memory.events.find((e) => e.type === 'epoch.due')).toMatchObject({ epoch: '1', chainTime: 1100, tier: 'tier1', context: 'uni' });
    expect(memory.events.find((e) => e.type === 'challenge.detected')).toMatchObject({ openedAt: '1102', chainTime: 1104 });
  });

  it('a failing recorder does not change what the Tier 1 job does', async () => {
    const broken: EventSink = { write: () => { throw new Error('boom'); } };
    const chain = new FakeChain(CTX, SETTLER);
    const settled: bigint[] = [];
    const deps: Tier1JobDeps = {
      chain,
      actions: new FakeActions(),
      store: new MemoryStore(),
      settler: SETTLER,
      bondScanDepth: 8,
      log,
      rec: new Recorder([broken], 'r', 'p', log).scope({ tier: 'tier1' }),
      settle: async (e) => {
        settled.push(e);
        chain.post(e, treeFor(e).root, chain.now);
        return { root: treeFor(e).root, treeURI: 'ipfs://t', txHash: '0xtx' };
      }
    };
    const status = newContextStatus('uni', '0x' + 'c1'.repeat(20), ['tier1']);
    chain.now = 1101n;
    await runTier1(deps, status);
    expect(settled).toEqual([1n]);
    expect(status.lastError).toBeUndefined();
    expect(status.lastSettled).toMatchObject({ epoch: '1' });
  });

  it('Tier 2: due, a dead round recorded once, the next round driven', async () => {
    const { memory, recorder } = recorded();
    const chain = new FakeChain(CTX, SETTLER);
    const pid = (r: bigint) => id(`p${r}`);
    const rounds = [pid(0n)];
    const steps: Tier2Steps = {
      currentRound: async () => ({ round: BigInt(rounds.length - 1), proposalId: rounds[rounds.length - 1]! }),
      roundStatus: async (p: string): Promise<RoundStatus> => (p === pid(0n) ? 'dead' : 'open'),
      propose: async (_e, r) => void rounds.push(pid(r)),
      commit: async (): Promise<StepStatus> => 'waiting',
      reveal: async (): Promise<StepStatus> => 'waiting',
      publish: async (): Promise<StepStatus> => 'waiting',
      sign: async (): Promise<StepStatus> => 'waiting',
      execute: async (): Promise<StepStatus> => 'waiting'
    };
    const deps = { chain, actions: new FakeActions(), store: new MemoryStore(), safe: SETTLER, steps, maxRounds: 3, bondScanDepth: 8, log, rec: recorder.scope({ context: 'uni', tier: 'tier2' }) };
    const status = newContextStatus('uni', '0x' + 'c1'.repeat(20), ['tier2-owner']);
    chain.now = 1101n;
    await runTier2Owner(deps, status);
    await runTier2Owner(deps, status);
    expect(types(memory)).toEqual(['epoch.due', 'tier2.round_outcome']);
    expect(memory.events[1]).toMatchObject({ epoch: '1', round: '0', outcome: 'dead', proposalId: pid(0n), tier: 'tier2' });
    for (const e of memory.events) expect(validateEvent(e)).toEqual([]);
  });

  it('watcher: root seen, recomputed, divergence, challenge opened', async () => {
    const { memory, recorder } = recorded();
    const chain = new FakeChain(CTX, SETTLER);
    const posted = treeFor(1n, [A]);
    chain.post(1n, posted.root, 1101n);
    chain.now = 1103n;
    const ours = await new LocalEpochEngine().computeEpoch({
      contextUID: CTX,
      epoch: 1n,
      tE: 1100n,
      schemaUID: id('s'),
      schemaDefinition: 'uint256 score',
      params: DEFAULT_EIGENTRUST_PARAMS,
      defaultWeight: 1n,
      records: [],
      members: [A, B].map((node) => ({ node, role: ROLE })),
      pretrust: []
    });
    const actions = new FakeActions();
    const run = createWatcher({
      chain,
      actions,
      compute: async () => ours,
      fetchPosted: async () => posted,
      challenge: true,
      challenger: B,
      log,
      rec: recorder.scope({ context: 'uni', tier: 'watcher' })
    });
    const status = newContextStatus('uni', '0x' + 'c1'.repeat(20), ['watcher']);
    await run(status);
    await run(status);
    expect(types(memory)).toEqual(['watch.root_seen', 'watch.recomputed', 'watch.divergence', 'watch.challenge_opened']);
    expect(memory.events[2]).toMatchObject({ omitted: 1, postedAt: '1101', chainTime: 1103 });
    for (const e of memory.events) expect(validateEvent(e)).toEqual([]);
  });
});

describe('API loading', () => {
  it('nothing outside src/api imports Fastify or the API module statically', async () => {
    const { readdirSync: list, readFileSync: read, statSync } = await import('node:fs');
    const walk = (d: string): string[] =>
      list(d).flatMap((n) => {
        const p = join(d, n);
        return statSync(p).isDirectory() ? (n === 'api' ? [] : walk(p)) : p.endsWith('.ts') ? [p] : [];
      });
    const src = join(import.meta.dirname, '../../src');
    const offenders = walk(src).filter((f) =>
      read(f, 'utf8')
        .split('\n')
        .some((l) => /^import (?!type)/.test(l) && /from '(fastify|[./]+api\/[^']*)'/.test(l))
    );
    expect(offenders).toEqual([]);
  });
});

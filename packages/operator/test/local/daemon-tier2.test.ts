import { describe, it, expect } from 'vitest';
import { id, Wallet } from 'ethers';
import { pino } from 'pino';
import { DriftValidationError } from '@drift-network/sdk';
import { buildEpochTree } from '@drift-network/sdk/merkle';
import type { RoundStatus, StepStatus } from '../../src/pipeline/tier2.js';
import { runTier2Owner, type Tier2Steps } from '../../src/daemon/jobs/tier2.js';
import { newContextStatus } from '../../src/daemon/status.js';
import { FakeActions, FakeChain, MemoryStore } from './daemon-fakes.js';

const CTX = id('daemon.tier2').toLowerCase();
const ROLE = id('MEMBER').toLowerCase();
const SAFE = Wallet.createRandom().address;
const A = Wallet.createRandom().address.toLowerCase();
const log = pino({ level: 'silent' });

type Step = 'commit' | 'reveal' | 'publish' | 'sign' | 'execute';

/** Steps over an in-memory relay; `results` scripts each step's outcome, `states` each round's. */
class FakeSteps implements Tier2Steps {
  rounds: string[] = []; // proposalIds by round, for one epoch
  states = new Map<string, RoundStatus>();
  proposeCalls: bigint[] = [];
  calls: { step: Step; proposalId: string }[] = [];
  results: Partial<Record<Step, StepStatus | Error>> = {};
  raceOnPropose = false;
  synced?: (epoch: bigint) => Promise<boolean>;
  withdrawDelay?: (epoch: bigint) => Promise<bigint>;
  pid = (round: bigint) => id(`proposal-${round}`);
  async currentRound() {
    const r = this.rounds.length - 1;
    return r < 0 ? null : { round: BigInt(r), proposalId: this.rounds[r]! };
  }
  async roundStatus(proposalId: string) { return this.states.get(proposalId) ?? 'open'; }
  async propose(_epoch: bigint, round: bigint) {
    this.proposeCalls.push(round);
    if (BigInt(this.rounds.length) === round) this.rounds.push(this.pid(round));
    if (this.raceOnPropose) throw new DriftValidationError('relay already holds a different proposal');
  }
  private run(step: Step, proposalId: string): Promise<StepStatus> {
    this.calls.push({ step, proposalId });
    const r = this.results[step] ?? 'waiting';
    return r instanceof Error ? Promise.reject(r) : Promise.resolve(r);
  }
  commit(p: string) { return this.run('commit', p); }
  reveal(p: string) { return this.run('reveal', p); }
  publish(p: string) { return this.run('publish', p); }
  sign(p: string) { return this.run('sign', p); }
  execute(p: string) { return this.run('execute', p); }
}

function setup() {
  const chain = new FakeChain(CTX, SAFE);
  const actions = new FakeActions();
  const store = new MemoryStore();
  const steps = new FakeSteps();
  const status = newContextStatus('ctx', '0x' + 'c1'.repeat(20), ['tier2-owner']);
  const deps = { chain, actions, store, safe: SAFE, steps, bondScanDepth: 64, maxRounds: 3, log };
  return { chain, actions, store, steps, status, deps };
}

describe('runTier2Owner', () => {
  it('does nothing before the boundary', async () => {
    const t = setup();
    t.chain.now = 1050n;
    await runTier2Owner(t.deps, t.status);
    expect(t.steps.proposeCalls).toEqual([]);
    expect(t.status.nextAction).toMatch(/after its boundary/);
  });

  it('proposes once, then drives every step on each tick', async () => {
    const t = setup();
    t.chain.now = 1101n;
    await runTier2Owner(t.deps, t.status);
    expect(t.steps.proposeCalls).toEqual([0n]);
    expect(t.steps.calls.map((c) => c.step)).toEqual(['commit', 'reveal', 'publish', 'sign', 'execute']);
    expect(t.status.tier2).toMatchObject({ epoch: '1', round: '0', state: 'open', steps: { propose: 'done', commit: 'waiting' } });
    expect(t.status.nextAction).toBe('epoch 1 round 0: waiting to commit');

    t.steps.results = { commit: 'already-done', reveal: 'done', publish: 'done', sign: 'done', execute: 'done' };
    await runTier2Owner(t.deps, t.status);
    expect(t.steps.proposeCalls).toEqual([0n]);
    expect(t.status.tier2!.steps.propose).toBe('already-done');
    expect(t.status.nextAction).toBe('epoch 1 settled through the Safe');
  });

  it('proposes round 0 only once the head has passed the boundary (O1)', async () => {
    const t = setup();
    let synced = false;
    t.steps.synced = async () => synced;
    t.chain.now = 1101n;
    await runTier2Owner(t.deps, t.status);
    expect(t.steps.proposeCalls).toEqual([]);
    expect(t.steps.calls).toEqual([]);
    expect(t.status.nextAction).toMatch(/waiting for the head to pass its boundary \(O1\)/);

    synced = true;
    await runTier2Owner(t.deps, t.status);
    expect(t.steps.proposeCalls).toEqual([0n]);
  });

  it('defers its bond withdrawal by its rank, so normally one owner sends it', async () => {
    const t = setup();
    t.chain.post(1n, '0x' + '11'.repeat(32), 1100n);
    const disputeEnd = 1100n + (await t.chain.state()).disputeWindow;
    t.steps.withdrawDelay = async () => 60n;
    t.chain.now = disputeEnd + 1n;
    await runTier2Owner(t.deps, t.status);
    expect(t.actions.withdrawn).toEqual([]);
    t.chain.now = disputeEnd + 61n;
    await runTier2Owner(t.deps, t.status);
    expect(t.actions.withdrawn).toEqual([1n]);
  });

  it('follows the stored proposal when another owner proposed first', async () => {
    const t = setup();
    t.steps.raceOnPropose = true;
    t.chain.now = 1101n;
    await runTier2Owner(t.deps, t.status);
    expect(t.status.tier2!.steps.propose).toBe('already-done');
    expect(t.status.lastError).toBeUndefined();
  });

  it('reports a step that cannot succeed and still runs the rest', async () => {
    const t = setup();
    t.chain.now = 1101n;
    t.steps.rounds.push(t.steps.pid(0n));
    t.steps.results = {
      commit: 'already-done',
      reveal: 'already-done',
      publish: new DriftValidationError('DRIFT SDK: this owner computed a different root than the agreed one.'),
      sign: 'waiting'
    };
    await runTier2Owner(t.deps, t.status);
    expect(t.steps.calls.map((c) => c.step)).toEqual(['commit', 'reveal', 'publish', 'sign', 'execute']);
    expect(t.status.tier2!.steps.publish).toBe('failed');
    expect(t.status.alerts.find((a) => a.level === 'error')!.message).toMatch(/publish for epoch 1 round 0: .*different root/);
  });

  it('refuses to settle when the Safe is not the trusted settler, but still answers challenges', async () => {
    const t = setup();
    t.chain.s.trustedSettler = Wallet.createRandom().address;
    const tree = buildEpochTree(CTX, 1n, [{ node: A, role: ROLE, score: 9n }]);
    await t.store.saveTree(CTX, 1n, tree);
    t.chain.post(1n, tree.root, 1101n);
    t.chain.open.set(1n, 1n);
    t.chain.chs.push({ epoch: 1n, node: A, role: ROLE, openedAt: 1102n, deadline: 1112n, resolved: false });
    t.chain.now = 1105n; // inside the response window
    t.chain.s.epochLength = 1n; // so the next boundary has passed and the job would otherwise settle
    await runTier2Owner(t.deps, t.status);
    expect(t.steps.proposeCalls).toEqual([]);
    expect(t.actions.responses).toHaveLength(1);
    expect(t.status.alerts.some((a) => /not the client's trustedSettler/.test(a.message))).toBe(true);
  });

  it('replaces a dead round with the next one and drives the new round', async () => {
    const t = setup();
    t.chain.now = 1101n;
    t.steps.rounds.push(t.steps.pid(0n));
    t.steps.states.set(t.steps.pid(0n), 'dead');
    await runTier2Owner(t.deps, t.status);
    expect(t.steps.proposeCalls).toEqual([1n]);
    expect(t.status.tier2).toMatchObject({ round: '1', proposalId: t.steps.pid(1n), steps: { propose: 'done' } });
    expect(new Set(t.steps.calls.map((c) => c.proposalId))).toEqual(new Set([t.steps.pid(1n)]));
    expect(t.status.alerts.some((a) => a.level === 'warn' && /round 0 reached no quorum/.test(a.message))).toBe(true);
  });

  it('keeps driving a round that is open or agreed, however slow', async () => {
    const t = setup();
    t.chain.now = 1101n;
    t.steps.rounds.push(t.steps.pid(0n));
    for (const state of ['open', 'agreed'] as const) {
      t.steps.states.set(t.steps.pid(0n), state);
      await runTier2Owner(t.deps, t.status);
      expect(t.steps.proposeCalls).toEqual([]);
      expect(t.status.tier2).toMatchObject({ round: '0', state });
    }
  });

  it('stops for an operator decision once maxRounds rounds are dead', async () => {
    const t = setup();
    t.chain.now = 1101n;
    for (const r of [0n, 1n, 2n]) {
      t.steps.rounds.push(t.steps.pid(r));
      t.steps.states.set(t.steps.pid(r), 'dead');
    }
    await runTier2Owner(t.deps, t.status);
    expect(t.steps.proposeCalls).toEqual([]);
    expect(t.steps.calls).toEqual([]);
    expect(t.status.tier2).toMatchObject({ round: '2', state: 'dead' });
    expect(t.status.alerts.find((a) => a.level === 'error')!.message).toMatch(/maxRounds \(3\) is reached; it needs an operator decision/);
  });
});

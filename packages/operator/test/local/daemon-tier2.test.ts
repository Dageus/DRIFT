import { describe, it, expect } from 'vitest';
import { id, Wallet } from 'ethers';
import { pino } from 'pino';
import { DriftValidationError } from '@drift-network/sdk';
import { buildEpochTree } from '@drift-network/sdk/merkle';
import type { StepStatus } from '../../src/pipeline/tier2.js';
import { runTier2Owner, type Tier2Steps } from '../../src/daemon/jobs/tier2.js';
import { newContextStatus } from '../../src/daemon/status.js';
import { FakeActions, FakeChain, MemoryStore } from './daemon-fakes.js';

const CTX = id('daemon.tier2').toLowerCase();
const ROLE = id('MEMBER').toLowerCase();
const SAFE = Wallet.createRandom().address;
const A = Wallet.createRandom().address.toLowerCase();
const log = pino({ level: 'silent' });

type Step = 'commit' | 'reveal' | 'publish' | 'sign' | 'execute';

/** Steps backed by a shared in-memory relay; `results` scripts each step's outcome. */
class FakeSteps implements Tier2Steps {
  proposals = new Set<string>();
  proposeCalls = 0;
  calls: Step[] = [];
  results: Partial<Record<Step, StepStatus | Error>> = {};
  raceOnPropose = false;
  async proposalId(epoch: bigint) { return id(`proposal-${epoch}`); }
  async hasProposal(pid: string) { return this.proposals.has(pid); }
  async propose(epoch: bigint) {
    this.proposeCalls++;
    this.proposals.add(await this.proposalId(epoch));
    if (this.raceOnPropose) throw new DriftValidationError('relay already holds a different proposal');
  }
  private run(step: Step): Promise<StepStatus> {
    this.calls.push(step);
    const r = this.results[step] ?? 'waiting';
    return r instanceof Error ? Promise.reject(r) : Promise.resolve(r);
  }
  commit() { return this.run('commit'); }
  reveal() { return this.run('reveal'); }
  publish() { return this.run('publish'); }
  sign() { return this.run('sign'); }
  execute() { return this.run('execute'); }
}

function setup() {
  const chain = new FakeChain(CTX, SAFE);
  const actions = new FakeActions();
  const store = new MemoryStore();
  const steps = new FakeSteps();
  const status = newContextStatus('ctx', '0x' + 'c1'.repeat(20), ['tier2-owner']);
  const deps = { chain, actions, store, safe: SAFE, steps, bondScanDepth: 64, log };
  return { chain, actions, store, steps, status, deps };
}

describe('runTier2Owner', () => {
  it('does nothing before the boundary', async () => {
    const t = setup();
    t.chain.now = 1050n;
    await runTier2Owner(t.deps, t.status);
    expect(t.steps.proposeCalls).toBe(0);
    expect(t.status.nextAction).toMatch(/after its boundary/);
  });

  it('proposes once, then drives every step on each tick', async () => {
    const t = setup();
    t.chain.now = 1101n;
    await runTier2Owner(t.deps, t.status);
    expect(t.steps.proposeCalls).toBe(1);
    expect(t.steps.calls).toEqual(['commit', 'reveal', 'publish', 'sign', 'execute']);
    expect(t.status.tier2).toMatchObject({ epoch: '1', steps: { propose: 'done', commit: 'waiting' } });
    expect(t.status.nextAction).toBe('epoch 1: waiting to commit');

    t.steps.results = { commit: 'already-done', reveal: 'done', publish: 'done', sign: 'done', execute: 'done' };
    await runTier2Owner(t.deps, t.status);
    expect(t.steps.proposeCalls).toBe(1);
    expect(t.status.tier2!.steps.propose).toBe('already-done');
    expect(t.status.nextAction).toBe('epoch 1 settled through the Safe');
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
    t.steps.proposals.add(id('proposal-1'));
    t.steps.results = {
      commit: 'already-done',
      reveal: 'already-done',
      publish: new DriftValidationError('DRIFT SDK: no root reached the Safe threshold of valid reveals for x.'),
      sign: 'waiting'
    };
    await runTier2Owner(t.deps, t.status);
    expect(t.steps.calls).toEqual(['commit', 'reveal', 'publish', 'sign', 'execute']);
    expect(t.status.tier2!.steps.publish).toBe('failed');
    expect(t.status.alerts.find((a) => a.level === 'error')!.message).toMatch(/cannot be retried while the Safe nonce is unchanged/);
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
    expect(t.steps.proposeCalls).toBe(0);
    expect(t.actions.responses).toHaveLength(1);
    expect(t.status.alerts.some((a) => /not the client's trustedSettler/.test(a.message))).toBe(true);
  });
});

import { describe, it, expect } from 'vitest';
import { id, Wallet } from 'ethers';
import { pino } from 'pino';
import { StandardMerkleTree } from '@openzeppelin/merkle-tree';
import { DriftContractRevertError, DriftNotFoundError, EpochNotSynchronizedError } from '@drift-network/sdk';
import { buildEpochTree, EPOCH_LEAF_ENCODING, type EpochTree, type IMerkleStore } from '@drift-network/sdk/merkle';
import type { ChallengeView, ClientActions, ClientChain, ClientState } from '../../src/daemon/chain.js';
import { runTier1, type Tier1JobDeps } from '../../src/daemon/jobs/tier1.js';
import { newContextStatus } from '../../src/daemon/status.js';

const CTX = id('daemon.tier1').toLowerCase();
const ROLE = id('MEMBER').toLowerCase();
const SETTLER = Wallet.createRandom().address;
const [A, B, OMITTED] = [1, 2, 3].map(() => Wallet.createRandom().address.toLowerCase()) as [string, string, string];
const ZERO = '0x' + '00'.repeat(32);
const log = pino({ level: 'silent' });
const revert = (name: string) => new DriftContractRevertError(name, name, {});

/** A governance client held in memory; times are chain seconds. */
class FakeChain implements ClientChain {
  now = 0n;
  s: ClientState = {
    contextUID: CTX,
    currentEpoch: 0n,
    epochLength: 100n,
    epochAnchorTimestamp: 1000n,
    disputeWindow: 10n,
    responseWindow: 10n,
    trustedSettler: SETTLER,
    settlementBond: 1n
  };
  roots = new Map<bigint, string>();
  postedAt = new Map<bigint, bigint>();
  bonds = new Map<bigint, bigint>();
  open = new Map<bigint, bigint>();
  chs: ChallengeView[] = [];
  async state() { return { ...this.s }; }
  async headTimestamp() { return this.now; }
  async epochRoot(e: bigint) { return this.roots.get(e) ?? ZERO; }
  async epochPostedAt(e: bigint) { return this.postedAt.get(e) ?? 0n; }
  async epochBondAmount(e: bigint) { return this.bonds.get(e) ?? 0n; }
  async openChallengeCount(e: bigint) { return this.open.get(e) ?? 0n; }
  async challenges(e: bigint) { return this.chs.filter((c) => c.epoch === e); }
  post(epoch: bigint, root: string, at: bigint) {
    this.s.currentEpoch = epoch;
    this.roots.set(epoch, root);
    this.postedAt.set(epoch, at);
    this.bonds.set(epoch, 1n);
  }
}

class FakeActions implements ClientActions {
  responses: { epoch: bigint; node: string; role: string; score: bigint; proof: string[] }[] = [];
  withdrawn: bigint[] = [];
  respondError?: Error;
  withdrawError?: Error;
  async respondToChallenge(epoch: bigint, node: string, role: string, score: bigint, proof: string[]) {
    if (this.respondError) throw this.respondError;
    this.responses.push({ epoch, node, role, score, proof });
  }
  async withdrawSettlementBond(epoch: bigint) {
    if (this.withdrawError) throw this.withdrawError;
    this.withdrawn.push(epoch);
  }
}

class MemoryStore implements IMerkleStore {
  trees = new Map<string, EpochTree>();
  async saveTree(c: string, e: bigint, t: EpochTree) { this.trees.set(`${c}:${e}`, t); }
  async loadTree(c: string, e: bigint) {
    const t = this.trees.get(`${c}:${e}`);
    if (!t) throw new DriftNotFoundError('missing');
    return t;
  }
  async loadLeaf(): Promise<string[]> { throw new Error('unused'); }
  async loadLeaves(): Promise<string[][]> { throw new Error('unused'); }
}

const treeFor = (epoch: bigint) =>
  buildEpochTree(CTX, epoch, [
    { node: A, role: ROLE, score: 70n },
    { node: B, role: ROLE, score: 30n }
  ]);

function setup() {
  const chain = new FakeChain();
  const actions = new FakeActions();
  const store = new MemoryStore();
  const settled: bigint[] = [];
  let settleImpl: (e: bigint) => Promise<{ root: string; treeURI: string; txHash: string }> = async (e) => {
    const tree = treeFor(e);
    await store.saveTree(CTX, e, tree);
    chain.post(e, tree.root, chain.now);
    return { root: tree.root, treeURI: `ipfs://e${e}`, txHash: '0xtx' };
  };
  const deps: Tier1JobDeps = {
    chain,
    actions,
    store,
    settler: SETTLER,
    bondScanDepth: 64,
    log,
    settle: async (e) => {
      settled.push(e);
      return settleImpl(e);
    }
  };
  const status = newContextStatus('ctx', '0x' + 'c1'.repeat(20), ['tier1']);
  return { chain, actions, store, deps, status, settled, setSettle: (f: typeof settleImpl) => (settleImpl = f) };
}

describe('runTier1: settling', () => {
  it('waits for the boundary, then settles the next epoch once', async () => {
    const t = setup();
    t.chain.now = 1100n; // boundary of epoch 1 is 1100; must be strictly past
    await runTier1(t.deps, t.status);
    expect(t.settled).toEqual([]);
    expect(t.status.nextAction).toMatch(/after its boundary 1100/);

    t.chain.now = 1101n;
    await runTier1(t.deps, t.status);
    expect(t.settled).toEqual([1n]);
    expect(t.status.lastSettled).toMatchObject({ epoch: '1', treeURI: 'ipfs://e1' });

    // Same tick again: epoch 2's boundary (1200) has not passed.
    await runTier1(t.deps, t.status);
    expect(t.settled).toEqual([1n]);
  });

  it('waits for the previous epoch to finalize', async () => {
    const t = setup();
    t.chain.post(1n, treeFor(1n).root, 1195n);
    t.chain.now = 1201n; // epoch 2 boundary passed, but epoch 1's dispute window ends at 1205
    await runTier1(t.deps, t.status);
    expect(t.settled).toEqual([]);
    expect(t.status.nextAction).toMatch(/once epoch 1 finalizes/);
    t.chain.now = 1206n;
    await runTier1(t.deps, t.status);
    expect(t.settled).toEqual([2n]);
  });

  it('treats O1 refusal as waiting and another instance winning the race as done', async () => {
    const t = setup();
    t.chain.now = 1101n;
    t.setSettle(async () => { throw new EpochNotSynchronizedError(1100n, 1100n); });
    await runTier1(t.deps, t.status);
    expect(t.status.nextAction).toMatch(/finalized past 1100/);
    expect(t.status.alerts).toEqual([]);

    t.setSettle(async () => { throw revert('InvalidEpoch'); });
    await runTier1(t.deps, t.status);
    expect(t.status.nextAction).toMatch(/another instance/);
  });

  it('refuses to settle with a key that is not the trusted settler', async () => {
    const t = setup();
    t.chain.s.trustedSettler = Wallet.createRandom().address;
    t.chain.now = 1101n;
    await runTier1(t.deps, t.status);
    expect(t.settled).toEqual([]);
    expect(t.status.alerts[0]).toMatchObject({ level: 'error' });
  });
});

describe('runTier1: challenges', () => {
  function withChallenge(node: string, openedAt = 1200n) {
    const t = setup();
    const tree = treeFor(1n);
    t.chain.post(1n, tree.root, 1195n);
    void t.store.saveTree(CTX, 1n, tree);
    t.chain.open.set(1n, 1n);
    t.chain.chs.push({ epoch: 1n, node, role: ROLE, openedAt, deadline: openedAt + 10n, resolved: false });
    t.chain.now = openedAt + 1n;
    return { ...t, tree };
  }

  it('answers with the stored leaf and a proof that verifies against the root', async () => {
    const t = withChallenge(A);
    await runTier1(t.deps, t.status);
    expect(t.actions.responses).toHaveLength(1);
    const r = t.actions.responses[0]!;
    expect(r.score).toBe(70n);
    expect(StandardMerkleTree.verify(t.tree.root, EPOCH_LEAF_ENCODING, [CTX, A, ROLE, '70', '1'], r.proof)).toBe(true);
    expect(t.status.challenges[0]).toMatchObject({ node: A, state: 'answered' });
  });

  it('treats a challenge another instance answered first as answered', async () => {
    const t = withChallenge(A);
    t.actions.respondError = revert('ChallengeAlreadyResolved');
    await runTier1(t.deps, t.status);
    expect(t.status.lastError).toBeUndefined();
    expect(t.status.challenges[0]!.state).toBe('answered');
  });

  it('raises an error for a genuine omission and does not respond', async () => {
    const t = withChallenge(OMITTED);
    await runTier1(t.deps, t.status);
    expect(t.actions.responses).toEqual([]);
    expect(t.status.challenges[0]!.state).toBe('unanswerable');
    expect(t.status.alerts.some((a) => a.level === 'error' && /genuine omission/.test(a.message))).toBe(true);
  });

  it('reports an expired challenge, and a stored tree that is not the committed one', async () => {
    const t = withChallenge(A);
    t.chain.now = 1300n;
    await runTier1(t.deps, t.status);
    expect(t.status.challenges[0]!.state).toBe('expired');

    const u = withChallenge(A);
    u.chain.roots.set(1n, '0x' + '11'.repeat(32));
    await runTier1(u.deps, u.status);
    expect(u.actions.responses).toEqual([]);
    expect(u.status.alerts.some((a) => /cannot answer/.test(a.message))).toBe(true);
  });
});

describe('runTier1: bonds', () => {
  it('withdraws the bonds of finalized epochs only, and ignores a lost race', async () => {
    const t = setup();
    t.chain.post(1n, treeFor(1n).root, 1101n);
    t.chain.post(2n, treeFor(2n).root, 1201n);
    t.chain.now = 1205n; // epoch 1 finalized (window ended 1111); epoch 2's ends at 1211
    await runTier1(t.deps, t.status);
    expect(t.actions.withdrawn).toEqual([1n]);

    t.actions.withdrawError = revert('NoBondToWithdraw');
    await runTier1(t.deps, t.status);
    expect(t.status.lastError).toBeUndefined();
  });
});

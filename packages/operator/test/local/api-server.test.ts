import { describe, it, expect } from 'vitest';
import { id, Wallet } from 'ethers';
import { pino } from 'pino';
import { StandardMerkleTree } from '@openzeppelin/merkle-tree';
import { buildEpochTree, EPOCH_LEAF_ENCODING } from '@drift-network/sdk/merkle';
import { buildApi, PROOF_NOTICE } from '../../src/api/server.js';
import type { DaemonStatus } from '../../src/daemon/daemon.js';
import { newContextStatus } from '../../src/daemon/status.js';
import { FakeChain, MemoryStore } from './daemon-fakes.js';

const CTX = id('api.test').toLowerCase();
const ROLE = id('MEMBER').toLowerCase();
const ROLE2 = id('TA').toLowerCase();
const CLIENT = '0x' + 'c1'.repeat(20);
const [A, B] = [1, 2].map(() => Wallet.createRandom().address.toLowerCase()) as [string, string];

function setup(ready = { ready: true }) {
  const chain = new FakeChain(CTX, Wallet.createRandom().address);
  const store = new MemoryStore();
  const tree = buildEpochTree(CTX, 1n, [
    { node: A, role: ROLE, score: 7n },
    { node: A, role: ROLE2, score: 3n },
    { node: B, role: ROLE, score: 5n }
  ]);
  chain.post(1n, tree.root, 1101n);
  chain.uris.set(1n, 'ipfs://tree1');
  chain.now = 1105n;
  const status = newContextStatus('uni', CLIENT, ['tier1']);
  status.currentEpoch = '1';
  status.alerts = [{ level: 'error', message: 'x', at: 1 }];
  const daemonStatus: DaemonStatus = { startedAt: 1, lastTickAt: 2, ticks: 3, contexts: [status] };
  const app = buildApi({
    logger: pino({ level: 'silent' }),
    status: () => daemonStatus,
    ready: async () => ready,
    contexts: [{ name: 'uni', client: CLIENT, chain, store }]
  });
  return { app, chain, store, tree };
}

describe('operator API', () => {
  it('serves health, readiness and status', async () => {
    const { app } = setup();
    expect((await app.inject({ url: '/health' })).json()).toEqual({ ok: true });
    expect((await app.inject({ url: '/ready' })).statusCode).toBe(200);
    expect((await app.inject({ url: '/status' })).json()).toMatchObject({ ticks: 3, contexts: [{ name: 'uni', currentEpoch: '1' }] });
    const notReady = setup({ ready: false, reason: 'no tick completed yet' } as never).app;
    const r = await notReady.inject({ url: '/ready' });
    expect(r.statusCode).toBe(503);
    expect(r.json()).toMatchObject({ reason: 'no tick completed yet' });
  });

  it('describes an epoch, by context name or client address', async () => {
    const { app, tree } = setup();
    const r = await app.inject({ url: '/contexts/uni/epochs/1' });
    expect(r.json()).toMatchObject({ root: tree.root, treeURI: 'ipfs://tree1', postedAt: '1101', disputeWindowEndsAt: '1111', finalized: false });
    expect((await app.inject({ url: `/contexts/${CLIENT.toUpperCase().replace('0X', '0x')}/epochs/1` })).statusCode).toBe(200);
    expect((await app.inject({ url: '/contexts/nope/epochs/1' })).statusCode).toBe(404);
    expect((await app.inject({ url: '/contexts/uni/epochs/0' })).statusCode).toBe(400);
    expect((await app.inject({ url: '/contexts/uni/epochs/2' })).statusCode).toBe(404);
  });

  it('serves every leaf of a node with proofs that verify, marked untrusted', async () => {
    const { app, store, tree } = setup();
    await store.saveTree(CTX, 1n, tree);
    const r = await app.inject({ url: `/contexts/uni/epochs/1/proofs/${A}` });
    expect(r.headers['x-drift-trust']).toBe('unverified');
    const body = r.json<{ notice: string; matchesCommitted: boolean; leaves: { role: string; score: string; proof: string[] }[] }>();
    expect(body.notice).toBe(PROOF_NOTICE);
    expect(body.matchesCommitted).toBe(true);
    expect(body.leaves).toHaveLength(2);
    for (const l of body.leaves) {
      expect(StandardMerkleTree.verify(tree.root, EPOCH_LEAF_ENCODING, [CTX, A, l.role, l.score, '1'], l.proof)).toBe(true);
    }
  });

  it('says when its tree is not the committed one, when it holds none, and rejects bad input', async () => {
    const { app, store, chain, tree } = setup();
    await store.saveTree(CTX, 1n, tree);
    chain.roots.set(1n, '0x' + '22'.repeat(32));
    expect((await app.inject({ url: `/contexts/uni/epochs/1/proofs/${A}` })).json()).toMatchObject({ matchesCommitted: false });
    expect((await app.inject({ url: `/contexts/uni/epochs/1/proofs/${Wallet.createRandom().address}` })).statusCode).toBe(404);
    expect((await app.inject({ url: '/contexts/uni/epochs/1/proofs/0x1234' })).statusCode).toBe(400);
    const empty = setup().app;
    expect((await empty.inject({ url: `/contexts/uni/epochs/1/proofs/${A}` })).json()).toMatchObject({ notice: PROOF_NOTICE });
  });

  it('exposes Prometheus metrics', async () => {
    const { app } = setup();
    const text = (await app.inject({ url: '/metrics' })).body;
    expect(text).toContain('drift_operator_ticks_total 3');
    expect(text).toContain('drift_operator_current_epoch{context="uni"} 1');
    expect(text).toContain('drift_operator_alerts{context="uni",level="error"} 1');
  });
});

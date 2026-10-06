import { describe, it, expect } from 'vitest';
import { id, Wallet } from 'ethers';
import { pino } from 'pino';
import { LocalEpochEngine, DEFAULT_EIGENTRUST_PARAMS, type EpochInput, type EpochResult } from '@drift-network/sdk/engines';
import { buildEpochTree } from '@drift-network/sdk/merkle';
import { createWatcher } from '../../src/daemon/jobs/watcher.js';
import { newContextStatus } from '../../src/daemon/status.js';
import { FakeActions, FakeChain, revert } from './daemon-fakes.js';

const CTX = id('daemon.watch').toLowerCase();
const ROLE = id('MEMBER').toLowerCase();
const SETTLER = Wallet.createRandom().address;
const WATCHER = Wallet.createRandom().address.toLowerCase();
const [A, B] = [1, 2].map(() => Wallet.createRandom().address.toLowerCase()) as [string, string];
const log = pino({ level: 'silent' });

async function ours(members: string[]): Promise<EpochResult> {
  const input: EpochInput = {
    contextUID: CTX,
    epoch: 1n,
    tE: 1100n,
    schemaUID: id('schema'),
    schemaDefinition: 'uint256 score',
    params: DEFAULT_EIGENTRUST_PARAMS,
    defaultWeight: 1n,
    records: [],
    members: members.map((node) => ({ node, role: ROLE })),
    pretrust: []
  };
  return new LocalEpochEngine().computeEpoch(input);
}

async function setup(watcherMembers: string[], postedMembers: string[], opts: { challenge?: boolean } = {}) {
  const chain = new FakeChain(CTX, SETTLER);
  const actions = new FakeActions();
  const mine = await ours(watcherMembers);
  const posted = buildEpochTree(CTX, 1n, (await ours(postedMembers)).entries);
  chain.post(1n, posted.root, 1101n);
  chain.now = 1102n;
  let computed = 0;
  const run = createWatcher({
    chain,
    actions,
    compute: async () => { computed++; return mine; },
    fetchPosted: async () => posted,
    challenge: opts.challenge ?? false,
    challenger: WATCHER,
    log
  });
  const status = newContextStatus('ctx', '0x' + 'c1'.repeat(20), ['watcher']);
  return { chain, actions, run, status, mine, posted, computed: () => computed };
}

describe('watcher', () => {
  it('confirms a root it recomputes, once per posting', async () => {
    const t = await setup([A, B], [A, B]);
    await t.run(t.status);
    await t.run(t.status);
    expect(t.status.watch).toMatchObject({ agrees: true, omitted: [], treeAvailable: true });
    expect(t.status.alerts).toEqual([]);
    expect(t.computed()).toBe(1);
  });

  it('reports divergence with both roots and its input digest, and lists omitted pairs', async () => {
    const t = await setup([A, B], [A]);
    await t.run(t.status);
    expect(t.status.watch).toMatchObject({
      agrees: false,
      postedRoot: t.posted.root.toLowerCase(),
      ourRoot: t.mine.merkleRoot.toLowerCase(),
      ourInputDigest: t.mine.inputDigest,
      omitted: [{ node: B, role: ROLE }]
    });
    expect(t.status.alerts.filter((a) => a.level === 'error')).toHaveLength(2);
    expect(t.actions.challengesOpened).toEqual([]); // challenging is off by default
  });

  it('challenges one omitted pair with a padded bond, preferring itself, and only once', async () => {
    const t = await setup([A, B, WATCHER], [A], { challenge: true });
    await t.run(t.status);
    await t.run(t.status);
    expect(t.actions.challengesOpened).toEqual([{ epoch: 1n, node: WATCHER, role: ROLE, bond: 120n }]);
    expect(t.status.watch!.challenged).toEqual({ node: WATCHER, role: ROLE });
  });

  it('records lack of standing and a closed window instead of failing', async () => {
    const t = await setup([A, B], [A], { challenge: true });
    t.actions.challengeError = revert('ThirdPartyChallengeNotPermitted');
    await t.run(t.status);
    expect(t.status.watch!.challengeSkipped).toBe('ThirdPartyChallengeNotPermitted');
    expect(t.status.lastError).toBeUndefined();

    const u = await setup([A, B], [A], { challenge: true });
    u.chain.now = 1200n;
    await u.run(u.status);
    expect(u.actions.challengesOpened).toEqual([]);
    expect(u.status.watch!.challengeSkipped).toBe('dispute window closed');
  });

  it('flags an unretrievable tree and retries next tick', async () => {
    const t = await setup([A], [A]);
    let fail = true;
    const run = createWatcher({
      chain: t.chain,
      actions: t.actions,
      compute: async () => t.mine,
      fetchPosted: async () => { if (fail) throw new Error('gateway timeout'); return t.posted; },
      challenge: false,
      challenger: WATCHER,
      log
    });
    await run(t.status);
    expect(t.status.watch).toMatchObject({ treeAvailable: false });
    expect(t.status.alerts[0]!.message).toMatch(/not retrievable/);
    fail = false;
    t.status.alerts = [];
    await run(t.status);
    expect(t.status.watch).toMatchObject({ treeAvailable: true, agrees: true });
  });
});

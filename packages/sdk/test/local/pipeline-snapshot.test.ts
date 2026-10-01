import { describe, it, expect } from 'vitest';
import { AbiCoder, Interface, Wallet, id, type Log, type Provider } from 'ethers';
import { loadBoundaryMembership } from '../../src/pipeline/membership.js';
import { loadEpochSnapshot } from '../../src/pipeline/snapshot.js';
import { filterContextRecords } from '../../src/membership.js';
import { EpochNotSynchronizedError } from '../../src/settler.js';
import type { IAttestationProvider } from '../../src/providers/IAttestationProvider.js';
import type { AttestationRecord } from '../../src/types.js';

const iface = new Interface([
  'event NodeRegistered(bytes32 indexed contextUID, address indexed node)',
  'event NodeDeregistered(bytes32 indexed contextUID, address indexed node)',
  'event RoleAssigned(bytes32 indexed contextUID, address indexed node, bytes32 role)',
  'function nodeBannedAt(bytes32 contextUID, address node) view returns (uint256)',
  'function nodeHeldRoleAt(bytes32 contextUID, address node, bytes32 role, uint256 timestamp) view returns (bool)',
  'function epochLength() view returns (uint256)',
  'function epochAnchorTimestamp() view returns (uint256)',
  'function core() view returns (address)',
  'function contextUID() view returns (bytes32)'
]);

const CORE = '0x' + 'c0'.repeat(20);
const CLIENT = '0x' + 'c1'.repeat(20);
const CTX = id('pipeline.test');
const SCHEMA = id('schema');
const ROLE = id('MEMBER').toLowerCase();
const ROLE2 = id('TA').toLowerCase();
const addr = () => Wallet.createRandom().address.toLowerCase();

// Timeline (block n has timestamp 100 * n). Epoch length 1000, anchor 0: epoch 1 boundary = 1000.
const [alice, bob, carol, dave, erin, frank] = [addr(), addr(), addr(), addr(), addr(), addr()];
type Ev = { block: number; name: 'NodeRegistered' | 'NodeDeregistered' | 'RoleAssigned'; node: string; role?: string };
const events: Ev[] = [
  { block: 1, name: 'NodeRegistered', node: alice },
  { block: 1, name: 'RoleAssigned', node: alice, role: ROLE },
  { block: 2, name: 'NodeRegistered', node: bob },
  { block: 2, name: 'RoleAssigned', node: bob, role: ROLE },
  { block: 3, name: 'RoleAssigned', node: bob, role: ROLE2 },
  // carol joins, leaves before the boundary: not a member, roles revoked by deregistration
  { block: 3, name: 'NodeRegistered', node: carol },
  { block: 3, name: 'RoleAssigned', node: carol, role: ROLE },
  { block: 5, name: 'NodeDeregistered', node: carol },
  // dave leaves and re-registers before the boundary: member since block 7
  { block: 2, name: 'NodeRegistered', node: dave },
  { block: 4, name: 'NodeDeregistered', node: dave },
  { block: 7, name: 'NodeRegistered', node: dave },
  { block: 8, name: 'RoleAssigned', node: dave, role: ROLE },
  // erin registers after the boundary
  { block: 12, name: 'NodeRegistered', node: erin },
  { block: 12, name: 'RoleAssigned', node: erin, role: ROLE },
  // frank is banned at block 6
  { block: 2, name: 'NodeRegistered', node: frank },
  { block: 2, name: 'RoleAssigned', node: frank, role: ROLE }
];
const bannedAt = new Map([[frank, 600n]]);
// Pairs whose role was held at t=1000 per the contract's view.
const heldAt1000 = new Set([`${alice}:${ROLE}`, `${bob}:${ROLE}`, `${bob}:${ROLE2}`, `${dave}:${ROLE}`, `${frank}:${ROLE}`]);

function fakeChain(headTimestamp: number): Provider {
  const logs: Log[] = events.map((e, i) => {
    const args = e.name === 'RoleAssigned' ? [CTX, e.node, e.role] : [CTX, e.node];
    const { data, topics } = iface.encodeEventLog(e.name, args);
    return { address: CORE, blockNumber: e.block, index: i, data, topics } as unknown as Log;
  });
  return {
    getLogs: async (f: { topics: (string | null)[] }) => logs.filter((l) => l.topics[0] === f.topics[0] && l.topics[1] === f.topics[1]),
    getBlock: async (tag: number | string) => ({ timestamp: typeof tag === 'number' ? tag * 100 : headTimestamp }),
    call: async (tx: { to: string; data: string }) => {
      const p = iface.parseTransaction({ data: tx.data })!;
      const enc = (v: unknown) => iface.encodeFunctionResult(p.name, [v]);
      switch (p.name) {
        case 'nodeBannedAt': return enc(bannedAt.get((p.args[1] as string).toLowerCase()) ?? 0n);
        case 'nodeHeldRoleAt': {
          expect(p.args[3]).toBe(1000n);
          return enc(heldAt1000.has(`${(p.args[1] as string).toLowerCase()}:${(p.args[2] as string).toLowerCase()}`));
        }
        case 'epochLength': return enc(1000n);
        case 'epochAnchorTimestamp': return enc(0n);
        case 'core': return enc(CORE);
        case 'contextUID': return enc(CTX);
      }
      throw new Error(`unexpected call ${p.name}`);
    },
    getNetwork: async () => ({ chainId: 31337n })
  } as unknown as Provider;
}

const rec = (uid: string, attester: string, subject: string, timestamp: number, schemaUID = SCHEMA): AttestationRecord => ({
  uid: id(uid),
  schemaUID,
  attester,
  subject,
  timestamp,
  revoked: false,
  data: AbiCoder.defaultAbiCoder().encode(['uint256'], [10])
});

describe('loadBoundaryMembership', () => {
  it('replays registrations up to the boundary and keeps pairs held then', async () => {
    const m = await loadBoundaryMembership(fakeChain(5000), CORE, CTX, 1000n);
    expect(Object.fromEntries(m.joinedAt)).toEqual({ [alice]: 100n, [bob]: 200n, [dave]: 700n });
    const pairs = m.members.map((x) => `${x.node}:${x.role}`);
    expect(new Set(pairs)).toEqual(new Set([`${alice}:${ROLE}`, `${bob}:${ROLE}`, `${bob}:${ROLE2}`, `${dave}:${ROLE}`]));
    expect(pairs).toEqual([...pairs].sort());
  });
});

describe('filterContextRecords', () => {
  it('keeps records between members made after both joined', () => {
    const joined = new Map([[alice, 100n], [dave, 700n]]);
    const kept = filterContextRecords(
      [rec('ok', alice, dave, 800), rec('beforeRejoin', alice, dave, 300), rec('outsider', alice, carol, 800)],
      joined
    );
    expect(kept.map((r) => r.uid)).toEqual([id('ok')]);
  });
});

describe('loadEpochSnapshot', () => {
  const records = [
    rec('a->b', alice, bob, 400),
    rec('b->a', bob, alice, 900),
    rec('a->dave-old', alice, dave, 300), // before dave's current registration
    rec('a->dave', alice, dave, 800),
    rec('carol->a', carol, alice, 400), // carol left before the boundary
    rec('frank->a', frank, alice, 400), // frank banned before the boundary
    rec('other-schema', alice, bob, 400, id('other'))
  ];
  let seenAsOf: number | undefined;
  const attestations: IAttestationProvider = {
    fetchUserRecords: async () => [],
    fetchAllContextRecords: async (_c, asOf) => {
      seenAsOf = asOf;
      return records;
    }
  };

  it('refuses until the finalized head is past the boundary (O1)', async () => {
    await expect(
      loadEpochSnapshot({ provider: fakeChain(1000), client: CLIENT, epoch: 1n, attestations, schemaUID: SCHEMA })
    ).rejects.toBeInstanceOf(EpochNotSynchronizedError);
  });

  it('builds the engine input from the chain at the boundary', async () => {
    const s = await loadEpochSnapshot({ provider: fakeChain(1001), client: CLIENT, epoch: 1n, attestations, schemaUID: SCHEMA });
    expect(seenAsOf).toBe(1000);
    expect(s.boundaryTimestamp).toBe(1000n);
    expect(s.input.tE).toBe(1000n);
    expect(s.input.contextUID).toBe(CTX);
    expect(s.input.records.map((r) => r.uid)).toEqual([id('a->b'), id('b->a'), id('a->dave')]);
    expect(s.input.members).toHaveLength(4);
    expect(s.input.defaultWeight).toBe(1n);
  });
});

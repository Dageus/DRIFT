import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  AbiCoder,
  Interface,
  Wallet,
  id,
  type Log,
  type Provider,
  type TransactionRequest,
  type TransactionResponse
} from 'ethers';
import { SafeSettler } from '../../src/safe/SafeSettler.js';
import { LocalEpochEngine } from '@drift-network/sdk/engines';
import type { IEpochEngine } from '@drift-network/sdk/engines';
import type { ITreeTransport } from '@drift-network/sdk/merkle';
import { checkEpochTree, type EpochTree } from '@drift-network/sdk/merkle';
import type { IAttestationProvider } from '@drift-network/sdk';
import type { AttestationRecord } from '@drift-network/sdk';
import { FileSettlementRelay } from '../../src/pipeline/relay.js';
import {
  commitEpochTier2,
  evaluateReveals,
  executeEpochTier2,
  proposeEpochTier2,
  publishEpochTreeTier2,
  revealEpochTier2,
  signEpochTier2,
  type OwnerCompute
} from '../../src/pipeline/tier2.js';
import { commitmentHash, signCommitment, signReveal } from '../../src/pipeline/commitments.js';

const iface = new Interface([
  'function getOwners() view returns (address[])',
  'function getThreshold() view returns (uint256)',
  'function nonce() view returns (uint256)',
  'function contextUID() view returns (bytes32)',
  'function core() view returns (address)',
  'function settlementBond() view returns (uint256)',
  'function epochRoots(uint256) view returns (bytes32)',
  'function epochLength() view returns (uint256)',
  'function epochAnchorTimestamp() view returns (uint256)',
  'function eip712Domain() view returns (bytes1 fields, string name, string version, uint256 chainId, address verifyingContract, bytes32 salt, uint256[] extensions)',
  'function nodeBannedAt(bytes32 contextUID, address node) view returns (uint256)',
  'function nodeHeldRoleAt(bytes32 contextUID, address node, bytes32 role, uint256 timestamp) view returns (bool)',
  'function execTransaction(address to, uint256 value, bytes data, uint8 operation, uint256 safeTxGas, uint256 baseGas, uint256 gasPrice, address gasToken, address refundReceiver, bytes signatures) payable returns (bool)',
  'event NodeRegistered(bytes32 indexed contextUID, address indexed node)',
  'event RoleAssigned(bytes32 indexed contextUID, address indexed node, bytes32 role)'
]);

const SAFE = '0x' + '5a'.repeat(20);
const CLIENT = '0x' + 'c1'.repeat(20);
const CORE = '0x' + 'c0'.repeat(20);
const CTX = id('tier2.test');
const SCHEMA = id('schema');
const ROLE = id('MEMBER');
const owners = [1, 2, 3].map((i) => new Wallet('0x' + i.toString(16).padStart(64, '0')));
const nodes = [Wallet.createRandom(), Wallet.createRandom(), Wallet.createRandom()].map((w) => w.address.toLowerCase());

function fakeChain(): Provider {
  // A real Provider is its own ContractRunner (`provider.provider === provider`); this one too.
  const self: Record<string, unknown> = {};
  const logs: Log[] = nodes.flatMap((n, i) => [
    { address: CORE, blockNumber: 1, index: 2 * i, ...iface.encodeEventLog('NodeRegistered', [CTX, n]) },
    { address: CORE, blockNumber: 1, index: 2 * i + 1, ...iface.encodeEventLog('RoleAssigned', [CTX, n, ROLE]) }
  ]) as unknown as Log[];
  const chain = {
    call: async (tx: { data: string }) => {
      const f = iface.parseTransaction({ data: tx.data })!;
      const r = (...v: unknown[]) => iface.encodeFunctionResult(f.name, v);
      switch (f.name) {
        case 'getOwners': return r(owners.map((o) => o.address));
        case 'getThreshold': return r(2n);
        case 'nonce': return r(4n);
        case 'contextUID': return r(CTX);
        case 'core': return r(CORE);
        case 'settlementBond': return r(10n ** 16n);
        case 'epochRoots': return r('0x' + '00'.repeat(32));
        case 'epochLength': return r(1000n);
        case 'epochAnchorTimestamp': return r(0n);
        case 'eip712Domain': return r('0x0f', 'DRIFT_WeightedGovernance', '1', 31337n, CLIENT, '0x' + '00'.repeat(32), []);
        case 'nodeBannedAt': return r(0n);
        case 'nodeHeldRoleAt': return r(true);
      }
      throw new Error(`unexpected call ${f.name}`);
    },
    getLogs: async (f: { topics: (string | null)[] }) => logs.filter((l) => l.topics[0] === f.topics[0]),
    getBlock: async (tag: number | string) => ({ timestamp: typeof tag === 'number' ? 100 : 5000 }),
    getNetwork: async () => ({ chainId: 31337n })
  };
  Object.assign(self, chain, { provider: self });
  return self as unknown as Provider;
}

const enc = (v: number) => AbiCoder.defaultAbiCoder().encode(['uint256'], [v]);
const records: AttestationRecord[] = [
  { uid: id('r1'), schemaUID: SCHEMA, attester: nodes[0]!, subject: nodes[1]!, timestamp: 500, revoked: false, data: enc(5) },
  { uid: id('r2'), schemaUID: SCHEMA, attester: nodes[1]!, subject: nodes[2]!, timestamp: 500, revoked: false, data: enc(3) }
];
const attestations: IAttestationProvider = { fetchUserRecords: async () => [], fetchAllContextRecords: async () => records };

/** An engine that drops the first record: a faulty or dishonest owner computes a different root. */
const skewed: IEpochEngine = {
  computeEpoch: (input) => new LocalEpochEngine().computeEpoch({ ...input, records: input.records.slice(1) })
};

function memoryTransport(): ITreeTransport & { trees: Map<string, EpochTree>; pinned: string[] } {
  const trees = new Map<string, EpochTree>();
  const pinned: string[] = [];
  return {
    trees,
    pinned,
    uploadTree: async (tree) => {
      const uri = `mem://${tree.root}`;
      trees.set(uri, tree);
      return uri;
    },
    fetchTree: async (uri, expected) => {
      const t = trees.get(uri);
      if (!t) throw new Error('not found');
      return checkEpochTree(t, expected);
    },
    pin: async (uri) => {
      pinned.push(uri);
    }
  };
}

class RecordingWallet extends Wallet {
  sent: TransactionRequest[] = [];
  override async sendTransaction(tx: TransactionRequest): Promise<TransactionResponse> {
    this.sent.push(tx);
    return { hash: '0x' + 'ee'.repeat(32), wait: async () => ({ status: 1 }) } as unknown as TransactionResponse;
  }
}

describe('Tier 2 settlement steps', () => {
  let dir: string;
  let relay: FileSettlementRelay;
  let t: number;
  let provider: Provider;
  let safeSettler: SafeSettler;
  let transport: ReturnType<typeof memoryTransport>;
  const now = () => t;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'drift-relay-'));
    relay = new FileSettlementRelay(dir);
    t = 6000;
    provider = fakeChain();
    safeSettler = new SafeSettler(provider, SAFE, CLIENT);
    transport = memoryTransport();
  });
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  const compute = (engine: IEpochEngine = new LocalEpochEngine()): OwnerCompute => ({
    snapshot: { provider, attestations, schemaUID: SCHEMA },
    engine
  });
  const base = () => ({ safeSettler, relay, now });

  async function propose() {
    return proposeEpochTier2({ ...base(), proposer: owners[0]!, epoch: 1n, commitWindow: 10, revealWindow: 10 });
  }

  async function commitAndReveal(proposalId: string, engines: IEpochEngine[]) {
    for (const [i, o] of owners.entries()) {
      expect((await commitEpochTier2({ ...base(), owner: o, proposalId, compute: compute(engines[i]) })).status).toBe('done');
    }
    t += 11;
    for (const [i, o] of owners.entries()) {
      expect((await revealEpochTier2({ ...base(), owner: o, proposalId, compute: compute(engines[i]) })).status).toBe('done');
    }
    t += 10;
  }

  it('the proposal discloses nothing that determines the root', async () => {
    const p = await propose();
    expect(Object.keys(p).sort()).toEqual(
      ['chainId', 'client', 'commitDeadline', 'contextUID', 'epoch', 'proposalId', 'proposer', 'revealDeadline', 'safe', 'safeNonce', 'signature'].sort()
    );
    expect(await relay.getSettlement(p.proposalId)).toBeNull();
    expect(await propose()).toEqual(p); // idempotent
  });

  it('runs propose, commit, reveal, publish, sign and execute, with windows and idempotency', async () => {
    const { proposalId } = await propose();
    const c = compute();

    expect((await commitEpochTier2({ ...base(), owner: owners[0]!, proposalId, compute: c })).status).toBe('done');
    expect((await commitEpochTier2({ ...base(), owner: owners[0]!, proposalId, compute: c })).status).toBe('already-done');
    expect((await revealEpochTier2({ ...base(), owner: owners[0]!, proposalId, compute: c })).status).toBe('waiting');
    await commitEpochTier2({ ...base(), owner: owners[1]!, proposalId, compute: c });
    await commitEpochTier2({ ...base(), owner: owners[2]!, proposalId, compute: c });

    t += 11;
    for (const o of owners) expect((await revealEpochTier2({ ...base(), owner: o, proposalId, compute: c })).status).toBe('done');
    expect((await publishEpochTreeTier2({ ...base(), owner: owners[1]!, proposalId, compute: c, transport })).status).toBe('waiting');
    expect((await signEpochTier2({ ...base(), owner: owners[1]!, proposalId, transport })).status).toBe('waiting');

    t += 10;
    const pub = await publishEpochTreeTier2({ ...base(), owner: owners[1]!, proposalId, compute: c, transport });
    expect(pub.status).toBe('done');
    expect((await publishEpochTreeTier2({ ...base(), owner: owners[2]!, proposalId, compute: c, transport })).status).toBe('already-done');
    const settlement = pub.settlement!;
    expect(transport.trees.get(settlement.treeURI)!.root).toBe(settlement.root);

    const sender = new RecordingWallet(Wallet.createRandom().privateKey);
    expect((await executeEpochTier2({ ...base(), sender, proposalId })).status).toBe('waiting');
    expect((await signEpochTier2({ ...base(), owner: owners[0]!, proposalId, transport })).status).toBe('done');
    expect((await signEpochTier2({ ...base(), owner: owners[0]!, proposalId, transport })).status).toBe('already-done');
    expect((await signEpochTier2({ ...base(), owner: owners[2]!, proposalId, transport })).status).toBe('done');
    expect(transport.pinned).toContain(settlement.treeURI);

    expect((await executeEpochTier2({ ...base(), sender, proposalId })).status).toBe('done');
    const call = iface.decodeFunctionData('execTransaction', sender.sent[0]!.data as string);
    expect(call[0]).toBe(settlement.tx.to);
    expect(call[2]).toBe(settlement.tx.data);
    expect((call[9] as string).length).toBe(2 + 2 * 65 * 2);
  });

  it('settles on the majority root and the dissenting owner refuses to sign', async () => {
    const { proposalId } = await propose();
    await commitAndReveal(proposalId, [new LocalEpochEngine(), skewed, new LocalEpochEngine()]);

    expect((await publishEpochTreeTier2({ ...base(), owner: owners[1]!, proposalId, compute: compute(skewed), transport }).catch((e: Error) => e.message)))
      .toMatch(/different root than the agreed one/);
    expect((await publishEpochTreeTier2({ ...base(), owner: owners[0]!, proposalId, compute: compute(), transport })).status).toBe('done');
    await expect(signEpochTier2({ ...base(), owner: owners[1]!, proposalId, transport })).rejects.toThrow(/no valid reveal of root/);
  });

  it('fails when no root reaches the threshold', async () => {
    const { proposalId } = await propose();
    const another: IEpochEngine = {
      computeEpoch: (input) => new LocalEpochEngine().computeEpoch({ ...input, records: input.records.slice(0, 1) })
    };
    await commitAndReveal(proposalId, [new LocalEpochEngine(), skewed, another]);
    await expect(publishEpochTreeTier2({ ...base(), owner: owners[0]!, proposalId, compute: compute(), transport })).rejects.toThrow(
      /no root reached the Safe threshold/
    );
  });

  it('refuses commits after the deadline and reveals after the reveal deadline', async () => {
    const { proposalId } = await propose();
    await commitEpochTier2({ ...base(), owner: owners[0]!, proposalId, compute: compute() });
    t += 11;
    await expect(commitEpochTier2({ ...base(), owner: owners[1]!, proposalId, compute: compute() })).rejects.toThrow(/commit window/);
    t += 10;
    await expect(revealEpochTier2({ ...base(), owner: owners[0]!, proposalId, compute: compute() })).rejects.toThrow(/reveal window/);
  });

  it('a copier who commits after seeing a reveal is not counted', async () => {
    const p = await propose();
    const c = compute();
    await commitEpochTier2({ ...base(), owner: owners[0]!, proposalId: p.proposalId, compute: c });
    await commitEpochTier2({ ...base(), owner: owners[1]!, proposalId: p.proposalId, compute: c });
    t += 11;
    await revealEpochTier2({ ...base(), owner: owners[0]!, proposalId: p.proposalId, compute: c });
    await revealEpochTier2({ ...base(), owner: owners[1]!, proposalId: p.proposalId, compute: c });

    // Owner 2 bypasses the SDK: copies the revealed root, then commits and reveals with it.
    const copied = (await relay.listReveals(p.proposalId))[0]!;
    const salt = id('copier');
    const commitment = commitmentHash(copied.root, copied.inputDigest, salt);
    await relay.putCommitment(await signCommitment(owners[2]!, p.chainId, p.safe, { proposalId: p.proposalId, owner: owners[2]!.address, commitment }));
    const seen = (await relay.listCommitments(p.proposalId)).map((x) => ({ owner: x.owner, commitment: x.commitment }));
    await relay.putReveal(
      await signReveal(owners[2]!, p.chainId, p.safe, {
        proposalId: p.proposalId,
        owner: owners[2]!.address,
        root: copied.root,
        inputDigest: copied.inputDigest,
        salt,
        seen
      })
    );

    const e = evaluateReveals(p, await relay.listCommitments(p.proposalId), await relay.listReveals(p.proposalId), owners.map((o) => o.address), 2n);
    expect(e.valid.map((r) => r.owner.toLowerCase()).sort()).toEqual([owners[0]!.address, owners[1]!.address].map((a) => a.toLowerCase()).sort());
  });

  it('refuses to sign a published transaction that is not the settlement of the agreed root', async () => {
    const { proposalId } = await propose();
    await commitAndReveal(proposalId, [new LocalEpochEngine(), new LocalEpochEngine(), new LocalEpochEngine()]);
    const honest = await publishEpochTreeTier2({ ...base(), owner: owners[0]!, proposalId, compute: compute(), transport });
    // A copy of the relay whose published settlement carries a tampered bond.
    const dir2 = fs.mkdtempSync(path.join(os.tmpdir(), 'drift-relay-'));
    fs.cpSync(dir, dir2, { recursive: true });
    fs.rmSync(path.join(dir2, proposalId.toLowerCase(), 'settlement.json'));
    const relay2 = new FileSettlementRelay(dir2);
    const s = honest.settlement!;
    await relay2.putSettlement({ ...s, tx: { ...s.tx, value: 1n }, safeTxHash: id('forged') });
    await expect(signEpochTier2({ safeSettler, relay: relay2, now, owner: owners[1]!, proposalId, transport })).rejects.toThrow(
      /not the settlement of the agreed root/
    );
    fs.rmSync(dir2, { recursive: true, force: true });
  });
});

describe('FileSettlementRelay', () => {
  it('is first-writer-wins: same value again is a no-op, a different one is rejected, no temp files remain', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'drift-relay-'));
    const relay = new FileSettlementRelay(dir);
    const proposalId = id('p');
    const owner = owners[0]!.address;
    const c = { proposalId, owner, commitment: id('a'), signature: '0x01' };
    await relay.putCommitment(c);
    await relay.putCommitment(c);
    await expect(relay.putCommitment({ ...c, commitment: id('b') })).rejects.toThrow(/different commitment/);
    expect(await relay.listCommitments(proposalId)).toEqual([c]);
    const files = fs.readdirSync(path.join(dir, proposalId, 'commitments'));
    expect(files).toEqual([`${owner.toLowerCase()}.json`]);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('round-trips bigints', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'drift-relay-'));
    const relay = new FileSettlementRelay(dir);
    const p = { proposalId: id('p2'), chainId: 31337n, safe: SAFE, client: CLIENT, contextUID: CTX, epoch: 3n, safeNonce: 0n, commitDeadline: 1n, revealDeadline: 2n, proposer: owners[0]!.address, signature: '0x' };
    await relay.putProposal(p);
    expect(await relay.getProposal(p.proposalId)).toEqual(p);
    fs.rmSync(dir, { recursive: true, force: true });
  });
});

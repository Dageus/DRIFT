// End-to-end settlement on a local chain: anvil, the DRIFT contracts deployed by forge script, the
// real Safe v1.4.1 bytecode, and the SDK pipeline for both tiers, ending in an on-chain claim.
//
// Opt-in, since it needs anvil and forge on PATH and takes tens of seconds:
//   DRIFT_E2E_ANVIL=1 npx vitest run --config vitest.unit.config.ts pipeline-anvil
// (inside `nix develop`). It lives with the hermetic tests because test/e2e's setup expects a
// pre-deployed chain; this test deploys its own and tears it down.
//
// The snapshot uses blockTag 'latest': anvil's blocks are final as soon as they are mined, and its
// 'finalized' tag does not advance with evm_increaseTime. On a real chain keep the default.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { readFileSync, rmSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { AbiCoder, Contract, HDNodeWallet, JsonRpcProvider, Mnemonic, NonceManager, keccak256, id, type Signer } from 'ethers';
import { DriftSettler } from '../../src/settler.js';
import { SafeSettler, SAFE_V141 } from '../../src/safe/SafeSettler.js';
import { LocalEpochEngine } from '../../src/engines/epoch/LocalEpochEngine.js';
import type { IEpochEngine } from '../../src/engines/epoch/IEpochEngine.js';
import { checkEpochTree, findLeaves, type EpochTree } from '../../src/merkle/epochTree.js';
import type { ITreeTransport } from '../../src/merkle/ITreeTransport.js';
import { resolveEpochTree } from '../../src/merkle/resolveEpochTree.js';
import type { IAttestationProvider } from '../../src/providers/IAttestationProvider.js';
import type { AttestationRecord } from '../../src/types.js';
import { loadEpochSnapshot, type EpochSnapshotParams } from '../../src/pipeline/snapshot.js';
import { settleEpochTier1 } from '../../src/pipeline/tier1.js';
import { FileSettlementRelay } from '../../src/pipeline/relay.js';
import {
  commitEpochTier2,
  executeEpochTier2,
  proposeEpochTier2,
  publishEpochTreeTier2,
  revealEpochTier2,
  signEpochTier2,
  type OwnerCompute
} from '../../src/pipeline/tier2.js';
import { ReputationModule } from '../../src/modules/reputation.js';

const CONTRACTS = fileURLToPath(new URL('../../../contracts', import.meta.url));
const FIXTURES = `${CONTRACTS}/test/fixtures/safe-v1.4.1`;
const MNEMONIC = 'test test test test test test test test test test test junk';
const ROLE = id('MEMBER');
const SCHEMA = id('drift.e2e.schema');
const EPOCH_LENGTH = 1000;
const DISPUTE_WINDOW = 100;
const RESPONSE_WINDOW = 100;

const tools = ['anvil', 'forge'].every((t) => spawnSync('which', [t]).status === 0);
const enabled = !!process.env.DRIFT_E2E_ANVIL && tools;

const port = 18545 + Math.floor(Math.random() * 1000);
const rpc = `http://127.0.0.1:${port}`;
const tag = `e2e-${process.pid}-${port}`;
let anvil: ChildProcess | undefined;
let provider: JsonRpcProvider;
const written: string[] = [];

const wallet = (i: number) =>
  HDNodeWallet.fromMnemonic(Mnemonic.fromPhrase(MNEMONIC), `m/44'/60'/0'/0/${i}`);
// Index 0 admin, 1 Tier 1 settler, 2 relayer, 3-5 nodes, 6-8 Safe owners.
const signer = (i: number): Signer => new NonceManager(wallet(i).connect(provider));

function forge(script: string, env: Record<string, string>): void {
  const r = spawnSync('forge', ['script', script, '--rpc-url', rpc, '--broadcast', '--slow'], {
    cwd: CONTRACTS,
    env: { ...process.env, MNEMONIC, DRIFT_DEPLOYMENT_FILE: `${tag}.json`, ...env },
    encoding: 'utf8'
  });
  if (r.status !== 0) throw new Error(`forge script ${script} failed:\n${r.stdout}\n${r.stderr}`);
}

const readJson = (name: string) => JSON.parse(readFileSync(`${CONTRACTS}/deployments/${name}`, 'utf8'));

async function rpcCall(method: string, params: unknown[]): Promise<unknown> {
  return provider.send(method, params);
}

async function advance(seconds: number): Promise<void> {
  await rpcCall('evm_increaseTime', [seconds]);
  await rpcCall('evm_mine', []);
}

function setupContext(name: string, settler: string, nodeOffset: number): { contextUID: string; client: string } {
  const out = `${tag}-${name}.json`;
  written.push(out);
  forge('script/E2EContext.s.sol:E2EContextScript', {
    CONTEXT_NAME: `${name}.${tag}`,
    SETTLER: settler,
    CONTEXT_OUT: out,
    NODE_OFFSET: String(nodeOffset),
    NODE_COUNT: '3',
    EPOCH_LENGTH: String(EPOCH_LENGTH),
    DISPUTE_WINDOW: String(DISPUTE_WINDOW),
    RESPONSE_WINDOW: String(RESPONSE_WINDOW)
  });
  return readJson(out);
}

/** Attestations between the three nodes, dated after they joined and before the boundary. */
function attestationsFor(nodes: string[], at: number): IAttestationProvider {
  const enc = (v: number) => AbiCoder.defaultAbiCoder().encode(['uint256'], [v]);
  const records: AttestationRecord[] = [
    [0, 1, 50],
    [1, 2, 30],
    [2, 0, 20],
    [0, 2, 10]
  ].map(([a, s, v], i) => ({
    uid: keccak256(AbiCoder.defaultAbiCoder().encode(['string', 'uint256'], [nodes.join(), i])),
    schemaUID: SCHEMA,
    attester: nodes[a!]!,
    subject: nodes[s!]!,
    timestamp: at,
    revoked: false,
    data: enc(v!)
  }));
  return {
    fetchUserRecords: async () => [],
    fetchAllContextRecords: async (_c, asOf) => records.filter((r) => asOf === undefined || r.timestamp <= asOf)
  };
}

function memoryTransport(): ITreeTransport {
  const trees = new Map<string, EpochTree>();
  return {
    uploadTree: async (tree) => {
      const uri = `mem://${tree.root}`;
      trees.set(uri, tree);
      return uri;
    },
    fetchTree: async (uri, expected) => {
      const t = trees.get(uri);
      if (!t) throw new Error(`${uri} not found`);
      return checkEpochTree(t, expected);
    }
  };
}

async function latestTimestamp(): Promise<number> {
  return (await provider.getBlock('latest'))!.timestamp;
}

/** Waits past the dispute window, then claims every member's leaf from the resolved tree. */
async function claimAll(client: string, nodes: string[], transport: ITreeTransport, claimer: Signer): Promise<void> {
  await advance(DISPUTE_WINDOW + 1);
  const { tree } = await resolveEpochTree(provider, client, 1n, transport);
  const reputation = new ReputationModule(claimer);
  const deployment = readJson(`${tag}.json`);
  const token = new Contract(deployment.DRIFTToken, ['function balanceOf(address, uint256) view returns (uint256)'], provider);
  const contextUID = await new Contract(client, ['function contextUID() view returns (bytes32)'], provider).contextUID!();
  const tokenId = BigInt(keccak256(AbiCoder.defaultAbiCoder().encode(['bytes32', 'bytes32'], [contextUID, ROLE])));
  for (const node of nodes) {
    const [leaf] = findLeaves(tree, node, ROLE);
    expect(leaf).toBeDefined();
    const score = BigInt(leaf!.value[3]!);
    await reputation.claimReputation(client, node, ROLE, score, 1n, leaf!.proof);
    expect(await token.balanceOf!(node, tokenId)).toBe(score);
  }
}

async function epochRoot(client: string): Promise<string> {
  return new Contract(client, ['function epochRoots(uint256) view returns (bytes32)'], provider).epochRoots!(1n);
}

describe.skipIf(!enabled)('settlement pipeline on anvil', () => {
  beforeAll(async () => {
    anvil = spawn('anvil', ['--port', String(port), '--mnemonic', MNEMONIC, '--accounts', '12', '--silent'], { stdio: 'ignore' });
    process.once('exit', () => anvil?.kill('SIGKILL'));
    // cacheTimeout -1: ethers otherwise serves repeated reads (such as the 'latest' block) from a
    // 250 ms cache, which hides the evm_increaseTime/evm_mine the test has just done.
    provider = new JsonRpcProvider(rpc, 31337, { pollingInterval: 50, cacheTimeout: -1, staticNetwork: true });
    for (let i = 0; i < 100; i++) {
      try {
        await provider.getBlockNumber();
        break;
      } catch {
        await new Promise((r) => setTimeout(r, 100));
      }
    }
    mkdirSync(`${CONTRACTS}/deployments`, { recursive: true });
    written.push(`${tag}.json`);
    forge('script/Deploy.s.sol:DeployScript', {});

    for (const [name, address] of [
      ['Safe', SAFE_V141.singleton],
      ['SafeProxyFactory', SAFE_V141.proxyFactory],
      ['MultiSend', SAFE_V141.multiSend],
      ['CompatibilityFallbackHandler', SAFE_V141.compatibilityFallbackHandler],
      ['SignMessageLib', SAFE_V141.signMessageLib]
    ] as const) {
      await rpcCall('anvil_setCode', [address, readFileSync(`${FIXTURES}/${name}.hex`, 'utf8').trim()]);
    }
  }, 300_000);

  afterAll(() => {
    provider?.destroy();
    anvil?.kill('SIGKILL');
    // forge also leaves its usual run logs under broadcast/ (gitignored); those are kept.
    for (const f of written) rmSync(`${CONTRACTS}/deployments/${f}`, { recursive: true, force: true });
  });

  it('Tier 1: snapshot, settle with the EOA settler, claim from the resolved tree', async () => {
    const nodes = [3, 4, 5].map((i) => wallet(i).address.toLowerCase());
    const { client } = setupContext('tier1', wallet(1).address, 3);
    const attestations = attestationsFor(nodes, (await latestTimestamp()) + 1);
    await advance(EPOCH_LENGTH + 1);

    const snapshot = await loadEpochSnapshot({ provider, client, epoch: 1n, attestations, schemaUID: SCHEMA, blockTag: 'latest' });
    expect(snapshot.input.records).toHaveLength(4);
    expect(snapshot.input.members).toHaveLength(3);

    const transport = memoryTransport();
    const r = await settleEpochTier1({
      settler: new DriftSettler(wallet(1).connect(provider)),
      client,
      snapshot,
      engine: new LocalEpochEngine(),
      transport
    });
    expect(await epochRoot(client)).toBe(r.root);
    await claimAll(client, nodes, transport, signer(2));
  }, 120_000);

  it('Tier 2: a 2-of-3 Safe settles the majority root over commit-reveal; the dissenting owner cannot sign', async () => {
    const owners = [6, 7, 8].map((i) => wallet(i).connect(provider));
    const factory = new Contract(
      SAFE_V141.proxyFactory,
      ['function createProxyWithNonce(address singleton, bytes initializer, uint256 saltNonce) returns (address)'],
      signer(0)
    );
    const setup = new Contract(SAFE_V141.singleton, [
      'function setup(address[] owners, uint256 threshold, address to, bytes data, address fallbackHandler, address paymentToken, uint256 payment, address paymentReceiver)'
    ]).interface.encodeFunctionData('setup', [
      owners.map((o) => o.address),
      2,
      '0x' + '00'.repeat(20),
      '0x',
      SAFE_V141.compatibilityFallbackHandler,
      '0x' + '00'.repeat(20),
      0,
      '0x' + '00'.repeat(20)
    ]);
    const safe = (await factory.createProxyWithNonce!.staticCall(SAFE_V141.singleton, setup, port)) as string;
    await (await factory.createProxyWithNonce!(SAFE_V141.singleton, setup, port)).wait();
    await rpcCall('anvil_setBalance', [safe, '0xde0b6b3a7640000']);

    const nodes = [9, 10, 11].map((i) => wallet(i).address.toLowerCase());
    const { client } = setupContext('tier2', safe, 9);
    const attestations = attestationsFor(nodes, (await latestTimestamp()) + 1);
    await advance(EPOCH_LENGTH + 1);

    const dir = `${CONTRACTS}/deployments/${tag}-relay`;
    written.push(`${tag}-relay`);
    const relay = new FileSettlementRelay(dir);
    const safeSettler = new SafeSettler(provider, safe, client);
    let t = Math.floor(Date.now() / 1000);
    const base = { safeSettler, relay, now: () => t };
    const snapshotParams: Omit<EpochSnapshotParams, 'client' | 'epoch'> = { provider, attestations, schemaUID: SCHEMA, blockTag: 'latest' };
    const honest: OwnerCompute = { snapshot: snapshotParams, engine: new LocalEpochEngine() };
    const skewed: IEpochEngine = {
      computeEpoch: (input) => new LocalEpochEngine().computeEpoch({ ...input, records: input.records.slice(1) })
    };
    const computeFor = [honest, { snapshot: snapshotParams, engine: skewed }, honest];
    const transport = memoryTransport();

    const { proposalId } = await proposeEpochTier2({ ...base, proposer: owners[0]!, epoch: 1n, commitWindow: 5, revealWindow: 5 });
    for (const [i, o] of owners.entries()) {
      expect((await commitEpochTier2({ ...base, owner: o, proposalId, compute: computeFor[i]! })).status).toBe('done');
    }
    t += 6;
    for (const [i, o] of owners.entries()) {
      expect((await revealEpochTier2({ ...base, owner: o, proposalId, compute: computeFor[i]! })).status).toBe('done');
    }
    t += 5;
    const pub = await publishEpochTreeTier2({ ...base, owner: owners[2]!, proposalId, compute: honest, transport });
    expect(pub.status).toBe('done');

    await expect(signEpochTier2({ ...base, owner: owners[1]!, proposalId, transport })).rejects.toThrow(/no valid reveal/);
    expect((await signEpochTier2({ ...base, owner: owners[0]!, proposalId, transport })).status).toBe('done');
    expect((await signEpochTier2({ ...base, owner: owners[2]!, proposalId, transport })).status).toBe('done');

    expect((await executeEpochTier2({ ...base, sender: signer(2), proposalId })).status).toBe('done');
    expect(await epochRoot(client)).toBe(pub.settlement!.root);
    expect((await executeEpochTier2({ ...base, sender: signer(2), proposalId })).status).toBe('already-done');

    await claimAll(client, nodes, transport, signer(2));
  }, 120_000);
});

// Opt-in end-to-end test of the operator daemon on anvil, against the real DRIFT contracts and the
// real Safe v1.4.1 bytecode. Every honest operator runs as a real `drift-operator run` child
// process, with a generated config file and keys in its environment, so the CLI, config
// validation, key loading, the reconcile loop and the HTTP API are all exercised. Only the
// misbehaving settler of the watcher scenario runs in-process: it is the adversary, posting a root
// through the pipeline with an engine that drops a member.
//
// External services are stubbed by small HTTP servers in this process: an EAS GraphQL endpoint
// serving fixed attestations, and a Kubo-compatible IPFS API and gateway.
//
// Run: DRIFT_E2E_ANVIL=1 npx vitest run daemon-anvil   (needs anvil and forge on PATH; builds the
// SDK and this package first, since the daemons run from dist/).
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { createServer, type Server } from 'node:http';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, createWriteStream } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { AbiCoder, Contract, HDNodeWallet, JsonRpcProvider, Mnemonic, NonceManager, id, keccak256, toUtf8Bytes, type Signer } from 'ethers';
import { StandardMerkleTree } from '@openzeppelin/merkle-tree';
import { DriftSettler, ReputationModule } from '@drift-network/sdk';
import { LocalEpochEngine, type IEpochEngine } from '@drift-network/sdk/engines';
import { EPOCH_LEAF_ENCODING, IPFSTreeTransport } from '@drift-network/sdk/merkle';
import { EASProvider } from '@drift-network/sdk/providers';
import { SAFE_V141 } from '../../src/safe/SafeSettler.js';
import { loadEpochSnapshot } from '../../src/pipeline/snapshot.js';
import { settleEpochTier1 } from '../../src/pipeline/tier1.js';
import { tier2ProposalId } from '../../src/pipeline/commitments.js';
import { HttpSettlementRelay } from '../../src/relay/http.js';
import { validateEvent, type RecorderEvent, type TxInfo } from '../../src/recorder/events.js';
import { readdirSync } from 'node:fs';

const OPERATOR = fileURLToPath(new URL('../..', import.meta.url));
const REPO = fileURLToPath(new URL('../../../..', import.meta.url));
const CONTRACTS = `${REPO}/packages/contracts`;
const FIXTURES = `${CONTRACTS}/test/fixtures/safe-v1.4.1`;
const BIN = `${OPERATOR}/dist/bin.js`;
const MNEMONIC = 'test test test test test test test test test test test junk';
const ROLE = id('MEMBER').toLowerCase();
const SCHEMA = id('drift.daemon.e2e.schema');
const EPOCH_LENGTH = 1000;
const DISPUTE_WINDOW = 100;
const RESPONSE_WINDOW = 100;

const tools = ['anvil', 'forge', 'npm'].every((t) => spawnSync('which', [t]).status === 0);
const enabled = !!process.env.DRIFT_E2E_ANVIL && tools;

const basePort = 20000 + Math.floor(Math.random() * 20000);
const rpcPort = basePort;
const rpc = `http://127.0.0.1:${rpcPort}`;
const tag = `daemon-e2e-${process.pid}-${rpcPort}`;
let work: string;
let anvil: ChildProcess | undefined;
let provider: JsonRpcProvider;
const deployments: string[] = [];
const daemons: { name: string; proc: ChildProcess; log: string }[] = [];
const servers: Server[] = [];

// Index 0 admin; 1 settler and 2 hot wallet (Tier 1); 3-5 Tier 1 nodes; 6-8 Safe owners;
// 9-11 Tier 2 nodes; 12-14 owner hot wallets; 15 misbehaving settler; 16-18 watcher nodes, 18
// doubling as the watcher's hot wallet so its challenge is a self-challenge.
const wallet = (i: number) => HDNodeWallet.fromMnemonic(Mnemonic.fromPhrase(MNEMONIC), `m/44'/60'/0'/0/${i}`);
const signer = (i: number): Signer => new NonceManager(wallet(i).connect(provider));
const nodesAt = (offset: number) => [0, 1, 2].map((k) => wallet(offset + k).address.toLowerCase());

function forge(script: string, env: Record<string, string>): void {
  const r = spawnSync('forge', ['script', script, '--rpc-url', rpc, '--broadcast', '--slow'], {
    cwd: CONTRACTS,
    env: { ...process.env, MNEMONIC, DRIFT_DEPLOYMENT_FILE: `${tag}.json`, ...env },
    encoding: 'utf8'
  });
  if (r.status !== 0) throw new Error(`forge script ${script} failed:\n${r.stdout}\n${r.stderr}`);
}

const readDeployment = (name: string) => JSON.parse(readFileSync(`${CONTRACTS}/deployments/${name}`, 'utf8'));

async function advance(seconds: number): Promise<void> {
  await provider.send('evm_increaseTime', [seconds]);
  await provider.send('evm_mine', []);
}
const latest = async () => (await provider.getBlock('latest'))!.timestamp;

function setupContext(name: string, settler: string, nodeOffset: number): { contextUID: string; client: string } {
  const out = `${tag}-${name}.json`;
  deployments.push(out);
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
  return readDeployment(out);
}

// STUB SERVICES ===============================================================

interface StubAttestation {
  id: string;
  schemaId: string;
  attester: string;
  recipient: string;
  timeCreated: number;
  revocationTime: number;
  data: string;
}
const attestations: StubAttestation[] = [];

/** Four attestations among three nodes, dated `at`, under SCHEMA. */
function attest(nodes: string[], at: number): void {
  const enc = (v: number) => AbiCoder.defaultAbiCoder().encode(['uint256'], [v]);
  for (const [i, [a, s, v]] of ([[0, 1, 50], [1, 2, 30], [2, 0, 20], [0, 2, 10]] as const).entries()) {
    attestations.push({
      id: keccak256(toUtf8Bytes(`${nodes.join()}-${i}`)),
      schemaId: SCHEMA,
      attester: nodes[a]!,
      recipient: nodes[s]!,
      timeCreated: at,
      revocationTime: 0,
      data: enc(v)
    });
  }
}

const readBody = (req: import('node:http').IncomingMessage) =>
  new Promise<Buffer>((resolve) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks)));
  });

async function listen(server: Server, port: number): Promise<string> {
  servers.push(server);
  await new Promise<void>((r) => server.listen(port, '127.0.0.1', r));
  return `http://127.0.0.1:${port}`;
}

/** The subset of the EAS GraphQL API that EASProvider queries. */
function easStub(): Server {
  return createServer((req, res) => {
    void readBody(req).then((raw) => {
      const { variables: v } = JSON.parse(raw.toString()) as { variables: { schema: string; asOf?: number; take: number; skip: number } };
      const rows = attestations.filter((a) => a.schemaId === v.schema && (v.asOf === undefined || a.timeCreated <= v.asOf));
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ data: { attestations: rows.slice(v.skip, v.skip + v.take) } }));
    });
  });
}

/** Kubo's /api/v0/add and /api/v0/pin/add plus a gateway, content-addressed by keccak256. */
function ipfsStub(): { server: Server; pinned: Set<string> } {
  const blobs = new Map<string, Buffer>();
  const pinned = new Set<string>();
  const server = createServer((req, res) => {
    const url = new URL(req.url!, 'http://x');
    if (req.method === 'POST' && url.pathname === '/api/v0/add') {
      void readBody(req).then((raw) => {
        const boundary = /boundary=(.+)$/.exec(req.headers['content-type'] ?? '')![1]!;
        const part = raw.toString('latin1').split(`--${boundary}`)[1]!;
        const content = Buffer.from(part.slice(part.indexOf('\r\n\r\n') + 4, part.lastIndexOf('\r\n')), 'latin1');
        const cid = 'bafk' + keccak256(content).slice(2, 50);
        blobs.set(cid, content);
        res.end(JSON.stringify({ Hash: cid }));
      });
    } else if (req.method === 'POST' && url.pathname === '/api/v0/pin/add') {
      pinned.add(url.searchParams.get('arg')!);
      res.end('{}');
    } else if (req.method === 'GET' && url.pathname.startsWith('/ipfs/')) {
      const blob = blobs.get(url.pathname.slice('/ipfs/'.length));
      res.statusCode = blob ? 200 : 404;
      res.end(blob ?? 'not found');
    } else {
      res.statusCode = 404;
      res.end();
    }
  });
  return { server, pinned };
}

let easUrl: string;
let ipfsUrl: string;
let ipfs: ReturnType<typeof ipfsStub>;

// DAEMONS =====================================================================

interface DaemonSpec {
  name: string;
  apiPort?: number;
  serveRelay?: boolean;
  relay?: { kind: 'file'; dir: string } | { kind: 'http'; url: string };
  keys: { settler?: number; hotWallet?: number; owner?: number };
  context: Record<string, unknown>;
}

/** Starts `drift-operator run` with a generated config; keys go only into its environment. */
function startDaemon(s: DaemonSpec): string | undefined {
  const dir = join(work, s.name);
  mkdirSync(dir, { recursive: true });
  const env: Record<string, string> = {};
  const keys: Record<string, { env: string }> = {};
  for (const [role, index] of Object.entries(s.keys)) {
    const name = `DRIFT_${s.name.toUpperCase().replace(/[^A-Z0-9]/g, '_')}_${role.toUpperCase()}_KEY`;
    env[name] = wallet(index).privateKey;
    keys[role] = { env: name };
  }
  const config = {
    rpcUrl: rpc,
    blockTag: 'latest',
    pollIntervalSeconds: 1,
    stateDir: dir,
    keys,
    attestations: { kind: 'eas', graphqlUrl: easUrl },
    trees: { kind: 'ipfs', apiUrl: ipfsUrl, gatewayUrl: ipfsUrl },
    relay: s.relay ?? { kind: 'file', dir: join(dir, 'relay') },
    api: s.apiPort ? { host: '127.0.0.1', port: s.apiPort, serveRelay: s.serveRelay ?? false } : undefined,
    recorder: { dir: join(work, 'events'), runId: tag, process: s.name },
    contexts: [{ name: s.name, schemaUID: SCHEMA, fromBlock: 0, ...s.context }]
  };
  const file = join(dir, 'operator.json');
  writeFileSync(file, JSON.stringify(config, null, 2));
  const log = join(dir, 'operator.log');
  const out = createWriteStream(log);
  const proc = spawn(process.execPath, [BIN, 'run', '--config', file], { env: { ...process.env, ...env, LOG_LEVEL: 'debug' } });
  proc.stdout.pipe(out);
  proc.stderr.pipe(out);
  daemons.push({ name: s.name, proc, log });
  return s.apiPort ? `http://127.0.0.1:${s.apiPort}` : undefined;
}

async function stopDaemon(name: string): Promise<void> {
  const d = daemons.find((x) => x.name === name);
  if (!d || d.proc.exitCode !== null) return;
  const exited = new Promise((r) => d.proc.once('exit', r));
  d.proc.kill('SIGTERM');
  await Promise.race([exited, new Promise((r) => setTimeout(r, 5000))]);
  if (d.proc.exitCode === null) d.proc.kill('SIGKILL');
}

/** Every event a daemon recorded, after checking each line against the schema. */
function eventsOf(name: string): RecorderEvent[] {
  const dir = join(work, 'events');
  const files = readdirSync(dir).filter((f) => f.startsWith(`${tag}.${name}.`));
  expect(files).toHaveLength(1);
  const events = readFileSync(join(dir, files[0]!), 'utf8').trim().split('\n').map((l) => JSON.parse(l) as RecorderEvent);
  for (const e of events) expect(validateEvent(e), JSON.stringify(e)).toEqual([]);
  expect(events.map((e) => e.seq)).toEqual(events.map((_, i) => i + 1));
  return events;
}
const typesOf = (events: RecorderEvent[]) => new Set(events.map((e) => e.type));
const mined = (events: RecorderEvent[], action: string) =>
  events.filter((e) => e.type === 'tx.mined' && e.action === action).map((e) => e.tx as TxInfo);

const tail = (name: string) => {
  const d = daemons.find((x) => x.name === name);
  return d ? readFileSync(d.log, 'utf8').split('\n').slice(-15).join('\n') : '';
};

/** Polls `fn` until it returns a truthy value. On timeout, shows the named daemons' last log lines. */
async function until<T>(what: string, fn: () => Promise<T | undefined | null | false>, timeoutMs: number, logs: string[] = []): Promise<T> {
  const end = Date.now() + timeoutMs;
  let lastErr: unknown;
  while (Date.now() < end) {
    try {
      const v = await fn();
      if (v) return v;
    } catch (err) {
      lastErr = err;
    }
    await new Promise((r) => setTimeout(r, 300));
  }
  throw new Error(`timed out waiting for ${what}${lastErr ? ` (last error: ${lastErr instanceof Error ? lastErr.message : JSON.stringify(lastErr)})` : ''}\n${logs.map((n) => `--- ${n}\n${tail(n)}`).join('\n')}`);
}

async function getJson<T>(url: string): Promise<T> {
  const res = await fetch(url);
  return (await res.json()) as T;
}

const clientContract = (client: string) =>
  new Contract(
    client,
    [
      'function epochRoots(uint256) view returns (bytes32)',
      'function epochBondAmount(uint256) view returns (uint256)',
      'function requiredChallengeBond() view returns (uint256)',
      'function challenges(uint256, address, bytes32) view returns (uint256 openedAtTimestamp, uint256 bond, address challenger, bool resolved)'
    ],
    provider
  );
const ZERO = '0x' + '00'.repeat(32);

// TESTS =======================================================================

describe.skipIf(!enabled)('operator daemon on anvil', () => {
  beforeAll(async () => {
    const build = spawnSync('npm', ['run', 'build', '-w', '@drift-network/sdk'], { cwd: REPO, encoding: 'utf8' });
    const buildOp = spawnSync('npm', ['run', 'build', '-w', '@drift-network/operator'], { cwd: REPO, encoding: 'utf8' });
    if (build.status !== 0 || buildOp.status !== 0) throw new Error(`build failed:\n${build.stderr}\n${buildOp.stderr}`);

    work = mkdtempSync(join(tmpdir(), 'drift-daemon-e2e-'));
    anvil = spawn('anvil', ['--port', String(rpcPort), '--mnemonic', MNEMONIC, '--accounts', '20', '--silent'], { stdio: 'ignore' });
    process.once('exit', () => {
      anvil?.kill('SIGKILL');
      for (const d of daemons) d.proc.kill('SIGKILL');
    });
    provider = new JsonRpcProvider(rpc, 31337, { pollingInterval: 50, cacheTimeout: -1, staticNetwork: true });
    await until('anvil', () => provider.getBlockNumber().then(() => true), 20_000);

    easUrl = await listen(easStub(), basePort + 1);
    ipfs = ipfsStub();
    ipfsUrl = await listen(ipfs.server, basePort + 2);

    mkdirSync(`${CONTRACTS}/deployments`, { recursive: true });
    deployments.push(`${tag}.json`);
    forge('script/Deploy.s.sol:DeployScript', {});
    for (const [name, address] of [
      ['Safe', SAFE_V141.singleton],
      ['SafeProxyFactory', SAFE_V141.proxyFactory],
      ['MultiSend', SAFE_V141.multiSend],
      ['CompatibilityFallbackHandler', SAFE_V141.compatibilityFallbackHandler],
      ['SignMessageLib', SAFE_V141.signMessageLib]
    ] as const) {
      await provider.send('anvil_setCode', [address, readFileSync(`${FIXTURES}/${name}.hex`, 'utf8').trim()]);
    }
  }, 600_000);

  afterAll(async () => {
    await Promise.all(daemons.map((d) => stopDaemon(d.name)));
    for (const s of servers) s.close();
    provider?.destroy();
    anvil?.kill('SIGKILL');
    for (const f of deployments) rmSync(`${CONTRACTS}/deployments/${f}`, { recursive: true, force: true });
    // DRIFT_E2E_KEEP_EVENTS=<dir> keeps the recorder logs (packages/e2e's analyze test reads them).
    const keep = process.env.DRIFT_E2E_KEEP_EVENTS;
    if (work && keep) cpSync(join(work, 'events'), keep, { recursive: true });
    if (work) rmSync(work, { recursive: true, force: true });
  });

  it('Tier 1: settles, answers a challenge automatically, and withdraws the bond', async () => {
    const nodes = nodesAt(3);
    const { client, contextUID } = setupContext('tier1', wallet(1).address, 3);
    attest(nodes, (await latest()) + 1);
    await advance(EPOCH_LENGTH + 1);

    const api = startDaemon({ name: 'settler', apiPort: basePort + 3, keys: { settler: 1, hotWallet: 2 }, context: { client, roles: ['tier1'] } })!;
    const c = clientContract(client);
    const root = await until('epoch 1 settled', async () => {
      const r = (await c.epochRoots!(1n)) as string;
      return r !== ZERO && r;
    }, 60_000, ['settler']);
    const status = await until('status shows the settlement', async () => {
      const s = await getJson<{ contexts: { lastSettled?: { epoch: string; root: string; treeURI: string }; pendingPayout?: string }[] }>(`${api}/status`);
      return s.contexts[0]!.lastSettled && s.contexts[0]!;
    }, 10_000, ['settler']);
    expect(status.lastSettled).toMatchObject({ epoch: '1', root });
    expect(ipfs.pinned.has(status.lastSettled!.treeURI.replace('ipfs://', ''))).toBe(true);

    // Proofs from the API verify against the committed root.
    const proofs = await getJson<{ matchesCommitted: boolean; leaves: { role: string; score: string; proof: string[] }[] }>(
      `${api}/contexts/${client}/epochs/1/proofs/${nodes[0]}`
    );
    expect(proofs, JSON.stringify(proofs)).toMatchObject({ matchesCommitted: true });
    expect(StandardMerkleTree.verify(root, EPOCH_LEAF_ENCODING, [contextUID.toLowerCase(), nodes[0]!, ROLE, proofs.leaves[0]!.score, '1'], proofs.leaves[0]!.proof)).toBe(true);

    // A node challenges its own (included) pair; the daemon answers from its tree store.
    const bond = (await c.requiredChallengeBond!()) as bigint;
    await new ReputationModule(signer(3)).challengeOmission(client, 1n, nodes[0]!, ROLE, bond * 2n);
    await until('challenge answered', async () => ((await c.challenges!(1n, nodes[0]!, ROLE)) as [bigint, bigint, string, boolean])[3], 30_000, ['settler']);

    // After the dispute window the epoch finalizes and the daemon withdraws the bond.
    expect((await c.epochBondAmount!(1n)) as bigint).toBeGreaterThan(0n);
    await advance(DISPUTE_WINDOW + 1);
    await until('bond withdrawn', async () => ((await c.epochBondAmount!(1n)) as bigint) === 0n, 30_000, ['settler']);
    const epoch = await getJson<{ finalized: boolean; treeURI: string }>(`${api}/contexts/settler/epochs/1`);
    expect(epoch).toMatchObject({ finalized: true, treeURI: status.lastSettled!.treeURI });
    expect((await getJson<{ ready: boolean }>(`${api}/ready`)).ready).toBe(true);
    const metrics = await (await fetch(`${api}/metrics`)).text();
    expect(metrics).toMatch(/drift_gas_used_total\{action="settle\.post",tier="tier1"\} [1-9]/);
    await stopDaemon('settler');

    // The event log tells the whole story, with real receipts.
    const events = eventsOf('settler');
    for (const t of [
      'epoch.due',
      'o1.checked',
      'snapshot.done',
      'root.computed',
      'tree.uploaded',
      'tree.pinned',
      'tx.sent',
      'settle.posted',
      'epoch.posted',
      'challenge.detected',
      'challenge.answered',
      'epoch.finalized',
      'bond.withdrawn'
    ] as const) {
      expect(typesOf(events), t).toContain(t);
    }
    const [post] = mined(events, 'settle.post');
    expect(post).toMatchObject({ status: 1 });
    expect(BigInt(post!.gasUsed)).toBeGreaterThan(100_000n);
    expect(BigInt(post!.feeWei)).toBe(BigInt(post!.gasUsed) * BigInt(post!.effectiveGasPrice));
    expect(mined(events, 'challenge.respond')).toHaveLength(1);
    expect(mined(events, 'bond.withdraw')).toHaveLength(1);
    expect(events.find((e) => e.type === 'snapshot.done')).toMatchObject({ records: 4, members: 3, epoch: '1', tier: 'tier1', context: 'settler' });
  }, 240_000);

  it('Tier 2: three owner daemons over the HTTP relay; round 0 dies, round 1 settles through the Safe', async () => {
    const factory = new Contract(
      SAFE_V141.proxyFactory,
      ['function createProxyWithNonce(address singleton, bytes initializer, uint256 saltNonce) returns (address)'],
      signer(0)
    );
    const owners = [6, 7, 8].map((i) => wallet(i).address);
    const setup = new Contract(SAFE_V141.singleton, [
      'function setup(address[] owners, uint256 threshold, address to, bytes data, address fallbackHandler, address paymentToken, uint256 payment, address paymentReceiver)'
    ]).interface.encodeFunctionData('setup', [owners, 2, '0x' + '00'.repeat(20), '0x', SAFE_V141.compatibilityFallbackHandler, '0x' + '00'.repeat(20), 0, '0x' + '00'.repeat(20)]);
    const safe = (await factory.createProxyWithNonce!.staticCall(SAFE_V141.singleton, setup, rpcPort)) as string;
    await (await factory.createProxyWithNonce!(SAFE_V141.singleton, setup, rpcPort)).wait();
    await provider.send('anvil_setBalance', [safe, '0xde0b6b3a7640000']);

    const nodes = nodesAt(9);
    const { client, contextUID } = setupContext('tier2', safe, 9);
    attest(nodes, (await latest()) + 1);
    await advance(EPOCH_LENGTH + 1);

    const COMMIT = 8;
    const REVEAL = 6;
    const tier2 = { safe, commitWindowSeconds: COMMIT, revealWindowSeconds: REVEAL, maxRounds: 3 };
    const context = { client, roles: ['tier2-owner'], tier2 };
    const relayApi = startDaemon({ name: 'owner-a', apiPort: basePort + 4, serveRelay: true, keys: { owner: 6, hotWallet: 12 }, context })!;

    // Owner A alone: proposes round 0 and commits. Nobody else commits in time, so round 0 dies.
    await until('owner A committed to round 0', async () => {
      const s = await getJson<{ contexts: { tier2?: { round: string; steps: { commit: string } } }[] }>(`${relayApi}/status`);
      const t = s.contexts[0]!.tier2;
      return t?.round === '0' && ['done', 'already-done'].includes(t.steps.commit);
    }, 60_000, ['owner-a']);
    await new Promise((r) => setTimeout(r, (COMMIT + 1) * 1000));

    // Owners B and C join through A's relay (signed writes) during round 0's reveal window.
    const relay = { kind: 'http' as const, url: relayApi };
    startDaemon({ name: 'owner-b', relay, keys: { owner: 7, hotWallet: 13 }, context });
    startDaemon({ name: 'owner-c', relay, keys: { owner: 8, hotWallet: 14 }, context });

    const c = clientContract(client);
    const root = await until('epoch 1 settled through the Safe', async () => {
      const r = (await c.epochRoots!(1n)) as string;
      return r !== ZERO && r;
    }, 120_000, ['owner-a', 'owner-b', 'owner-c']);

    const reader = new HttpSettlementRelay(relayApi);
    const pid = (round: bigint) => tier2ProposalId(client, contextUID, 1n, 0n, round);
    expect(await reader.getProposal(pid(0n))).not.toBeNull();
    expect(await reader.getSettlement(pid(0n))).toBeNull();
    expect((await reader.listCommitments(pid(0n))).length).toBe(1);
    const settlement = await reader.getSettlement(pid(1n));
    expect(settlement?.root.toLowerCase()).toBe(root.toLowerCase());
    expect((await reader.listCommitments(pid(1n))).length).toBe(3);
    expect((await reader.listSignatures(pid(1n))).length).toBeGreaterThanOrEqual(2);

    // Owners record the settlement when a tick first sees the root on chain.
    await until('an owner recorded the settlement', async () =>
      ['owner-a', 'owner-b', 'owner-c'].some((n) => readFileSync(join(work, 'events', readdirSync(join(work, 'events')).find((f) => f.startsWith(`${tag}.${n}.`))!), 'utf8').includes('"settle.posted"')), 20_000);
    await Promise.all(['owner-a', 'owner-b', 'owner-c'].map(stopDaemon));

    const a = eventsOf('owner-a');
    const all = [a, eventsOf('owner-b'), eventsOf('owner-c')].flat();
    expect(a.filter((e) => e.type === 'tier2.proposed').map((e) => e.round)).toContain('0');
    // Whichever owner ticked first after round 0's reveal deadline recorded its outcome.
    expect(all.find((e) => e.type === 'tier2.round_outcome' && e.round === '0')).toMatchObject({ outcome: 'dead' });
    expect(all.filter((e) => e.type === 'tier2.committed' && e.round === '1')).toHaveLength(3);
    // Owners may race to publish; a second, identical write is a no-op success, so each records it.
    const published = all.filter((e) => e.type === 'tier2.published' && e.round === '1');
    expect(published.length).toBeGreaterThanOrEqual(1);
    expect(new Set(published.map((e) => `${e.root as string}|${e.treeURI as string}`)).size).toBe(1);
    expect(all.filter((e) => e.type === 'tier2.signed' && e.round === '1').length).toBeGreaterThanOrEqual(2);
    const executes = all.flatMap((e) => (e.type === 'tx.mined' && e.action === 'tier2.execute' ? [e.tx as TxInfo] : []));
    expect(executes.filter((t) => t.status === 1)).toHaveLength(1);
    expect(all.some((e) => e.type === 'settle.posted' && (e.root as string).toLowerCase() === root.toLowerCase())).toBe(true);
  }, 300_000);

  it('Watcher: detects an omitting root, challenges it, and the omission is claimable', async () => {
    const nodes = nodesAt(16);
    const omitted = nodes[2]!;
    const { client } = setupContext('watched', wallet(15).address, 16);
    attest(nodes, (await latest()) + 1);
    await advance(EPOCH_LENGTH + 1);

    // The misbehaving settler (in-process) posts a root that drops one member.
    const dropping: IEpochEngine = {
      computeEpoch: (input) => new LocalEpochEngine().computeEpoch({ ...input, members: input.members.filter((m) => m.node !== omitted) })
    };
    const snapshot = await loadEpochSnapshot({
      provider,
      client,
      epoch: 1n,
      attestations: new EASProvider(easUrl, SCHEMA),
      schemaUID: SCHEMA,
      blockTag: 'latest'
    });
    const bad = await settleEpochTier1({
      settler: new DriftSettler(wallet(15).connect(provider)),
      client,
      snapshot,
      engine: dropping,
      transport: new IPFSTreeTransport({ apiUrl: ipfsUrl, gatewayUrl: ipfsUrl })
    });

    // The watcher's hot wallet is the omitted node itself: a self-challenge needs no standing.
    const api = startDaemon({
      name: 'watcher',
      apiPort: basePort + 5,
      keys: { hotWallet: 18 },
      context: { client, roles: ['watcher'], watcher: { challenge: true } }
    })!;
    const c = clientContract(client);
    await until('watcher opened a challenge', async () => ((await c.challenges!(1n, omitted, ROLE)) as [bigint])[0] > 0n, 60_000, ['watcher']);
    const status = await getJson<{ contexts: { watch: { agrees: boolean; postedRoot: string; ourRoot: string; omitted: { node: string }[]; challenged: { node: string } } }[] }>(`${api}/status`);
    expect(status.contexts[0]!.watch).toMatchObject({ agrees: false, postedRoot: bad.root.toLowerCase(), challenged: { node: omitted } });
    expect(status.contexts[0]!.watch.omitted.map((p) => p.node)).toEqual([omitted]);
    expect(status.contexts[0]!.watch.ourRoot).not.toBe(bad.root.toLowerCase());

    // Nobody answers; after the response window the omission is claimable and the root rolls back.
    await advance(RESPONSE_WINDOW + 1);
    await new ReputationModule(signer(0)).claimUnansweredChallenge(client, 1n, omitted, ROLE);
    expect((await c.epochRoots!(1n)) as string).toBe(ZERO);
    await stopDaemon('watcher');

    const w = eventsOf('watcher');
    for (const t of ['watch.root_seen', 'watch.recomputed', 'watch.divergence', 'watch.challenge_opened'] as const) expect(typesOf(w), t).toContain(t);
    expect(w.find((e) => e.type === 'watch.divergence')).toMatchObject({ omitted: 1, tier: 'watcher' });
    expect(mined(w, 'challenge.open')).toHaveLength(1);
  }, 240_000);

  it('leaves no daemon or anvil process behind', async () => {
    await Promise.all(daemons.map((d) => stopDaemon(d.name)));
    expect(daemons.every((d) => d.proc.exitCode !== null || d.proc.signalCode !== null)).toBe(true);
  });
});

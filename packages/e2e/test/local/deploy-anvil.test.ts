// Opt-in (DRIFT_E2E_ANVIL=1, needs anvil and forge): `deploy` on a plain anvil with the real Safe
// v1.4.1 and EAS bytecode etched at their canonical addresses. Covers a full deployment, a re-run
// that sends nothing, and two simulated crashes (after a broadcast, and after saving a signed
// transaction but before broadcasting it), each resumed without any duplicate transaction.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { copyFileSync, existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Contract, JsonRpcProvider, getAddress, parseEther, toBeHex } from 'ethers';
import { SAFE_V141 } from '@drift-network/operator';
import { main } from '../../src/cli.js';
import { parseExperimentConfig } from '../../src/config.js';
import { deriveSlots, newMnemonic, slotIndices } from '../../src/keys.js';
import { deployExperiment, readManifest, MEMBER_ROLE, SimulatedCrash, type DeployManifest } from '../../src/setup.js';
import { baseConfig } from './fixtures.js';

const enabled = !!process.env.DRIFT_E2E_ANVIL && ['anvil', 'forge'].every((t) => spawnSync('which', [t]).status === 0);
const port = 22545 + Math.floor(Math.random() * 1000);
const url = `http://127.0.0.1:${port}`;
const CONTRACTS = fileURLToPath(new URL('../../../contracts', import.meta.url));
const SAFE_FIXTURES = `${CONTRACTS}/test/fixtures/safe-v1.4.1`;
const EAS_FIXTURES = fileURLToPath(new URL('../fixtures/eas-sepolia', import.meta.url));
/** Transactions Deploy.s.sol sends from the deployer (core impl, proxy, token, setDriftToken, factory, grantRole, template). */
const FORGE_TXS = 7;

const CORE = ['function isRegistered(bytes32,address) view returns (bool)', 'function hasNodeRole(bytes32,address,bytes32) view returns (bool)'];
const SAFE_ABI = ['function getOwners() view returns (address[])', 'function getThreshold() view returns (uint256)'];
const REGISTRY = ['function getSchema(bytes32) view returns (tuple(bytes32 uid, address resolver, bool revocable, string schema))'];

interface StepRecord { status: string; tx?: string; from?: string }

describe.skipIf(!enabled)('deploy on anvil', () => {
  let anvil: ChildProcess;
  const dirs: string[] = [];
  const provider = new JsonRpcProvider(url, 31337, { staticNetwork: true, cacheTimeout: -1, pollingInterval: 50 });
  const broadcastDir = `${CONTRACTS}/broadcast/Deploy.s.sol/31337`;
  const runLatest = `${broadcastDir}/run-latest.json`;
  const backup = `${runLatest}.deploy-test-backup`;
  const runsBefore = new Set<string>();
  const deploymentFiles: string[] = [];

  const experiment = (runTag: string) =>
    baseConfig({
      runTag,
      nodes: 4,
      attestations: { perNodePerRound: 1, rounds: 1 },
      tier1: { epochs: 2 },
      tier2: { epochs: 2, owners: 3, threshold: 2 },
      adversarial: { omissionChallenges: 0, answeredChallenges: 0, watcherChallenges: 1, deadRounds: 0 },
      claims: { perEpoch: 0 },
      governance: { proposals: 0, votersPerProposal: 0 },
      gas: { maxFeeGwei: '50', priorityFeeGwei: '1' },
      timing: { epochLengthSeconds: 1000, disputeWindowSeconds: 100, responseWindowSeconds: 100 }
    });

  /** A fresh mnemonic with every experiment key funded on anvil. */
  async function fundedMnemonic(raw: Record<string, unknown>): Promise<string> {
    const mnemonic = newMnemonic();
    for (const s of deriveSlots(mnemonic, slotIndices(parseExperimentConfig(raw)))) {
      await provider.send('anvil_setBalance', [s.address, toBeHex(parseEther('10'))]);
    }
    return mnemonic;
  }

  /** Every sender's nonce equals the distinct transactions the state records for it, all successful. */
  async function assertNoDuplicates(stateDir: string, deployer: string): Promise<void> {
    const state = JSON.parse(readFileSync(join(stateDir, 'deploy-state.json'), 'utf8')) as { steps: Record<string, StepRecord> };
    const txs = Object.values(state.steps).filter((s) => s.tx);
    expect(new Set(txs.map((s) => s.tx)).size).toBe(txs.length);
    expect(Object.values(state.steps).every((s) => s.status === 'done')).toBe(true);
    const bySender = new Map<string, number>();
    for (const s of txs) {
      bySender.set(getAddress(s.from!), (bySender.get(getAddress(s.from!)) ?? 0) + 1);
      expect((await provider.getTransactionReceipt(s.tx!))?.status).toBe(1);
    }
    for (const [sender, n] of bySender) {
      const expected = sender === getAddress(deployer) ? n + FORGE_TXS : n;
      expect(await provider.getTransactionCount(sender), `nonce of ${sender}`).toBe(expected);
    }
  }

  /** The manifest describes a deployment that is fully set up on chain. */
  async function assertDeployed(m: DeployManifest): Promise<void> {
    expect(Object.keys(m.contexts).sort()).toEqual(['tier1', 'tier2']);
    expect(m.contexts.tier2!.trustedSettler).toBe(m.safe!.address);
    const safe = new Contract(m.safe!.address, SAFE_ABI, provider);
    expect((await safe.getOwners!()) as string[]).toHaveLength(3);
    expect(await safe.getThreshold!()).toBe(2n);
    expect(await provider.getBalance(m.safe!.address)).toBe(parseEther('0.002'));
    expect(((await new Contract(m.eas.schemaRegistry, REGISTRY, provider).getSchema!(m.eas.schemaUID)) as { schema: string }).schema).toBe(m.eas.schema);
    const core = new Contract(m.contracts.DRIFTCore, CORE, provider);
    for (const tier of ['tier1', 'tier2'] as const) {
      const c = m.contexts[tier]!;
      expect(c.epochLength).toBe(1000);
      expect(c.disputeWindow).toBe(100);
      expect(c.epochAnchorTimestamp).toBeGreaterThan(0);
      for (const n of m.nodes) {
        expect(await core.isRegistered!(c.contextUID, n)).toBe(true);
        expect(await core.hasNodeRole!(c.contextUID, n, MEMBER_ROLE)).toBe(true);
      }
    }
    expect(await core.hasNodeRole!(m.contexts.tier1!.contextUID, m.watcher, MEMBER_ROLE)).toBe(true);
  }

  beforeAll(async () => {
    anvil = spawn('anvil', ['--port', String(port), '--chain-id', '31337', '--silent'], { stdio: 'ignore' });
    for (let i = 0; i < 100; i++) {
      try {
        await provider.getBlockNumber();
        break;
      } catch {
        await new Promise((r) => setTimeout(r, 100));
      }
    }
    const etch = async (addr: string, file: string) => provider.send('anvil_setCode', [addr, readFileSync(file, 'utf8').trim()]);
    await etch(SAFE_V141.singleton, `${SAFE_FIXTURES}/Safe.hex`);
    await etch(SAFE_V141.proxyFactory, `${SAFE_FIXTURES}/SafeProxyFactory.hex`);
    await etch(SAFE_V141.multiSend, `${SAFE_FIXTURES}/MultiSend.hex`);
    await etch(SAFE_V141.compatibilityFallbackHandler, `${SAFE_FIXTURES}/CompatibilityFallbackHandler.hex`);
    await etch(SAFE_V141.signMessageLib, `${SAFE_FIXTURES}/SignMessageLib.hex`);
    await etch('0xC2679fBD37d54388Ce493F1DB75320D236e1815e', `${EAS_FIXTURES}/EAS.hex`);
    await etch('0x0a7E2Ff54e76B8E6659aedc9103FB21c038050D0', `${EAS_FIXTURES}/SchemaRegistry.hex`);
    // forge keeps run logs per chain id; the user's own anvil runs keep theirs.
    if (existsSync(runLatest)) copyFileSync(runLatest, backup);
    for (const f of existsSync(broadcastDir) ? readdirSync(broadcastDir) : []) runsBefore.add(f);
  }, 60_000);

  afterAll(() => {
    anvil?.kill('SIGKILL');
    provider.destroy();
    for (const d of dirs) rmSync(d, { recursive: true, force: true });
    for (const f of deploymentFiles) rmSync(`${CONTRACTS}/deployments/${f}`, { force: true });
    if (existsSync(backup)) {
      copyFileSync(backup, runLatest);
      rmSync(backup, { force: true });
    } else rmSync(runLatest, { force: true });
    for (const f of existsSync(broadcastDir) ? readdirSync(broadcastDir) : []) {
      if (!runsBefore.has(f) && f !== 'run-latest.json') rmSync(`${broadcastDir}/${f}`, { force: true });
    }
  });

  const tempDir = () => {
    const d = mkdtempSync(join(tmpdir(), 'drift-e2e-deploy-'));
    dirs.push(d);
    return d;
  };

  it('deploys through the CLI, and a re-run sends nothing', async () => {
    const dir = tempDir();
    const raw = experiment('full');
    deploymentFiles.push('e2e-full-31337.json');
    writeFileSync(join(dir, 'experiment.json'), JSON.stringify(raw));
    const env = { E2E_RPC_URL: url, E2E_MNEMONIC: await fundedMnemonic(raw), FUNDER_PRIVATE_KEY: '0x' + '11'.repeat(32) };
    const lines: string[] = [];
    const run = (...argv: string[]) => main([...argv, '--config', join(dir, 'experiment.json'), '--out', join(dir, 'run'), '--contracts', CONTRACTS], env, (l) => void lines.push(l));

    expect(await run('plan', '--offline')).toBe(0);
    expect(await run('deploy')).toBe(0);
    const m = readManifest(join(dir, 'run', 'deployment.json'));
    await assertDeployed(m);
    await assertNoDuplicates(join(dir, 'run'), m.deployer);

    const watched = [m.deployer, ...m.nodes, m.watcher!];
    const before = await Promise.all(watched.map((a) => provider.getTransactionCount(a)));
    lines.length = 0;
    expect(await run('deploy')).toBe(0);
    expect(await Promise.all(watched.map((a) => provider.getTransactionCount(a)))).toEqual(before);
    expect(readManifest(join(dir, 'run', 'deployment.json'))).toEqual(m);
  }, 300_000);

  for (const [label, tag, faults] of [
    ['a crash after a broadcast', 'crash-after', { crashAfterBroadcast: 6 }],
    ['a crash after saving a signed transaction but before broadcasting it', 'crash-before', { crashBeforeBroadcast: 9 }]
  ] as const) {
    it(`resumes after ${label} without a duplicate transaction`, async () => {
      const dir = tempDir();
      const raw = experiment(tag);
      deploymentFiles.push(`e2e-${tag}-31337.json`);
      const cfg = parseExperimentConfig(raw);
      const mnemonic = await fundedMnemonic(raw);
      const base = { cfg, mnemonic, provider, rpcUrl: url, contractsDir: CONTRACTS, stateDir: dir, log: () => {} };

      await expect(deployExperiment({ ...base, faults })).rejects.toBeInstanceOf(SimulatedCrash);
      const state = JSON.parse(readFileSync(join(dir, 'deploy-state.json'), 'utf8')) as { steps: Record<string, StepRecord> };
      expect(Object.values(state.steps).filter((s) => s.status === 'pending')).toHaveLength(1);

      const m = await deployExperiment(base);
      await assertDeployed(m);
      await assertNoDuplicates(dir, m.deployer);
    }, 300_000);
  }
});

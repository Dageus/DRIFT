import { spawn, type ChildProcess } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { JsonRpcProvider, formatEther, getAddress, toBeHex } from 'ethers';
import { SAFE_V141 } from '@drift-network/operator';
import { SEPOLIA_EAS_ADDRESS, SEPOLIA_SCHEMA_REGISTRY_ADDRESS } from '../config.js';
import type { ExperimentConfig } from '../config.js';
import { deriveSlots, slotIndices } from '../keys.js';
import { buildPlan, type FundingPlan } from '../plan.js';
import type { GasTable } from '../gas.js';
import { deployExperiment, type DeployManifest } from '../setup.js';
import { assertLocalAnvil } from '../measure.js';
import { analyze, loadEvents, renderFiles, writeFiles } from '../analyze/index.js';
import type { Log } from '../ops.js';
import { runExperiment, type RunSummary } from './run.js';
import { easLogIndexer, ipfsStub } from './services.js';

export interface SpendRow {
  role: string;
  keys: number;
  /** Planned gas units (before the margin) and funding target. */
  plannedGas: bigint;
  targetWei: bigint;
  /** Gas the role's keys actually used, from receipts, and that gas priced at the plan's cap. */
  usedGas: bigint;
  usedAtCapWei: bigint;
  /** Balance change at the rehearsal's own (low) fees, bonds included. */
  spentWei: bigint;
  /** Lowest end balance among the role's keys, as a share of its target: how close a key came to running dry. */
  minLeftShare: number;
}

export interface RehearsalResult {
  manifest: DeployManifest;
  summary: RunSummary;
  plan: FundingPlan;
  spend: SpendRow[];
  spentWei: bigint;
  dataQualityIssues: number;
  analysisDir: string;
  wallSeconds: number;
}

const SAFE_FIXTURES = fileURLToPath(new URL('../../../contracts/test/fixtures/safe-v1.4.1', import.meta.url));
const EAS_FIXTURES = fileURLToPath(new URL('../../test/fixtures/eas-sepolia', import.meta.url));

/**
 * The chain a rehearsal runs on. 'local': a fresh anvil with the Sepolia EAS, schema registry and
 * Safe v1.4.1 runtime code placed at their canonical addresses (fast: all state is local).
 * 'fork': an anvil fork of the config's chain; same code, but every storage slot the run touches
 * for the first time is fetched from the upstream RPC, which makes a large run take hours.
 */
async function startChain(kind: 'local' | 'fork', forkUrl: string | undefined, port: number): Promise<{ provider: JsonRpcProvider; url: string; stop: () => void }> {
  const url = `http://127.0.0.1:${port}`;
  const args = ['--chain-id', '31337', '--port', String(port), '--silent'];
  if (kind === 'fork') {
    if (!forkUrl) throw new Error('a fork rehearsal needs the RPC URL the config names');
    const upstream = new JsonRpcProvider(forkUrl, undefined, { staticNetwork: true });
    const forkBlock = (await upstream.getBlockNumber()) - 5;
    upstream.destroy();
    args.push('--fork-url', forkUrl, '--fork-block-number', String(forkBlock), '--no-rate-limit');
  }
  // Chain id 31337: nothing signed during a rehearsal is valid on the real chain.
  const anvil: ChildProcess = spawn('anvil', args, { stdio: 'ignore' });
  const stop = () => {
    anvil.kill('SIGKILL');
  };
  process.once('exit', stop);
  const provider = new JsonRpcProvider(url, 31337, { staticNetwork: true, cacheTimeout: -1, pollingInterval: 100 });
  for (let i = 0; i < 300; i++) {
    try {
      await provider.getBlockNumber();
      await assertLocalAnvil(provider, url);
      if (kind === 'local') {
        const etch = (addr: string, file: string) => provider.send('anvil_setCode', [addr, readFileSync(file, 'utf8').trim()]);
        await etch(SAFE_V141.singleton, `${SAFE_FIXTURES}/Safe.hex`);
        await etch(SAFE_V141.proxyFactory, `${SAFE_FIXTURES}/SafeProxyFactory.hex`);
        await etch(SAFE_V141.multiSend, `${SAFE_FIXTURES}/MultiSend.hex`);
        await etch(SAFE_V141.compatibilityFallbackHandler, `${SAFE_FIXTURES}/CompatibilityFallbackHandler.hex`);
        await etch(SAFE_V141.signMessageLib, `${SAFE_FIXTURES}/SignMessageLib.hex`);
        await etch(SEPOLIA_EAS_ADDRESS, `${EAS_FIXTURES}/EAS.hex`);
        await etch(SEPOLIA_SCHEMA_REGISTRY_ADDRESS, `${EAS_FIXTURES}/SchemaRegistry.hex`);
      }
      return { provider, url, stop };
    } catch {
      await new Promise((r) => setTimeout(r, 200));
    }
  }
  stop();
  throw new Error('anvil did not start');
}

/**
 * The whole experiment on an anvil fork of the target chain, fast-forwarded: every key starts with
 * exactly its planned balance (so a plan too small to finish shows up as a failed transaction),
 * then deploy, run and analyze, as on the real chain. Daemons, Safe owners and members are the same
 * code; only time (evm_increaseTime), the EAS indexer (served from EAS logs on the fork) and IPFS
 * (in memory) differ. Nothing is broadcast to the real chain.
 */
export async function rehearse(o: {
  cfg: ExperimentConfig;
  mnemonic: string;
  forkUrl?: string;
  /** Default 'local'; see startChain. */
  chain?: 'local' | 'fork';
  contractsDir: string;
  outDir: string;
  gas: GasTable;
  log: Log;
  port?: number;
}): Promise<RehearsalResult> {
  const started = Date.now();
  const cfg: ExperimentConfig = { ...o.cfg, chainId: 31337n };
  const dir = join(o.outDir, 'rehearsal');
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  const port = o.port ?? 23545 + Math.floor(Math.random() * 1000);
  const fork = await startChain(o.chain ?? 'local', o.forkUrl, port);
  const { provider, log } = { provider: fork.provider, log: o.log };

  // forge keeps deployment records and run logs per chain id; keep the user's local ones.
  const deploymentFile = join(o.contractsDir, 'deployments', `e2e-${cfg.runTag}-31337.json`);
  const broadcastDir = join(o.contractsDir, 'broadcast', 'Deploy.s.sol', '31337');
  const runLatest = join(broadcastDir, 'run-latest.json');
  const backup = `${runLatest}.rehearsal-backup`;
  const before = new Set(existsSync(broadcastDir) ? readdirSync(broadcastDir) : []);
  if (existsSync(runLatest)) copyFileSync(runLatest, backup);
  rmSync(deploymentFile, { force: true });
  const services: { close(): Promise<void> }[] = [];
  // Also on Ctrl-C (the run exits from its signal handler, skipping `finally`).
  const restore = () => {
    rmSync(deploymentFile, { force: true });
    if (existsSync(backup)) {
      copyFileSync(backup, runLatest);
      rmSync(backup, { force: true });
    } else rmSync(runLatest, { force: true });
    for (const f of existsSync(broadcastDir) ? readdirSync(broadcastDir) : []) if (!before.has(f) && f !== 'run-latest.json') rmSync(join(broadcastDir, f), { force: true });
  };
  process.once('exit', restore);

  try {
    const slots = deriveSlots(o.mnemonic, slotIndices(cfg));
    const plan = buildPlan(cfg, slots, o.gas);
    for (const k of plan.keys) await provider.send('anvil_setBalance', [k.address, toBeHex(k.targetWei)]);
    log(`${o.chain ?? 'local'} anvil on ${fork.url}; ${plan.keys.length} keys at their planned balances (${formatEther(plan.totalTargetWei)} ETH)`);

    const manifest = await deployExperiment({ cfg, mnemonic: o.mnemonic, provider, rpcUrl: fork.url, contractsDir: o.contractsDir, stateDir: dir, plan, log: () => {} });
    log(`deployed: tier1 ${manifest.contexts.tier1?.client ?? '-'}, tier2 ${manifest.contexts.tier2?.client ?? '-'}, safe ${manifest.safe?.address ?? '-'}`);

    const eas = await easLogIndexer(provider, manifest.eas.address, manifest.startBlock);
    const ipfs = await ipfsStub();
    services.push(eas, ipfs);
    const summary = await runExperiment({
      cfg,
      manifest,
      mnemonic: o.mnemonic,
      provider,
      stateDir: dir,
      mode: 'rehearsal',
      services: { rpcUrl: fork.url, easGraphqlUrl: eas.url, ipfsApiUrl: ipfs.url, ipfsGatewayUrl: ipfs.url },
      timing: { blockTag: 'latest', pollIntervalSeconds: 1, commitWindowSeconds: 6, revealWindowSeconds: 6, executeGraceSeconds: 3 },
      log
    });

    const ends = await Promise.all(plan.keys.map((k) => provider.getBalance(k.address)));
    const gasBy = gasUsedByAddress(dir, summary.eventsDir, runLatest);
    const byRole = new Map<string, SpendRow>();
    plan.keys.forEach((k, i) => {
      const r = byRole.get(k.role) ?? { role: k.role, keys: 0, plannedGas: 0n, targetWei: 0n, usedGas: 0n, usedAtCapWei: 0n, spentWei: 0n, minLeftShare: 1 };
      const used = gasBy.get(getAddress(k.address)) ?? 0n;
      r.keys++;
      r.plannedGas += k.gasUnits;
      r.targetWei += k.targetWei;
      r.usedGas += used;
      r.usedAtCapWei += used * plan.maxFeeWei;
      r.spentWei += k.targetWei - ends[i]!;
      if (k.targetWei > 0n) r.minLeftShare = Math.min(r.minLeftShare, Number((ends[i]! * 10_000n) / k.targetWei) / 10_000);
      byRole.set(k.role, r);
    });
    const spend = [...byRole.values()];
    const spentWei = spend.reduce((s, r) => s + r.spentWei, 0n);

    const analysisDir = join(dir, 'analysis');
    const loaded = loadEvents([summary.eventsDir]);
    const result = analyze(loaded);
    writeFiles(analysisDir, renderFiles(result));
    const dataQualityIssues = result.issues.length;
    writeFileSync(join(dir, 'spend.json'), JSON.stringify({ plan: plan.requiredWei, spent: spentWei, spend }, (_, x) => (typeof x === 'bigint' ? x.toString() : x), 2) + '\n');
    return { manifest, summary, plan, spend, spentWei, dataQualityIssues, analysisDir, wallSeconds: Math.round((Date.now() - started) / 1000) };
  } finally {
    for (const s of services) await s.close();
    provider.destroy();
    fork.stop();
    process.removeListener('exit', restore);
    restore();
  }
}

/**
 * Gas used per sending address, from every receipt the rehearsal produced: forge's broadcast of
 * Deploy.s.sol, the deploy steps, and every transaction the daemons and the members recorded.
 */
function gasUsedByAddress(dir: string, eventsDir: string, forgeRun: string): Map<string, bigint> {
  const out = new Map<string, bigint>();
  const add = (from: string, gas: bigint | string) => {
    const a = getAddress(from);
    out.set(a, (out.get(a) ?? 0n) + BigInt(gas));
  };
  if (existsSync(forgeRun)) {
    const run = JSON.parse(readFileSync(forgeRun, 'utf8')) as { receipts: { from: string; gasUsed: string }[] };
    for (const r of run.receipts) add(r.from, r.gasUsed);
  }
  const deploy = JSON.parse(readFileSync(join(dir, 'deploy-state.json'), 'utf8')) as { steps: Record<string, { from?: string; gasUsed?: string }> };
  for (const s of Object.values(deploy.steps)) if (s.from && s.gasUsed) add(s.from, s.gasUsed);
  for (const f of readdirSync(eventsDir).filter((x) => x.endsWith('.jsonl'))) {
    for (const line of readFileSync(join(eventsDir, f), 'utf8').split('\n')) {
      if (!line.includes('"tx.mined"')) continue;
      const e = JSON.parse(line) as { tx: { from: string; gasUsed: string } };
      add(e.tx.from, e.tx.gasUsed);
    }
  }
  return out;
}

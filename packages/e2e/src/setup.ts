import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, writeSync } from 'node:fs';
import { join } from 'node:path';
import {
  Contract,
  Interface,
  ZeroAddress,
  ZeroHash,
  getAddress,
  getCreate2Address,
  id,
  keccak256,
  solidityPacked,
  toUtf8Bytes,
  type HDNodeWallet,
  type JsonRpcProvider,
  type TransactionReceipt
} from 'ethers';
import { SAFE_V141 } from '@drift-network/operator';
import type { ExperimentConfig } from './config.js';
import { deriveSlots, deriveWallet, slotIndices, type KeySlot } from './keys.js';
import { experimentDeployer, forgeEnv, type Deployment } from './deploy.js';
import type { FundingPlan } from './plan.js';
import { assertChain, waitForFeesUnderCap, type Log } from './ops.js';
import { spawnSync } from 'node:child_process';

/** The member role every node holds in every context. */
export const MEMBER_ROLE = id('MEMBER');

const CORE = new Interface([
  'function registerContext(string name) returns (bytes32)',
  'function contextExists(bytes32) view returns (bool)',
  'function getContext(bytes32) view returns (tuple(bytes32 uid, string name, address owner, bool active))',
  'function getContextClient(bytes32) view returns (address)',
  'function contextAdminRole(bytes32) view returns (bytes32)',
  'function hasRole(bytes32 role, address account) view returns (bool)',
  'function grantRole(bytes32 role, address account)',
  'function registerNode(bytes32 contextUID, bytes entryProof)',
  'function isRegistered(bytes32 contextUID, address node) view returns (bool)',
  'function hasNodeRole(bytes32 contextUID, address node, bytes32 role) view returns (bool)'
]);
const FACTORY = new Interface(['function deployClient(bytes32 contextUID, address template, bytes initData, bytes32 salt) returns (address)']);
const CLIENT = new Interface([
  'function initialize(address,address,bytes32,address,uint256,uint256,string,bytes32[],uint256[])',
  'function setDisputeWindow(uint256)',
  'function setResponseWindow(uint256)',
  'function setSettlementBond(uint256)',
  'function setChallengeBond(uint256)',
  'function setResponseGasEstimate(uint256)',
  'function setEpochLength(uint256)',
  'function assignRole(address node, bytes32 role)',
  'function disputeWindow() view returns (uint256)',
  'function responseWindow() view returns (uint256)',
  'function settlementBond() view returns (uint256)',
  'function challengeBond() view returns (uint256)',
  'function responseGasEstimate() view returns (uint256)',
  'function epochLength() view returns (uint256)',
  'function epochAnchorTimestamp() view returns (uint256)',
  'function trustedSettler() view returns (address)'
]);
const SCHEMAS = new Interface([
  'function register(string schema, address resolver, bool revocable) returns (bytes32)',
  'function getSchema(bytes32 uid) view returns (tuple(bytes32 uid, address resolver, bool revocable, string schema))'
]);
const EAS = new Interface(['function getSchemaRegistry() view returns (address)']);
const SAFE_FACTORY = new Interface(['function createProxyWithNonce(address singleton, bytes initializer, uint256 saltNonce) returns (address)', 'function proxyCreationCode() view returns (bytes)']);
const SAFE = new Interface([
  'function setup(address[] owners, uint256 threshold, address to, bytes data, address fallbackHandler, address paymentToken, uint256 payment, address paymentReceiver)',
  'function getOwners() view returns (address[])',
  'function getThreshold() view returns (uint256)'
]);

export type TierName = 'tier1' | 'tier2';

export interface ContextManifest {
  name: string;
  contextUID: string;
  client: string;
  trustedSettler: string;
  epochLength: number;
  epochAnchorTimestamp: number;
  disputeWindow: number;
  responseWindow: number;
}

/** Everything later phases and the daemon configs need, written once setup completes. */
export interface DeployManifest {
  version: 1;
  chainId: string;
  runTag: string;
  /** First block of this deployment: a safe fromBlock for registry and challenge log scans. */
  startBlock: number;
  deployer: string;
  contracts: Deployment;
  eas: { address: string; schemaRegistry: string; schemaUID: string; schema: string; schemaDefinition: string };
  role: string;
  safe?: { address: string; owners: string[]; threshold: number };
  contexts: Partial<Record<TierName, ContextManifest>>;
  nodes: string[];
  watcher?: string;
}

interface StepRecord {
  status: 'pending' | 'done';
  at: string;
  /** Transaction steps: the signed transaction is saved before it is broadcast. */
  tx?: string;
  from?: string;
  nonce?: number;
  raw?: string;
  /** Set when the step was found already done on chain, with no transaction of ours. */
  reconciled?: boolean;
  gasUsed?: string;
  block?: number;
}

interface StateFile {
  version: 1;
  chainId: string;
  runTag: string;
  deployer: string;
  startBlock?: number;
  deployment?: Deployment;
  steps: Record<string, StepRecord>;
}

/** Saves a JSON file atomically and durably: temp file, fsync, rename. */
function saveJson(path: string, value: unknown): void {
  const tmp = `${path}.tmp`;
  const fd = openSync(tmp, 'w');
  try {
    writeSync(fd, JSON.stringify(value, null, 2) + '\n');
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  renameSync(tmp, path);
}

/** Thrown by the fault-injection hooks the tests use to simulate a crash. */
export class SimulatedCrash extends Error {}

export interface DeployOptions {
  cfg: ExperimentConfig;
  mnemonic: string;
  provider: JsonRpcProvider;
  rpcUrl: string;
  contractsDir: string;
  stateDir: string;
  plan?: FundingPlan;
  log: Log;
  /** How long a send waits for the base fee to fall under the cap. */
  waitMs?: number;
  /** How long to wait for a receipt before giving up (the step stays pending, resumable). */
  receiptTimeoutMs?: number;
  /** Test-only fault injection: crash after the n-th broadcast, or after saving but before broadcasting it. */
  faults?: { crashAfterBroadcast?: number; crashBeforeBroadcast?: number };
}

/**
 * Deploys and configures the experiment, resumably. Every step first checks chain state, so a
 * step already done (by this run or a crashed one) is never sent again. Each transaction is signed
 * and saved to the state file before it is broadcast; on resume a saved transaction is waited for
 * if pending, re-broadcast byte for byte if the network never saw it, or reconciled from chain
 * state if its nonce was used by something else. A crash at any point therefore cannot produce a
 * duplicate transaction.
 */
export async function deployExperiment(o: DeployOptions): Promise<DeployManifest> {
  const { cfg, provider, log } = o;
  await assertChain(provider, cfg.chainId);
  const deployerAddr = experimentDeployer(o.mnemonic, o.plan);
  const slots = deriveSlots(o.mnemonic, slotIndices(cfg));
  const slot = (role: KeySlot['role'], ordinal = 0) => slots.find((s) => s.role === role && s.ordinal === ordinal);
  const wallet = (s: KeySlot): HDNodeWallet => deriveWallet(o.mnemonic, s.index).connect(provider);
  const deployer = deriveWallet(o.mnemonic, 0).connect(provider);

  mkdirSync(o.stateDir, { recursive: true });
  const statePath = join(o.stateDir, 'deploy-state.json');
  const state: StateFile = existsSync(statePath)
    ? (JSON.parse(readFileSync(statePath, 'utf8')) as StateFile)
    : { version: 1, chainId: cfg.chainId.toString(), runTag: cfg.runTag, deployer: deployerAddr, steps: {} };
  if (state.chainId !== cfg.chainId.toString() || state.runTag !== cfg.runTag || getAddress(state.deployer) !== getAddress(deployerAddr)) {
    throw new Error(`${statePath} belongs to chain ${state.chainId}, run ${state.runTag}, deployer ${state.deployer}; this config is chain ${cfg.chainId}, run ${cfg.runTag}, deployer ${deployerAddr}. Use another --state-dir.`);
  }
  const save = () => saveJson(statePath, state);
  state.startBlock ??= await provider.getBlockNumber();
  save();

  let broadcasts = 0;
  const done = (stepId: string, extra: Partial<StepRecord> = {}) => {
    state.steps[stepId] = { ...state.steps[stepId], status: 'done', at: new Date().toISOString(), ...extra };
    save();
  };

  const waitReceipt = async (hash: string): Promise<TransactionReceipt> => {
    const r = await provider.waitForTransaction(hash, 1, o.receiptTimeoutMs ?? 30 * 60_000);
    if (!r) throw new Error(`no receipt for ${hash} within the timeout; re-run deploy to resume`);
    return r;
  };

  const finish = async (stepId: string, hash: string, isDone: () => Promise<boolean>): Promise<void> => {
    const r = await waitReceipt(hash);
    if (r.status !== 1) {
      // A revert can mean another party already did it; only chain state decides.
      if (await isDone()) return done(stepId, { gasUsed: r.gasUsed.toString(), block: r.blockNumber });
      throw new Error(`step ${stepId}: transaction ${hash} reverted and the step is not done on chain; investigate before re-running`);
    }
    if (!(await isDone())) throw new Error(`step ${stepId}: ${hash} succeeded but the chain does not show the step done; investigate`);
    done(stepId, { gasUsed: r.gasUsed.toString(), block: r.blockNumber });
    log(`  ${stepId.padEnd(34)} ${r.gasUsed.toString().padStart(9)} gas`);
  };

  /** One transaction step, resumable as described above. */
  const txStep = async (stepId: string, signer: HDNodeWallet, req: { to: string; data?: string; value?: bigint }, isDone: () => Promise<boolean>): Promise<void> => {
    const rec = state.steps[stepId];
    if (rec?.status === 'done') {
      if (!(await isDone())) throw new Error(`step ${stepId} is recorded done but the chain disagrees; is --state-dir from another deployment?`);
      return;
    }
    if (rec?.status === 'pending' && rec.tx) {
      const known = (await provider.getTransactionReceipt(rec.tx)) ?? (await provider.getTransaction(rec.tx));
      if (known) return finish(stepId, rec.tx, isDone);
      const used = (await provider.getTransactionCount(rec.from!, 'latest')) > rec.nonce!;
      if (used) {
        // Our nonce went to some other transaction; the chain decides whether the step happened.
        if (await isDone()) return done(stepId, { reconciled: true });
      } else {
        log(`  ${stepId}: re-broadcasting the saved transaction ${rec.tx}`);
        await provider.broadcastTransaction(rec.raw!);
        return finish(stepId, rec.tx, isDone);
      }
    }
    if (await isDone()) {
      log(`  ${stepId.padEnd(34)} already on chain`);
      return done(stepId, { reconciled: true });
    }
    const from = signer.address;
    const fees = await waitForFeesUnderCap(provider, cfg.gas.maxFeeWei, cfg.gas.priorityFeeWei, { waitMs: o.waitMs ?? 60 * 60_000, log });
    const nonce = await provider.getTransactionCount(from, 'pending');
    const estimate = await provider.estimateGas({ from, to: req.to, data: req.data, value: req.value });
    const raw = await signer.signTransaction({
      type: 2,
      chainId: cfg.chainId,
      to: req.to,
      data: req.data,
      value: req.value ?? 0n,
      nonce,
      gasLimit: (estimate * 13n) / 10n,
      maxFeePerGas: fees.maxFeePerGas,
      maxPriorityFeePerGas: fees.maxPriorityFeePerGas
    });
    const hash = keccak256(raw);
    state.steps[stepId] = { status: 'pending', at: new Date().toISOString(), tx: hash, from, nonce, raw };
    save();
    broadcasts++;
    if (o.faults?.crashBeforeBroadcast === broadcasts) throw new SimulatedCrash(`simulated crash before broadcasting ${stepId}`);
    await provider.broadcastTransaction(raw);
    if (o.faults?.crashAfterBroadcast === broadcasts) throw new SimulatedCrash(`simulated crash after broadcasting ${stepId}`);
    await finish(stepId, hash, isDone);
  };

  const read = async <T>(c: Contract, fn: string, ...args: unknown[]): Promise<T> => (await c.getFunction(fn).staticCall(...args)) as T;
  const code = async (a: string) => (await provider.getCode(a)) !== '0x';

  // 1. Contract stack (Deploy.s.sol, from the experiment mnemonic).
  log('contracts');
  const deploymentFile = `e2e-${cfg.runTag}-${cfg.chainId}.json`;
  const deploymentPath = join(o.contractsDir, 'deployments', deploymentFile);
  const coreAdmin = async (d: Deployment) => (await code(d.DRIFTCore)) && (await read<boolean>(new Contract(d.DRIFTCore, CORE, provider), 'hasRole', ZeroHash, deployerAddr));
  if (state.steps.stack?.status !== 'done') {
    if (existsSync(deploymentPath)) {
      const d = JSON.parse(readFileSync(deploymentPath, 'utf8')) as Deployment;
      if (!(await coreAdmin(d))) throw new Error(`${deploymentPath} exists but its core is not administered by the experiment deployer`);
      state.deployment = d;
    } else {
      const resume = state.steps.stack?.status === 'pending';
      state.steps.stack = { status: 'pending', at: new Date().toISOString() };
      save();
      mkdirSync(join(o.contractsDir, 'deployments'), { recursive: true });
      const args = ['script', 'script/Deploy.s.sol:DeployScript', '--rpc-url', o.rpcUrl, '--broadcast', '--slow', ...(resume ? ['--resume'] : [])];
      log(resume ? '  resuming forge broadcast of Deploy.s.sol' : '  forge script Deploy.s.sol');
      const r = spawnSync('forge', args, { cwd: o.contractsDir, env: forgeEnv(o.mnemonic, { DRIFT_DEPLOYMENT_FILE: deploymentFile }), encoding: 'utf8' });
      if (r.status !== 0) {
        throw new Error(`forge script Deploy.s.sol failed${resume ? ' to resume' : ''}. Re-run deploy to retry the resume; if forge cannot resume, inspect broadcast/ before deleting ${statePath}.\n${r.stdout}\n${r.stderr}`);
      }
      const d = JSON.parse(readFileSync(deploymentPath, 'utf8')) as Deployment;
      if (!(await coreAdmin(d))) throw new Error(`the deployed core's admin is not the experiment deployer ${deployerAddr}; the wrong key deployed`);
      state.deployment = d;
    }
    done('stack');
    log(`  core ${state.deployment.DRIFTCore}`);
  }
  const d = state.deployment!;
  const core = new Contract(d.DRIFTCore, CORE, provider);

  // 2. Schema. All-uint256 (what the engine protocol supports); the tag field makes it unique to the run.
  log('schema');
  const easContract = new Contract(cfg.eas.address, EAS, provider);
  if (!(await code(cfg.eas.address)) || !(await code(cfg.eas.schemaRegistry))) throw new Error(`EAS (${cfg.eas.address}) or its schema registry has no code on this chain`);
  if (getAddress(await read<string>(easContract, 'getSchemaRegistry')) !== getAddress(cfg.eas.schemaRegistry)) throw new Error('EAS reports a different schema registry than the config');
  const tagField = `drift_${cfg.runTag.replace(/-/g, '_')}`;
  const schema = `uint256 score, uint256 ${tagField}`;
  const schemaUID = schemaUIDOf(schema);
  const registry = new Contract(cfg.eas.schemaRegistry, SCHEMAS, provider);
  await txStep('schema', deployer, { to: cfg.eas.schemaRegistry, data: SCHEMAS.encodeFunctionData('register', [schema, ZeroAddress, true]) }, async () => (await read<{ uid: string }>(registry, 'getSchema', schemaUID)).uid !== ZeroHash);

  // 3. Safe (Tier 2 settler), through the canonical Safe v1.4.1 factory at a predictable address.
  let safeInfo: DeployManifest['safe'];
  if (cfg.tier2.epochs > 0) {
    log('safe');
    const owners = Array.from({ length: cfg.tier2.owners }, (_, i) => slot('tier2-owner', i)!.address);
    const init = SAFE.encodeFunctionData('setup', [owners, cfg.tier2.threshold, ZeroAddress, '0x', SAFE_V141.compatibilityFallbackHandler, ZeroAddress, 0, ZeroAddress]);
    const saltNonce = BigInt(id(`drift-e2e:${cfg.runTag}:safe`));
    const creation = await read<string>(new Contract(SAFE_V141.proxyFactory, SAFE_FACTORY, provider), 'proxyCreationCode');
    const salt = keccak256(solidityPacked(['bytes32', 'uint256'], [keccak256(init), saltNonce]));
    const safe = getCreate2Address(SAFE_V141.proxyFactory, salt, keccak256(solidityPacked(['bytes', 'uint256'], [creation, SAFE_V141.singleton])));
    await txStep('safe', deployer, { to: SAFE_V141.proxyFactory, data: SAFE_FACTORY.encodeFunctionData('createProxyWithNonce', [SAFE_V141.singleton, init, saltNonce]) }, () => code(safe));
    const safeC = new Contract(safe, SAFE, provider);
    const onChainOwners = (await read<string[]>(safeC, 'getOwners')).map(getAddress).sort();
    if (onChainOwners.join() !== owners.map(getAddress).sort().join() || (await read<bigint>(safeC, 'getThreshold')) !== BigInt(cfg.tier2.threshold)) {
      throw new Error(`the Safe at ${safe} does not have the configured owners and threshold`);
    }
    // Bond capital, as planned: two settlement bonds in flight.
    const capital = 2n * cfg.bonds.settlementWei;
    const balance = await provider.getBalance(safe);
    await txStep('safe:fund', deployer, { to: safe, value: capital > balance ? capital - balance : 0n }, async () => (await provider.getBalance(safe)) >= capital);
    safeInfo = { address: safe, owners, threshold: cfg.tier2.threshold };
  }

  // 4. Contexts, one per tier with epochs: client, configuration, members. Epoch length last, so
  //    the epoch anchor follows every registration.
  const nodeSlots = slots.filter((s) => s.role === 'node');
  const watcher = slot('watcher-hot');
  const contexts: DeployManifest['contexts'] = {};
  const tiers: [TierName, string][] = [];
  if (cfg.tier1.epochs > 0) tiers.push(['tier1', slot('tier1-settler')!.address]);
  if (cfg.tier2.epochs > 0) tiers.push(['tier2', safeInfo!.address]);
  for (const [tier, settlerAddr] of tiers) {
    log(tier);
    const name = `drift-e2e.${cfg.runTag}.${tier}`;
    const uid = keccak256(toUtf8Bytes(name));
    await txStep(`${tier}:context`, deployer, { to: d.DRIFTCore, data: CORE.encodeFunctionData('registerContext', [name]) }, async () => {
      if (!(await read<boolean>(core, 'contextExists', uid))) return false;
      const owner = (await read<{ owner: string }>(core, 'getContext', uid)).owner;
      if (getAddress(owner) !== getAddress(deployerAddr)) throw new Error(`context ${name} exists on this core but belongs to ${owner}`);
      return true;
    });
    const initData = CLIENT.encodeFunctionData('initialize', [d.DRIFTCore, d.DRIFTToken, uid, settlerAddr, 0, 0, 'EigenTrust', [MEMBER_ROLE], [10_000]]);
    await txStep(`${tier}:client`, deployer, { to: d.Factory, data: FACTORY.encodeFunctionData('deployClient', [uid, d.WeightedGovernanceTemplate, initData, uid]) }, async () => (await read<string>(core, 'getContextClient', uid)) !== ZeroAddress);
    const clientAddr = await read<string>(core, 'getContextClient', uid);
    const client = new Contract(clientAddr, CLIENT, provider);
    if (getAddress(await read<string>(client, 'trustedSettler')) !== getAddress(settlerAddr)) throw new Error(`${tier} client ${clientAddr} has an unexpected trusted settler`);
    const adminRole = await read<string>(core, 'contextAdminRole', uid);
    await txStep(`${tier}:grant`, deployer, { to: d.DRIFTCore, data: CORE.encodeFunctionData('grantRole', [adminRole, clientAddr]) }, () => read<boolean>(core, 'hasRole', adminRole, clientAddr));

    // Settings: once-only setters must be unset or already equal; bonds may be changed.
    const setting = async (key: string, getter: string, setter: string, value: bigint, onceOnly: boolean) => {
      await txStep(`${tier}:${key}`, deployer, { to: clientAddr, data: CLIENT.encodeFunctionData(setter, [value]) }, async () => {
        const v = await read<bigint>(client, getter);
        if (v === value) return true;
        if (onceOnly && v !== 0n) throw new Error(`${tier} ${getter} is ${v}, not ${value}, and can only be set once; use a new runTag`);
        return false;
      });
    };
    await setting('disputeWindow', 'disputeWindow', 'setDisputeWindow', BigInt(cfg.timing.disputeWindowSeconds), true);
    await setting('responseWindow', 'responseWindow', 'setResponseWindow', BigInt(cfg.timing.responseWindowSeconds), true);
    await setting('settlementBond', 'settlementBond', 'setSettlementBond', cfg.bonds.settlementWei, false);
    await setting('challengeBond', 'challengeBond', 'setChallengeBond', cfg.bonds.challengeWei, false);
    if (cfg.bonds.responseGasEstimate > 0n) await setting('responseGasEstimate', 'responseGasEstimate', 'setResponseGasEstimate', cfg.bonds.responseGasEstimate, false);

    // Members: every node in every context; the watcher's key in the Tier 1 context, so its
    // challenges have standing.
    const members = [...nodeSlots, ...(tier === 'tier1' && watcher ? [watcher] : [])];
    for (const m of members) {
      const label = m.role === 'node' ? `node${m.ordinal}` : 'watcher';
      await txStep(`${tier}:${label}:register`, wallet(m), { to: d.DRIFTCore, data: CORE.encodeFunctionData('registerNode', [uid, '0x']) }, () => read<boolean>(core, 'isRegistered', uid, m.address));
      await txStep(`${tier}:${label}:role`, deployer, { to: clientAddr, data: CLIENT.encodeFunctionData('assignRole', [m.address, MEMBER_ROLE]) }, () => read<boolean>(core, 'hasNodeRole', uid, m.address, MEMBER_ROLE));
    }
    await setting('epochLength', 'epochLength', 'setEpochLength', BigInt(cfg.timing.epochLengthSeconds), true);

    contexts[tier] = {
      name,
      contextUID: uid,
      client: getAddress(clientAddr),
      trustedSettler: getAddress(settlerAddr),
      epochLength: Number(await read<bigint>(client, 'epochLength')),
      epochAnchorTimestamp: Number(await read<bigint>(client, 'epochAnchorTimestamp')),
      disputeWindow: Number(await read<bigint>(client, 'disputeWindow')),
      responseWindow: Number(await read<bigint>(client, 'responseWindow'))
    };
  }

  const manifest: DeployManifest = {
    version: 1,
    chainId: cfg.chainId.toString(),
    runTag: cfg.runTag,
    startBlock: state.startBlock,
    deployer: deployerAddr,
    contracts: d,
    eas: { address: getAddress(cfg.eas.address), schemaRegistry: getAddress(cfg.eas.schemaRegistry), schemaUID, schema, schemaDefinition: schema },
    role: MEMBER_ROLE,
    safe: safeInfo,
    contexts,
    nodes: nodeSlots.map((s) => s.address),
    watcher: watcher?.address
  };
  saveJson(join(o.stateDir, 'deployment.json'), manifest);
  log(`wrote ${join(o.stateDir, 'deployment.json')}`);
  return manifest;
}

/** Reads a manifest written by deployExperiment. */
export function readManifest(path: string): DeployManifest {
  const m = JSON.parse(readFileSync(path, 'utf8')) as DeployManifest;
  if (m.version !== 1) throw new Error(`${path}: unsupported manifest version ${String(m.version)}`);
  return m;
}

/** EAS schema UID: keccak256(abi.encodePacked(schema, resolver, revocable)), as SchemaRegistry computes it. */
export function schemaUIDOf(schema: string, resolver = ZeroAddress, revocable = true): string {
  return keccak256(solidityPacked(['string', 'address', 'bool'], [schema, resolver, revocable]));
}

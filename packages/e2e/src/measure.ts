import { spawn, type ChildProcess } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import {
  AbiCoder,
  Contract,
  Interface,
  JsonRpcProvider,
  NonceManager,
  ZeroAddress,
  ZeroHash,
  getAddress,
  id,
  parseEther,
  toBeHex,
  type ContractTransactionResponse,
  type Signer,
  type TransactionReceipt,
  type TransactionResponse
} from 'ethers';
import { DriftSettler, type ScoreEntry } from '@drift-network/sdk';
import type { EpochTree } from '@drift-network/sdk/merkle';
import { SAFE_V141, SafeSettler } from '@drift-network/operator';
import { deriveWallet } from './keys.js';
import { runDeploy, type Deployment } from './deploy.js';
import type { FundingPlan } from './plan.js';
import type { Action } from './gas.js';
import type { Log } from './ops.js';

export const SEPOLIA_EAS = '0xC2679fBD37d54388Ce493F1DB75320D236e1815e';
export const SEPOLIA_SCHEMA_REGISTRY = '0x0a7E2Ff54e76B8E6659aedc9103FB21c038050D0';
export const MULTI_ATTEST_SIZES = [1, 4, 12] as const;

const ROLE = id('MEMBER');
const EPOCH_LENGTH = 3_600;
const DISPUTE_WINDOW = 600;
const RESPONSE_WINDOW = 600;
/** Leaves in each measured tree, so proofs have depth 7, as in a context of about a hundred members. */
const TREE_LEAVES = 128;
const MEASURED_NODES = 6;

const CORE = new Interface([
  'function registerContext(string name) returns (bytes32)',
  'function contextAdminRole(bytes32) view returns (bytes32)',
  'function grantRole(bytes32 role, address account)',
  'function registerNode(bytes32 contextUID, bytes entryProof)'
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
  'function postEpochRoot(uint256 epoch, bytes32 merkleRoot, string treeURI, bytes sig) payable',
  'function requiredChallengeBond() view returns (uint256)',
  'function challengeOmission(uint256 epoch, address missingNode, bytes32 role) payable',
  'function respondToChallenge(uint256 epoch, address node, bytes32 role, uint256 score, bytes32[] proof)',
  'function claimUnansweredChallenge(uint256 epoch, address node, bytes32 role)',
  'function withdrawSettlementBond(uint256 epoch)',
  'function claimReputation(address node, bytes32 role, uint256 score, uint256 epoch, bytes32[] proof)',
  'function createProposalWithProofs(string description, address target, bytes payload, uint256 durationInDays, bytes32[] roles, uint256[] scores, bytes32[][] proofs) returns (uint256)',
  'function castVoteWithProofs(uint256 proposalId, bool support, bytes32[] roles, uint256[] scores, bytes32[][] proofs)',
  'function epochAnchorTimestamp() view returns (uint256)',
  'event ProposalCreated(uint256 indexed id, string description, uint256 deadline, uint256 snapshotEpoch, uint32 configVersion)'
]);
const SCHEMAS = new Interface(['function register(string schema, address resolver, bool revocable) returns (bytes32)']);
const EAS = new Interface([
  'function attest((bytes32 schema, (address recipient, uint64 expirationTime, bool revocable, bytes32 refUID, bytes data, uint256 value) data) request) payable returns (bytes32)',
  'function multiAttest((bytes32 schema, (address recipient, uint64 expirationTime, bool revocable, bytes32 refUID, bytes data, uint256 value)[] data)[] multiRequests) payable returns (bytes32[])',
  'function getSchemaRegistry() view returns (address)'
]);
const SAFE_FACTORY = new Interface(['function createProxyWithNonce(address singleton, bytes initializer, uint256 saltNonce) returns (address)', 'event ProxyCreation(address indexed proxy, address singleton)']);
const SAFE = new Interface(['function setup(address[] owners, uint256 threshold, address to, bytes data, address fallbackHandler, address paymentToken, uint256 payment, address paymentReceiver)']);

export interface Measurement {
  /** A gas-table action, or easMultiAttest<k> for a measured batch size. */
  action: string;
  gas: bigint;
  note: string;
  tx: string;
}

export interface MeasureResult {
  forkBlock: number;
  forkChainId: bigint;
  date: string;
  samples: Measurement[];
}

/** Refuses unless `provider` is a local anvil: measure must never send to a public network. */
export async function assertLocalAnvil(provider: JsonRpcProvider, url: string): Promise<void> {
  const host = new URL(url).hostname;
  if (host !== '127.0.0.1' && host !== 'localhost') throw new Error(`measure only sends to a local anvil, not ${host}`);
  const version = (await provider.send('web3_clientVersion', [])) as string;
  if (!/anvil/i.test(version)) throw new Error(`measure only sends to anvil; ${url} reports ${version}`);
}

async function waitFor(provider: JsonRpcProvider): Promise<void> {
  for (let i = 0; i < 300; i++) {
    try {
      await provider.getBlockNumber();
      return;
    } catch {
      await new Promise((r) => setTimeout(r, 200));
    }
  }
  throw new Error('anvil fork did not start');
}

/**
 * Runs one of every experiment action on an anvil fork of Sepolia, against the real EAS, schema
 * registry and Safe v1.4.1 deployments, and records each receipt's gasUsed (total transaction gas).
 */
export async function measure(opts: {
  forkUrl: string;
  experimentMnemonic: string;
  contractsDir: string;
  plan?: FundingPlan;
  log: Log;
  port?: number;
}): Promise<MeasureResult> {
  const { log } = opts;
  const upstream = new JsonRpcProvider(opts.forkUrl, undefined, { staticNetwork: true });
  const forkBlock = (await upstream.getBlockNumber()) - 5;
  const forkChainId = (await upstream.getNetwork()).chainId;
  upstream.destroy();

  const port = opts.port ?? 21545 + Math.floor(Math.random() * 1000);
  const url = `http://127.0.0.1:${port}`;
  // Chain id 31337 keeps forge's broadcast logs and deployment records away from the real
  // Sepolia ones (they are keyed by chain id), and makes any stray signature useless on Sepolia.
  const anvil: ChildProcess = spawn(
    'anvil',
    ['--fork-url', opts.forkUrl, '--fork-block-number', String(forkBlock), '--chain-id', '31337', '--port', String(port), '--silent', '--no-rate-limit'],
    { stdio: 'ignore' }
  );
  const kill = () => anvil.kill('SIGKILL');
  process.once('exit', kill);
  const provider = new JsonRpcProvider(url, 31337, { staticNetwork: true, cacheTimeout: -1, pollingInterval: 50 });
  const deploymentFile = `measure-${process.pid}-${port}.json`;
  const broadcastLog = `${opts.contractsDir}/broadcast/Deploy.s.sol/31337/run-latest.json`;
  const broadcastBackup = `${broadcastLog}.measure-backup`;
  const broadcastDir = `${opts.contractsDir}/broadcast/Deploy.s.sol/31337`;
  const runsBefore = new Set<string>();
  const samples: Measurement[] = [];

  try {
    await waitFor(provider);
    await assertLocalAnvil(provider, url);
    for (const [name, addr] of [['EAS', SEPOLIA_EAS], ['SchemaRegistry', SEPOLIA_SCHEMA_REGISTRY], ['Safe', SAFE_V141.singleton], ['SafeProxyFactory', SAFE_V141.proxyFactory], ['MultiSend', SAFE_V141.multiSend]] as const) {
      if ((await provider.getCode(addr)) === '0x') throw new Error(`${name} has no code at ${addr} on the fork; is the fork URL Sepolia?`);
    }
    const registry = (await new Contract(SEPOLIA_EAS, EAS, provider).getSchemaRegistry!()) as string;
    if (getAddress(registry) !== getAddress(SEPOLIA_SCHEMA_REGISTRY)) throw new Error(`EAS reports schema registry ${registry}, expected ${SEPOLIA_SCHEMA_REGISTRY}`);
    log(`fork of chain ${forkChainId} at block ${forkBlock} on ${url}`);

    const wallet = (i: number) => deriveWallet(opts.experimentMnemonic, i).connect(provider);
    const signer = (i: number): Signer => new NonceManager(wallet(i));
    const indices = [0, 1, 2, 3, 10, 11, 12, ...Array.from({ length: MEASURED_NODES }, (_, i) => 1000 + i)];
    for (const i of indices) await provider.send('anvil_setBalance', [wallet(i).address, toBeHex(parseEther('100'))]);

    const record = async (action: string, sent: Promise<TransactionResponse | ContractTransactionResponse>, note = ''): Promise<TransactionReceipt> => {
      const tx = await sent;
      const r = await tx.wait();
      if (!r || r.status !== 1) throw new Error(`${action} failed in ${tx.hash}`);
      samples.push({ action, gas: r.gasUsed, note, tx: tx.hash });
      log(`  ${String(action).padEnd(26)} ${String(r.gasUsed).padStart(9)} ${note}`);
      return r;
    };
    const advance = async (s: number) => {
      await provider.send('evm_increaseTime', [s]);
      await provider.send('evm_mine', []);
    };

    // Deployment (Deploy.s.sol from the experiment mnemonic). forge's own run log for chain 31337
    // is backed up and restored, so local anvil runs keep theirs.
    mkdirSync(`${opts.contractsDir}/deployments`, { recursive: true });
    if (existsSync(broadcastLog)) copyFileSync(broadcastLog, broadcastBackup);
    for (const f of existsSync(broadcastDir) ? readdirSync(broadcastDir) : []) runsBefore.add(f);
    const deployment: Deployment = await runDeploy({ contractsDir: opts.contractsDir, rpcUrl: url, experimentMnemonic: opts.experimentMnemonic, deploymentFile, provider, plan: opts.plan });
    const run = JSON.parse(readFileSync(broadcastLog, 'utf8')) as { transactions: { hash: string; transactionType: string; contractName?: string; transaction: { input: string } }[]; receipts: { transactionHash: string; gasUsed: string }[] };
    const deployNames: Record<string, Action> = {
      'CREATE:DRIFTCore': 'deployCoreImpl',
      'CREATE:ERC1967Proxy': 'deployCoreProxy',
      'CREATE:DRIFTToken': 'deployToken',
      'CREATE:DRIFTClientFactory': 'deployFactory',
      'CREATE:WeightedGovernanceClient': 'deployTemplate',
      // Calls go through the core proxy, which forge does not decode; match them by selector.
      [`CALL:${id('setDriftToken(address)').slice(0, 10)}`]: 'setDriftToken',
      [`CALL:${id('grantRole(bytes32,address)').slice(0, 10)}`]: 'grantFactoryRole'
    };
    for (const t of run.transactions) {
      const key = `${t.transactionType}:${t.transactionType === 'CREATE' ? t.contractName : t.transaction.input.slice(0, 10)}`;
      const action = deployNames[key];
      if (!action) throw new Error(`unexpected Deploy.s.sol transaction ${key}`);
      const receipt = run.receipts.find((r) => r.transactionHash === t.hash);
      if (!receipt) throw new Error(`no receipt for ${key}`);
      samples.push({ action, gas: BigInt(receipt.gasUsed), note: 'Deploy.s.sol', tx: t.hash });
      log(`  ${action.padEnd(26)} ${String(BigInt(receipt.gasUsed)).padStart(9)} Deploy.s.sol`);
    }

    const deployer = signer(0);
    const core = new Contract(deployment.DRIFTCore, CORE, deployer);
    const factory = new Contract(deployment.Factory, FACTORY, deployer);
    const nodes = Array.from({ length: MEASURED_NODES }, (_, i) => signer(1000 + i));
    const nodeAddr = Array.from({ length: MEASURED_NODES }, (_, i) => wallet(1000 + i).address);
    const owners = [10, 11, 12].map((i) => wallet(i));

    // Safe (Tier 2 settler), 2-of-3, through the real factory.
    const init = SAFE.encodeFunctionData('setup', [owners.map((o) => o.address), 2, ZeroAddress, '0x', SAFE_V141.compatibilityFallbackHandler, ZeroAddress, 0, ZeroAddress]);
    const safeFactory = new Contract(SAFE_V141.proxyFactory, SAFE_FACTORY, deployer);
    const safeReceipt = await record('createSafe', safeFactory.createProxyWithNonce!(SAFE_V141.singleton, init, BigInt(id(`drift-measure-${port}`))), '2-of-3');
    const safe = safeReceipt.logs.map((l) => { try { return SAFE_FACTORY.parseLog(l); } catch { return null; } }).find((p) => p?.name === 'ProxyCreation')!.args.proxy as string;
    await record('fundSafe', deployer.sendTransaction({ to: safe, value: parseEther('0.01') }), 'into the Safe proxy');
    await record('transfer', deployer.sendTransaction({ to: nodeAddr[0], value: 1n }), 'EOA to EOA');

    // Schema. Sepolia already has "uint256 score" registered by someone; a unique field name makes
    // the registration new, at the same storage cost.
    const schemas = new Contract(SEPOLIA_SCHEMA_REGISTRY, SCHEMAS, deployer);
    const schemaDef = `uint256 score, uint256 driftMeasure${port}`;
    // The return value, read by a static call first: the Registered event's layout differs between
    // EAS releases, the return value does not.
    const schemaUID = (await schemas.register!.staticCall(schemaDef, ZeroAddress, true)) as string;
    await record('registerSchema', schemas.register!(schemaDef, ZeroAddress, true), 'two uint256 fields');

    // Two contexts: Tier 1 (EOA settler) and Tier 2 (Safe settler), configured the way the experiment will.
    const settlerAddr = wallet(1).address;
    const setupContext = async (name: string, trustedSettler: string) => {
      const contextUID = (await core.registerContext!.staticCall(`${name}.${port}`)) as string;
      await record('registerContext', core.registerContext!(`${name}.${port}`), name);
      const initData = CLIENT.encodeFunctionData('initialize', [deployment.DRIFTCore, deployment.DRIFTToken, contextUID, trustedSettler, 0, 0, 'EigenTrust', [ROLE], [10_000]]);
      // The clone's address is deterministic (salt = contextUID), so a static call gives it.
      const clientAddr = (await factory.deployClient!.staticCall(contextUID, deployment.WeightedGovernanceTemplate, initData, contextUID)) as string;
      await record('deployClientClone', factory.deployClient!(contextUID, deployment.WeightedGovernanceTemplate, initData, contextUID), name);
      const client = new Contract(clientAddr, CLIENT, deployer);
      await record('grantContextAdmin', core.grantRole!(await core.contextAdminRole!(contextUID), clientAddr), name);
      await record('setDisputeWindow', client.setDisputeWindow!(DISPUTE_WINDOW), name);
      await record('setResponseWindow', client.setResponseWindow!(RESPONSE_WINDOW), name);
      await record('setSettlementBond', client.setSettlementBond!(parseEther('0.001')), name);
      await record('setChallengeBond', client.setChallengeBond!(parseEther('0.001')), name);
      await record('setResponseGasEstimate', client.setResponseGasEstimate!(60_000), name);
      for (let i = 0; i < MEASURED_NODES; i++) {
        await record('registerNode', new Contract(deployment.DRIFTCore, CORE, nodes[i]).registerNode!(contextUID, '0x'), `${name} node ${i}`);
        await record('assignRole', client.assignRole!(nodeAddr[i], ROLE), `${name} node ${i}`);
      }
      await record('setEpochLength', client.setEpochLength!(EPOCH_LENGTH), name);
      return { contextUID, client, clientAddr };
    };
    const t1 = await setupContext('tier1', settlerAddr);
    const t2 = await setupContext('tier2', safe);

    // Attestations: single attest (first and repeat by one attester), then multiAttest batches.
    const eas = (s: Signer) => new Contract(SEPOLIA_EAS, EAS, s);
    const item = (to: string, v: number) => ({ recipient: to, expirationTime: 0, revocable: true, refUID: ZeroHash, data: AbiCoder.defaultAbiCoder().encode(['uint256', 'uint256'], [v, 0]), value: 0 });
    await record('easAttest', eas(nodes[0]!).attest!({ schema: schemaUID, data: item(nodeAddr[1]!, 50) }), 'first by this attester');
    await record('easAttest', eas(nodes[0]!).attest!({ schema: schemaUID, data: item(nodeAddr[2]!, 30) }), 'repeat');
    for (const k of MULTI_ATTEST_SIZES) {
      const data = Array.from({ length: k }, (_, j) => item(nodeAddr[(j % (MEASURED_NODES - 1)) + 1]!, 10 + j));
      await record(`easMultiAttest${k}`, eas(nodes[1 + (k % 3)]!).multiAttest!([{ schema: schemaUID, data }]), `${k} attestation(s) in one tx`);
    }

    // Tier 1 epoch 1: a full tree padded to TREE_LEAVES leaves.
    const settler = new DriftSettler(wallet(1));
    const trees = new Map<string, EpochTree>();
    const upload = async (tree: EpochTree) => {
      const uri = `ipfs://measure-${tree.root.slice(2, 18)}`;
      trees.set(uri, tree);
      return uri;
    };
    const pad = (n: number): ScoreEntry[] => Array.from({ length: n }, (_, i) => ({ node: getAddress(toBeHex(0xd00d0000n + BigInt(i), 20)), role: ROLE, score: 1n }));
    const scores = (except?: string): ScoreEntry[] => {
      const real = nodeAddr.filter((a) => a !== except).map((node, i) => ({ node, role: ROLE, score: BigInt(100 + i) }));
      return [...real, ...pad(TREE_LEAVES - real.length)];
    };
    await advance(EPOCH_LENGTH + 1);
    const e1 = await settler.buildAndSignEpochRoot(t1.clientAddr, t1.contextUID, 1n, scores(), upload);
    const t1Settler = new Contract(t1.clientAddr, CLIENT, signer(1));
    const t1Hot = new Contract(t1.clientAddr, CLIENT, signer(2));
    await record('postEpochRoot', t1Settler.postEpochRoot!(1n, e1.root, e1.treeURI, e1.signature, { value: parseEther('0.001') }), `${TREE_LEAVES} leaves`);

    // A challenge against an included pair, answered by the hot wallet (proof depth 7).
    const bond = (await t1.client.requiredChallengeBond!()) as bigint;
    await record('challengeOmission', new Contract(t1.clientAddr, CLIENT, nodes[0]).challengeOmission!(1n, nodeAddr[0], ROLE, { value: bond }), 'self-challenge');
    const resp = settler.generateChallengeResponse(e1.tree, t1.contextUID, nodeAddr[0]!, ROLE, 1n);
    await record('respondToChallenge', t1Hot.respondToChallenge!(1n, nodeAddr[0], ROLE, resp.score, resp.proof), `proof depth ${resp.proof.length}`);

    await advance(DISPUTE_WINDOW + 1);
    await record('withdrawSettlementBond', t1Hot.withdrawSettlementBond!(1n));
    for (const i of [1, 2]) {
      const p = settler.generateProofOfStatePayload(e1.tree, t1.contextUID, nodeAddr[i]!, 1n);
      await record('claimReputation', new Contract(t1.clientAddr, CLIENT, nodes[i]).claimReputation!(nodeAddr[i], p.roles[0], p.scores[0], 1n, p.proofs[0]), `node ${i}, depth ${p.proofs[0]!.length}`);
    }
    const proposer = settler.generateProofOfStatePayload(e1.tree, t1.contextUID, nodeAddr[3]!, 1n);
    const created = await record('createProposal', new Contract(t1.clientAddr, CLIENT, nodes[3]).createProposalWithProofs!('measure', ZeroAddress, '0x', 1, proposer.roles, proposer.scores, proposer.proofs));
    const proposalId = created.logs.map((l) => { try { return CLIENT.parseLog(l); } catch { return null; } }).find((p) => p?.name === 'ProposalCreated')!.args.id as bigint;
    for (const i of [4, 5]) {
      const p = settler.generateProofOfStatePayload(e1.tree, t1.contextUID, nodeAddr[i]!, 1n);
      await record('castVote', new Contract(t1.clientAddr, CLIENT, nodes[i]).castVoteWithProofs!(proposalId, true, p.roles, p.scores, p.proofs), `node ${i}`);
    }

    // Tier 1 epoch 2: a root omitting node 4, which self-challenges; unanswered, it is claimed.
    await advance(EPOCH_LENGTH);
    const e2 = await settler.buildAndSignEpochRoot(t1.clientAddr, t1.contextUID, 2n, scores(nodeAddr[4]), upload);
    await record('postEpochRoot', t1Settler.postEpochRoot!(2n, e2.root, e2.treeURI, e2.signature, { value: parseEther('0.001') }), 'second epoch');
    await record('challengeOmission', new Contract(t1.clientAddr, CLIENT, nodes[4]).challengeOmission!(2n, nodeAddr[4], ROLE, { value: bond }), 'omitted pair');
    await advance(RESPONSE_WINDOW + 1);
    await record('claimUnansweredChallenge', new Contract(t1.clientAddr, CLIENT, nodes[4]).claimUnansweredChallenge!(2n, nodeAddr[4], ROLE));

    // Tier 2: one-round settlement through the Safe, two owner signatures, executed by the hot wallet.
    const domainSettler = new DriftSettler(wallet(1));
    const t2Tree = await domainSettler.buildAndSignEpochRoot(t2.clientAddr, t2.contextUID, 1n, scores(), upload);
    const safeSettler = new SafeSettler(provider, safe, t2.clientAddr);
    const prepared = await safeSettler.prepare({ contextUID: t2.contextUID, epoch: 1n, merkleRoot: t2Tree.root, treeURI: t2Tree.treeURI, bond: parseEther('0.001') });
    const sigs = [await safeSettler.sign(owners[0]!, prepared.tx), await safeSettler.sign(owners[2]!, prepared.tx)];
    await record('safeExecSettlement', safeSettler.execute(signer(3), prepared.tx, sigs), '2-of-3, one round');
    return { forkBlock, forkChainId, date: new Date().toISOString(), samples };
  } finally {
    provider.destroy();
    kill();
    rmSync(`${opts.contractsDir}/deployments/${deploymentFile}`, { force: true });
    if (existsSync(broadcastBackup)) {
      copyFileSync(broadcastBackup, broadcastLog);
      rmSync(broadcastBackup, { force: true });
    } else rmSync(broadcastLog, { force: true });
    // forge also keeps a timestamped copy of each run; drop the ones this measurement created.
    for (const f of existsSync(broadcastDir) ? readdirSync(broadcastDir) : []) {
      if (!runsBefore.has(f) && f !== 'run-latest.json') rmSync(`${broadcastDir}/${f}`, { force: true });
    }
  }
}

/**
 * Collapses samples into the measured gas table: the largest sample per action (the first call
 * usually pays for new storage), plus a fit of the multiAttest samples, gas(k) = base + perItem x k,
 * chosen so that it is at or above every measured batch size.
 */
export function measuredTable(result: MeasureResult): Record<string, { gas: string; note: string; samples: string[] }> {
  const by = new Map<string, Measurement[]>();
  for (const s of result.samples) by.set(String(s.action), [...(by.get(String(s.action)) ?? []), s]);
  const out: Record<string, { gas: string; note: string; samples: string[] }> = {};
  for (const [action, ms] of by) {
    if (action.startsWith('easMultiAttest')) continue;
    const max = ms.reduce((m, s) => (s.gas > m ? s.gas : m), 0n);
    out[action] = { gas: max.toString(), note: `max of ${ms.length} sample(s) on a Sepolia fork at block ${result.forkBlock}`, samples: ms.map((s) => s.gas.toString()) };
  }
  const multi = MULTI_ATTEST_SIZES.map((k) => ({ k, gas: by.get(`easMultiAttest${k}`)?.[0]?.gas }));
  if (multi.every((m) => m.gas !== undefined)) {
    const first = multi[0]!, last = multi[multi.length - 1]!;
    const perItem = (last.gas! - first.gas! + BigInt(last.k - first.k) - 1n) / BigInt(last.k - first.k);
    const base = multi.reduce((m, x) => { const b = x.gas! - perItem * BigInt(x.k); return b > m ? b : m; }, 0n);
    const samples = multi.map((m) => `${m.k}:${m.gas}`);
    out.easMultiAttestBase = { gas: base.toString(), note: `fit over multiAttest k=${MULTI_ATTEST_SIZES.join(',')}`, samples };
    out.easMultiAttestPerItem = { gas: perItem.toString(), note: 'per attestation in a multiAttest', samples };
  }
  return out;
}

export function writeMeasured(path: string, result: MeasureResult): void {
  writeFileSync(
    path,
    JSON.stringify({ version: 1, source: 'measured', forkChainId: result.forkChainId.toString(), forkBlock: result.forkBlock, date: result.date, actions: measuredTable(result) }, null, 2) + '\n'
  );
}

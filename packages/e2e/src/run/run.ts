import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { AbiCoder, Contract, Interface, ZeroAddress, type HDNodeWallet, type JsonRpcProvider, type TransactionReceipt } from 'ethers';
import { StandardMerkleTree } from '@openzeppelin/merkle-tree';
import { DriftSettler, checkEpochSynchronized } from '@drift-network/sdk';
import { EASProvider } from '@drift-network/sdk/providers';
import { LocalEpochEngine, type IEpochEngine } from '@drift-network/sdk/engines';
import { EPOCH_LEAF_ENCODING, IPFSTreeTransport, resolveEpochTree } from '@drift-network/sdk/merkle';
import { HttpSettlementRelay, JsonlSink, Recorder, RecordingWallet, loadEpochSnapshot, settleEpochTier1, tier2ProposalId, type ScopedRecorder } from '@drift-network/operator';
import type { ExperimentConfig } from '../config.js';
import { LAYOUT, deriveWallet } from '../keys.js';
import { TxJournal, inParallel, saveJson, type StepRecord } from '../journal.js';
import type { DeployManifest } from '../setup.js';
import type { Log } from '../ops.js';
import { FastClock, RealClock, type Clock } from './clock.js';
import { DaemonManager, daemonSpecs, type RunServices, type RunTiming } from './daemons.js';
import { attestScore, attestSubjects, claimers, proposals, scenarioEpochs, waveEpochs, type ProposalPlan } from './workload.js';

const CLIENT = new Interface([
  'function currentEpoch() view returns (uint256)',
  'function epochRoots(uint256) view returns (bytes32)',
  'function epochPostedAtTimestamp(uint256) view returns (uint256)',
  'function epochBondAmount(uint256) view returns (uint256)',
  'function openChallengeCount(uint256) view returns (uint256)',
  'function challenges(uint256 epoch, address node, bytes32 role) view returns (uint256 openedAtTimestamp, uint256 bond, address challenger, bool resolved)',
  'function requiredChallengeBond() view returns (uint256)',
  'function lastClaimedEpoch(address node, bytes32 role) view returns (uint256)',
  'function hasVoted(uint256 proposalId, address account) view returns (bool)',
  'function challengeOmission(uint256 epoch, address missingNode, bytes32 role) payable',
  'function claimUnansweredChallenge(uint256 epoch, address node, bytes32 role)',
  'function claimReputation(address node, bytes32 role, uint256 score, uint256 epoch, bytes32[] proof)',
  'function createProposalWithProofs(string description, address target, bytes payload, uint256 durationInDays, bytes32[] roles, uint256[] scores, bytes32[][] proofs) returns (uint256)',
  'function castVoteWithProofs(uint256 proposalId, bool support, bytes32[] roles, uint256[] scores, bytes32[][] proofs)',
  'event ProposalCreated(uint256 indexed id, string description, uint256 deadline, uint256 snapshotEpoch, uint32 configVersion)'
]);
const EAS = new Interface([
  'function multiAttest((bytes32 schema, (address recipient, uint64 expirationTime, bool revocable, bytes32 refUID, bytes data, uint256 value)[] data)[] multiRequests) payable returns (bytes32[])'
]);
const SAFE = new Interface(['function nonce() view returns (uint256)']);

type TierName = 'tier1' | 'tier2';

interface RunState {
  version: 1;
  runTag: string;
  chainId: string;
  steps: Record<string, StepRecord>;
  /** Phase-level progress, for a fast resume: tasks skip what is marked here. */
  marks: Record<string, true>;
}

export interface RunOptions {
  cfg: ExperimentConfig;
  manifest: DeployManifest;
  mnemonic: string;
  provider: JsonRpcProvider;
  stateDir: string;
  mode: 'real' | 'rehearsal';
  services: RunServices;
  timing: RunTiming;
  log: Log;
  /** How long a poll for a daemon's progress may take before the run stops with a diagnosis. */
  stallMs?: number;
}

export interface RunSummary {
  epochs: Record<TierName, number>;
  scenarios: Record<string, number[]>;
  eventsDir: string;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Runs the experiment workload against a deployed experiment: starts the operator daemons, then
 * drives the members (attestation waves, claims after each finalized epoch, proposals and votes)
 * and the adversarial scenarios, following each tier epoch by epoch. Every member transaction
 * goes through a TxJournal, so a crashed run resumes where it stopped without duplicates.
 */
export async function runExperiment(o: RunOptions): Promise<RunSummary> {
  const { cfg, manifest: m, provider, log } = o;
  mkdirSync(o.stateDir, { recursive: true });
  const statePath = join(o.stateDir, 'run-state.json');
  const state: RunState = existsSync(statePath)
    ? (JSON.parse(readFileSync(statePath, 'utf8')) as RunState)
    : { version: 1, runTag: cfg.runTag, chainId: m.chainId, steps: {}, marks: {} };
  if (state.runTag !== cfg.runTag || state.chainId !== m.chainId) throw new Error(`${statePath} belongs to run ${state.runTag} on chain ${state.chainId}`);
  const save = () => saveJson(statePath, state);
  save();
  const mark = (k: string) => {
    state.marks[k] = true;
    save();
  };

  const chainId = BigInt(m.chainId);
  const journal = new TxJournal({ provider, chainId, steps: state.steps, save, maxFeeWei: cfg.gas.maxFeeWei, priorityFeeWei: cfg.gas.priorityFeeWei, log, waitMs: 6 * 60 * 60_000, receiptPollMs: o.mode === 'rehearsal' ? 100 : 3_000 });
  const eventsDir = join(o.stateDir, 'events');
  mkdirSync(eventsDir, { recursive: true });
  const recorder = new Recorder([new JsonlSink(eventsDir, cfg.runTag, 'members')], cfg.runTag, 'members');
  const clock: Clock = o.mode === 'rehearsal' ? new FastClock(provider) : new RealClock(provider);
  const stallMs = o.stallMs ?? (o.mode === 'rehearsal' ? 5 * 60_000 : 3 * 60 * 60_000);
  const pollMs = o.mode === 'rehearsal' ? 250 : 10_000;

  const wallet = (index: number): HDNodeWallet => deriveWallet(o.mnemonic, index).connect(provider);
  const node = (i: number) => wallet(LAYOUT.nodeBase + i);
  const client = (tier: TierName) => new Contract(m.contexts[tier]!.client, CLIENT, provider);
  const role = m.role;
  const view = async <T>(c: Contract, fn: string, ...args: unknown[]) => (await c.getFunction(fn).staticCall(...args)) as T;

  // One transaction at a time per key: tasks run concurrently and share node keys.
  const locks = new Map<string, Promise<unknown>>();
  const withKey = <T>(addr: string, fn: () => Promise<T>): Promise<T> => {
    const prev = locks.get(addr) ?? Promise.resolve();
    const run = prev.then(fn, fn);
    locks.set(addr, run.catch(() => undefined));
    return run;
  };
  const send = (id: string, signer: HDNodeWallet, req: { to: string; data?: string; value?: bigint }, isDone: () => Promise<boolean>, rec: ScopedRecorder, action: string, result?: (r: TransactionReceipt) => string | undefined) =>
    withKey(signer.address, () => journal.step(id, signer, req, isDone, { record: { recorder: rec, action }, verbose: false, result }));
  const txOnly = (id: string) => async () => {
    const r = state.steps[id];
    return !!r?.tx && (await provider.getTransactionReceipt(r.tx))?.status === 1;
  };

  /** Polls `cond` until true; past the stall limit, stops with what the daemons report. */
  const daemons = new DaemonManager(daemonSpecs({ cfg, manifest: m, mnemonic: o.mnemonic, services: o.services, timing: o.timing, stateDir: o.stateDir, eventsDir, runId: cfg.runTag }), o.stateDir, log);
  const waitFor = async (what: string, cond: () => Promise<boolean>) => {
    const deadline = Date.now() + stallMs;
    while (!(await cond())) {
      if (Date.now() > deadline) {
        const statuses = await Promise.all(
          daemons.names().map(async (n) => {
            const url = daemons.spec(n).apiUrl;
            if (!url) return `${n}: ${daemons.running(n) ? 'running' : 'stopped'}`;
            try {
              const s = (await (await fetch(`${url}/status`)).json()) as { contexts: { nextAction?: string; lastError?: string }[] };
              return `${n}: ${s.contexts.map((c) => c.lastError ?? c.nextAction).join('; ')}`;
            } catch {
              return `${n}: no status`;
            }
          })
        );
        throw new Error(`stalled waiting for ${what}:\n  ${statuses.join('\n  ')}`);
      }
      await sleep(pollMs);
    }
  };

  const scenarios = scenarioEpochs(cfg);
  if (cfg.adversarial.omissionChallenges > 0) log('note: adversarial.omissionChallenges (node self-challenges) is planned for but not driven by this runner; use watcherChallenges');

  // PROOFS ======================================================================

  const transport = new IPFSTreeTransport({ gatewayUrl: o.services.ipfsGatewayUrl });
  const apiOf = (tier: TierName) => daemons.spec(tier === 'tier1' ? 'tier1-settler' : 'tier2-owner-0').apiUrl!;
  /** A node's leaf and proof for `epoch`: from the operator API, checked against the on-chain root; IPFS if the API fails. */
  const proofOf = async (tier: TierName, epoch: number, n: string): Promise<{ score: bigint; proof: string[]; ms: number }> => {
    const ctx = m.contexts[tier]!;
    const t0 = performance.now();
    const root = await view<string>(client(tier), 'epochRoots', epoch);
    const check = (score: string, proof: string[]) => StandardMerkleTree.verify(root, EPOCH_LEAF_ENCODING, [ctx.contextUID.toLowerCase(), n.toLowerCase(), role.toLowerCase(), score, String(epoch)], proof);
    try {
      const res = await fetch(`${apiOf(tier)}/contexts/${ctx.client}/epochs/${epoch}/proofs/${n}`);
      if (res.ok) {
        const body = (await res.json()) as { leaves: { role: string; score: string; proof: string[] }[] };
        const leaf = body.leaves.find((l) => l.role.toLowerCase() === role.toLowerCase());
        if (leaf && check(leaf.score, leaf.proof)) return { score: BigInt(leaf.score), proof: leaf.proof, ms: performance.now() - t0 };
        log(`  proof for ${n} at ${tier} epoch ${epoch} from the API does not verify; resolving the tree from chain`);
      }
    } catch {
      // fall through to the tree on IPFS
    }
    const { tree } = await resolveEpochTree(provider, ctx.client, BigInt(epoch), transport, { fromBlock: m.startBlock });
    for (const [i, v] of tree.entries()) {
      if (v[1]!.toLowerCase() === n.toLowerCase() && v[2]!.toLowerCase() === role.toLowerCase()) {
        return { score: BigInt(v[3]!), proof: tree.getProof(i), ms: performance.now() - t0 };
      }
    }
    throw new Error(`no leaf for ${n} in the ${tier} tree of epoch ${epoch}`);
  };

  // MEMBERS =====================================================================

  const claimFor = async (tier: TierName, epoch: number) => {
    const c = client(tier);
    const rec = recorder.scope({ context: tier, tier: 'client', epoch: BigInt(epoch) });
    await inParallel(claimers(cfg, tier, epoch), 8, async (i) => {
      const w = node(i);
      const id = `claim:${tier}:${epoch}:${i}`;
      const isDone = async () => (await view<bigint>(c, 'lastClaimedEpoch', w.address, role)) >= BigInt(epoch);
      if (journal.isDone(id) || (await isDone())) return;
      const p = await proofOf(tier, epoch, w.address);
      rec.emit('client.claim', { node: w.address, role, proofFetchMs: Math.round(p.ms), proofDepth: p.proof.length });
      await send(id, w, { to: m.contexts[tier]!.client, data: CLIENT.encodeFunctionData('claimReputation', [w.address, role, p.score, epoch, p.proof]) }, isDone, rec, 'client.claim');
    });
  };

  const governFor = async (pp: ProposalPlan) => {
    const tier = pp.tier;
    const c = client(tier);
    const rec = recorder.scope({ context: tier, tier: 'client', epoch: BigInt(pp.epoch) });
    const description = `drift-e2e:${cfg.runTag}:proposal-${pp.index}`;
    const createId = `propose:${pp.index}`;
    const findCreated = async (): Promise<string | undefined> => {
      if (journal.result(createId)) return journal.result(createId);
      const logs = await provider.getLogs({ address: m.contexts[tier]!.client, topics: [CLIENT.getEvent('ProposalCreated')!.topicHash], fromBlock: m.startBlock });
      const hit = logs.map((l) => CLIENT.parseLog(l)!).find((e) => e.args.description === description);
      return hit ? (hit.args.id as bigint).toString() : undefined;
    };
    let proposalId = await findCreated();
    if (!proposalId) {
      const w = node(pp.proposer);
      const p = await proofOf(tier, pp.epoch, w.address);
      const data = CLIENT.encodeFunctionData('createProposalWithProofs', [description, ZeroAddress, '0x', 1, [role], [p.score], [p.proof]]);
      await send(createId, w, { to: m.contexts[tier]!.client, data }, async () => (await findCreated()) !== undefined, rec, 'client.propose', (r) => {
        const e = r.logs.map((l) => { try { return CLIENT.parseLog(l); } catch { return null; } }).find((x) => x?.name === 'ProposalCreated');
        return e ? (e.args.id as bigint).toString() : undefined;
      });
      proposalId = await findCreated();
      if (!proposalId) throw new Error(`proposal ${pp.index} was not created`);
    }
    await inParallel(pp.voters, 8, async (v) => {
      const w = node(v);
      const id = `vote:${pp.index}:${v}`;
      const isDone = () => view<boolean>(c, 'hasVoted', BigInt(proposalId), w.address);
      if (journal.isDone(id) || (await isDone())) return;
      const p = await proofOf(tier, pp.epoch, w.address);
      rec.emit('client.vote', { node: w.address, proposalId, proofFetchMs: Math.round(p.ms), proofDepth: p.proof.length });
      await send(id, w, { to: m.contexts[tier]!.client, data: CLIENT.encodeFunctionData('castVoteWithProofs', [BigInt(proposalId), true, [role], [p.score], [p.proof]]) }, isDone, rec, 'client.vote');
    });
  };

  const anchor = Math.min(...Object.values(m.contexts).map((c) => c.epochAnchorTimestamp));
  const len = cfg.timing.epochLengthSeconds;
  const attestTask = async () => {
    const rec = recorder.scope({ tier: 'client' });
    const coder = AbiCoder.defaultAbiCoder();
    for (const [wave, epoch] of waveEpochs(cfg).entries()) {
      const key = `wave:${wave}`;
      if (state.marks[key]) continue;
      await clock.until(anchor + len * (epoch - 1) + Math.floor(len / 6));
      await inParallel(Array.from({ length: cfg.nodes }, (_, i) => i), 16, async (i) => {
        const subjects = attestSubjects(cfg, i, wave);
        for (let b = 0; b * cfg.attestations.batch < subjects.length; b++) {
          const chunk = subjects.slice(b * cfg.attestations.batch, (b + 1) * cfg.attestations.batch);
          const items = chunk.map((s) => ({ recipient: m.nodes[s]!, expirationTime: 0, revocable: true, refUID: '0x' + '00'.repeat(32), data: coder.encode(['uint256', 'uint256'], [attestScore(i, s, wave), 0]), value: 0 }));
          const id = `attest:${wave}:${i}:${b}`;
          if (journal.isDone(id)) continue;
          rec.emit('client.attest', { attester: m.nodes[i], subjects: chunk.map((s) => m.nodes[s]) });
          await send(id, node(i), { to: m.eas.address, data: EAS.encodeFunctionData('multiAttest', [[{ schema: m.eas.schemaUID, data: items }]]) }, txOnly(id), rec, 'client.attest');
        }
      });
      mark(key);
      log(`attestation wave ${wave + 1}/${cfg.attestations.rounds} sent`);
    }
  };

  // TIERS =======================================================================

  const posted = async (tier: TierName, e: number) => (await view<string>(client(tier), 'epochRoots', e)) !== '0x' + '00'.repeat(32);
  const finalized = async (tier: TierName, e: number) => {
    const c = client(tier);
    const [postedAt, open] = await Promise.all([view<bigint>(c, 'epochPostedAtTimestamp', e), view<bigint>(c, 'openChallengeCount', e)]);
    return (await posted(tier, e)) && open === 0n && BigInt(await clock.now()) > postedAt + BigInt(m.contexts[tier]!.disputeWindow);
  };
  const synced = async (tier: TierName, e: number) => (await checkEpochSynchronized(provider, m.contexts[tier]!.client, BigInt(e), o.timing.blockTag)).synced;
  const props = proposals(cfg);

  const finishEpoch = async (tier: TierName, e: number) => {
    const ctx = m.contexts[tier]!;
    const postedAt = Number(await view<bigint>(client(tier), 'epochPostedAtTimestamp', e));
    await clock.until(postedAt + ctx.disputeWindow + 1);
    await waitFor(`${tier} epoch ${e} to finalize`, () => finalized(tier, e));
    await claimFor(tier, e);
    for (const pp of props.filter((p) => p.tier === tier && p.epoch === e)) await governFor(pp);
  };

  /** Tier 1 scenario: a node challenges its own included pair; the settler daemon answers. */
  const spuriousChallenge = async (e: number) => {
    const i = 0;
    const w = node(i);
    const c = client('tier1');
    const rec = recorder.scope({ context: 'tier1', tier: 'client', epoch: BigInt(e) });
    const id = `scenario:answered:${e}`;
    const opened = async () => ((await view<[bigint]>(c, 'challenges', e, w.address, role))[0] ?? 0n) > 0n;
    const bond = await view<bigint>(c, 'requiredChallengeBond');
    await send(id, w, { to: ctxOf('tier1').client, data: CLIENT.encodeFunctionData('challengeOmission', [e, w.address, role]), value: bond }, opened, rec, 'challenge.open');
    await waitFor(`the settler to answer the challenge at tier1 epoch ${e}`, async () => (await view<[bigint, bigint, string, boolean]>(c, 'challenges', e, w.address, role))[3]);
    log(`tier1 epoch ${e}: spurious challenge answered by the settler`);
  };
  const ctxOf = (tier: TierName) => m.contexts[tier]!;

  /** Tier 1 scenario: a settler posts a root omitting the watcher's pair; the watcher challenges; nobody answers; the challenge is claimed. */
  const omission = async (e: number) => {
    const c = client('tier1');
    const watcher = m.watcher!;
    const rec = recorder.scope({ context: 'tier1', tier: 'watcher', epoch: BigInt(e) });
    const settlerRec = recorder.scope({ context: 'tier1', tier: 'tier1', epoch: BigInt(e) });
    const challenge = () => view<[bigint, bigint, string, boolean]>(c, 'challenges', e, watcher, role);
    if (!state.marks[`omission:${e}:posted`]) {
      await clock.until(ctxOf('tier1').epochAnchorTimestamp + ctxOf('tier1').epochLength * e + 1);
      await waitFor(`O1 for tier1 epoch ${e}`, () => synced('tier1', e));
      if (!(await posted('tier1', e))) {
        const settler = new RecordingWallet(deriveWallet(o.mnemonic, LAYOUT['tier1-settler']).privateKey, provider, settlerRec);
        const skewed: IEpochEngine = {
          computeEpoch: (input) => new LocalEpochEngine().computeEpoch({ ...input, members: input.members.filter((x) => x.node.toLowerCase() !== watcher.toLowerCase()) })
        };
        const snapshot = await loadEpochSnapshot({
          provider,
          client: ctxOf('tier1').client,
          epoch: BigInt(e),
          attestations: new EASProvider(o.services.easGraphqlUrl, m.eas.schemaUID),
          schemaUID: m.eas.schemaUID,
          schemaDefinition: m.eas.schemaDefinition,
          blockTag: o.timing.blockTag,
          fromBlock: m.startBlock
        });
        const ipfs = new IPFSTreeTransport({ apiUrl: o.services.ipfsApiUrl, gatewayUrl: o.services.ipfsGatewayUrl });
        await settlerRec.action('settle.post', () => settleEpochTier1({ settler: new DriftSettler(settler), client: ctxOf('tier1').client, snapshot, engine: skewed, transport: ipfs }));
      }
      mark(`omission:${e}:posted`);
      log(`tier1 epoch ${e}: misbehaving settler posted a root omitting the watcher's pair`);
    }
    await waitFor(`the watcher to challenge the omission at tier1 epoch ${e}`, async () => (await challenge())[0] > 0n);
    const openedAt = Number((await challenge())[0]);
    await clock.until(openedAt + ctxOf('tier1').responseWindow + 1);
    const id = `scenario:claim-unanswered:${e}`;
    if (!journal.isDone(id)) {
      // The watcher daemon sends from the same key; pause it so the nonces cannot collide.
      await daemons.stop('watcher');
      await send(id, wallet(LAYOUT['watcher-hot']), { to: ctxOf('tier1').client, data: CLIENT.encodeFunctionData('claimUnansweredChallenge', [e, watcher, role]) }, async () => (await challenge())[3], rec, 'challenge.claim');
      rec.emit('challenge.claimed', { epoch: e, node: watcher, role });
      await daemons.start('watcher');
    }
    log(`tier1 epoch ${e}: omission claimed unanswered; the epoch rolled back`);
  };

  const tier1Task = async () => {
    const ctx = ctxOf('tier1');
    for (let e = 1; e <= cfg.tier1.epochs; e++) {
      if (state.marks[`tier1:${e}`]) continue;
      if (scenarios.omission.includes(e) && !state.marks[`omission:${e}:done`]) {
        await daemons.stop('tier1-settler');
        if (await posted('tier1', e)) {
          log(`tier1 epoch ${e} was settled before the omission scenario could run; skipping it`);
        } else {
          await omission(e);
        }
        mark(`omission:${e}:done`);
        await daemons.start('tier1-settler');
      }
      await clock.until(ctx.epochAnchorTimestamp + ctx.epochLength * e + 1);
      await waitFor(`tier1 epoch ${e} to be posted`, () => posted('tier1', e));
      if (scenarios.answered.includes(e)) await spuriousChallenge(e);
      await finishEpoch('tier1', e);
      mark(`tier1:${e}`);
      log(`tier1 epoch ${e}/${cfg.tier1.epochs} final`);
    }
  };

  const tier2Task = async () => {
    const ctx = ctxOf('tier2');
    const others = daemons.names().filter((n) => n.startsWith('tier2-owner-') && n !== 'tier2-owner-0');
    for (let e = 1; e <= cfg.tier2.epochs; e++) {
      if (state.marks[`tier2:${e}`]) continue;
      const dead = scenarios.deadRound.includes(e) && !state.marks[`dead:${e}`];
      if (dead) for (const n of others) await daemons.stop(n);
      await clock.until(ctx.epochAnchorTimestamp + ctx.epochLength * e + 1);
      if (dead) {
        // Owner 0 proposes round 0 alone, commits and reveals alone: one reveal is below the
        // threshold, so the round dies at its reveal deadline. The others come back for round 1.
        const relay = new HttpSettlementRelay(apiOf('tier2'));
        const nonce = (await new Contract(m.safe!.address, SAFE, provider).nonce!()) as bigint;
        const pid = tier2ProposalId(ctx.client, ctx.contextUID, BigInt(e), nonce, 0n);
        let deadline = 0n;
        await waitFor(`round 0 of tier2 epoch ${e} to be proposed`, async () => {
          const p = await relay.getProposal(pid);
          if (p) deadline = p.revealDeadline;
          return !!p;
        });
        while (BigInt(Math.floor(Date.now() / 1000)) <= deadline) await sleep(500);
        for (const n of others) await daemons.start(n);
        mark(`dead:${e}`);
        log(`tier2 epoch ${e}: round 0 left to die with one owner; the others are back for round 1`);
      }
      await waitFor(`tier2 epoch ${e} to be posted`, () => posted('tier2', e));
      await finishEpoch('tier2', e);
      mark(`tier2:${e}`);
      log(`tier2 epoch ${e}/${cfg.tier2.epochs} final`);
    }
  };

  // The first task to fail stops the run: the others would otherwise keep going (and keep
  // spending) on an experiment whose results are already incomplete.
  let failure: Error | undefined;
  let failed: () => void = () => {};
  const aborted = new Promise<void>((r) => (failed = r));
  const task = async (name: string, fn: () => Promise<void>) => {
    clock.join();
    try {
      await fn();
    } catch (err) {
      failure ??= new Error(`${name}: ${(err as Error).message}`, { cause: err });
      failed();
    } finally {
      clock.leave();
    }
  };

  // Ctrl-C or a kill must not leave daemons behind: stop them, then exit (which also runs the
  // other exit handlers, e.g. the rehearsal's anvil). A re-run resumes from the state file.
  const onExit = () => daemons.killAllSync();
  const onSignal = (sig: NodeJS.Signals) => {
    log(`${sig}: stopping the daemons; re-run the same command to resume`);
    daemons.killAllSync();
    process.exit(130);
  };
  process.once('exit', onExit);
  process.once('SIGINT', onSignal);
  process.once('SIGTERM', onSignal);
  try {
    await daemons.startAll();
    log(`daemons running: ${daemons.names().join(', ')}`);
    const tasks: Promise<void>[] = [task('attestations', attestTask)];
    if (cfg.tier1.epochs > 0) tasks.push(task('tier1', tier1Task));
    if (cfg.tier2.epochs > 0) tasks.push(task('tier2', tier2Task));
    await Promise.race([Promise.all(tasks), aborted]);
    if (failure) throw failure;

    // Bonds come back once each epoch is final; the daemons withdraw them on their next ticks.
    for (const tier of ['tier1', 'tier2'] as const) {
      const epochs = tier === 'tier1' ? cfg.tier1.epochs : cfg.tier2.epochs;
      if (epochs === 0) continue;
      await waitFor(`${tier} bonds to be withdrawn`, async () => {
        for (let e = Math.max(1, epochs - 64); e <= epochs; e++) if ((await view<bigint>(client(tier), 'epochBondAmount', e)) > 0n) return false;
        return true;
      });
    }
    return { epochs: { tier1: cfg.tier1.epochs, tier2: cfg.tier2.epochs }, scenarios, eventsDir };
  } finally {
    await daemons.stopAll();
    process.removeListener('exit', onExit);
    process.removeListener('SIGINT', onSignal);
    process.removeListener('SIGTERM', onSignal);
  }
}

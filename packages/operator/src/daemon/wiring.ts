import * as path from 'path';
import { Contract, JsonRpcProvider, type Provider, type Signer } from 'ethers';
import type { Logger } from 'pino';
import { DriftConfigError, DriftSettler, type IAttestationProvider } from '@drift-network/sdk';
import { EASProvider } from '@drift-network/sdk/providers';
import { LocalEpochEngine, type IEpochEngine } from '@drift-network/sdk/engines';
import { IPFSTreeTransport, resolveEpochTree, type IMerkleStore, type ITreeTransport } from '@drift-network/sdk/merkle';
import { GrpcEpochEngine } from '../engines/GrpcEpochEngine.js';
import { LocalTreeStore } from '../store/LocalTreeStore.js';
import { loadEpochSnapshot } from '../pipeline/snapshot.js';
import { settleEpochTier1 } from '../pipeline/tier1.js';
import {
  commitEpochTier2,
  executeEpochTier2,
  proposeEpochTier2,
  publishEpochTreeTier2,
  revealEpochTier2,
  signEpochTier2,
  type OwnerCompute,
  type Tier2Base
} from '../pipeline/tier2.js';
import { FileSettlementRelay, type ISettlementRelay } from '../pipeline/relay.js';
import { HttpSettlementRelay } from '../relay/http.js';
import { buildApi, type ApiContext } from '../api/server.js';
import type { FastifyInstance } from 'fastify';
import { tier2ProposalId } from '../pipeline/commitments.js';
import { SafeSettler } from '../safe/SafeSettler.js';
import { runTier2Owner, type Tier2Steps } from './jobs/tier2.js';
import { createWatcher } from './jobs/watcher.js';
import type { OperatorConfig, ContextConfig } from './config.js';
import { loadKey } from './keys.js';
import { EthersClientChain, ReputationClientActions } from './chain.js';
import { runTier1 } from './jobs/tier1.js';
import { OperatorDaemon, type ContextRuntime } from './daemon.js';

/** Replaceable dependencies, for tests and for embedding the daemon in another process. */
export interface DaemonOverrides {
  provider?: Provider;
  transport?: ITreeTransport;
  store?: IMerkleStore;
  engine?: IEpochEngine;
  attestations?: (ctx: ContextConfig) => IAttestationProvider;
  relay?: ISettlementRelay;
  /** Wall clock in seconds for Tier 2 windows. Default Date.now. */
  now?: () => number;
  env?: NodeJS.ProcessEnv;
}

/** Binds the Tier 2 pipeline steps to one owner, one Safe and one relay. */
export function makeTier2Steps(p: {
  base: Tier2Base;
  owner: Signer;
  sender: Signer;
  compute: OwnerCompute;
  transport: ITreeTransport;
  store: IMerkleStore;
  contextUID: () => Promise<string>;
  commitWindow: number;
  revealWindow: number;
}): Tier2Steps {
  const { base, owner, compute, transport, store } = p;
  return {
    proposalId: async (epoch) => tier2ProposalId(base.safeSettler.client, await p.contextUID(), epoch, await base.safeSettler.nonce()),
    hasProposal: async (id) => (await base.relay.getProposal(id)) !== null,
    propose: async (epoch) => {
      await proposeEpochTier2({ ...base, proposer: owner, epoch, commitWindow: p.commitWindow, revealWindow: p.revealWindow });
    },
    commit: async (proposalId) => (await commitEpochTier2({ ...base, owner, proposalId, compute })).status,
    reveal: async (proposalId) => (await revealEpochTier2({ ...base, owner, proposalId, compute })).status,
    publish: async (proposalId) => (await publishEpochTreeTier2({ ...base, owner, proposalId, compute, transport, store })).status,
    sign: async (proposalId) => (await signEpochTier2({ ...base, owner, proposalId, transport, store })).status,
    execute: async (proposalId) => (await executeEpochTier2({ ...base, sender: p.sender, proposalId })).status
  };
}

const refuse = async (): Promise<never> => {
  throw new DriftConfigError('DRIFT operator: this watcher has no hot wallet configured.');
};
const noActions = { respondToChallenge: refuse, withdrawSettlementBond: refuse, challengeOmission: refuse };

export interface Operator {
  daemon: OperatorDaemon;
  /** Built (not listening) when config.api is set. */
  api?: FastifyInstance;
  listen?: { host: string; port: number };
}

/** Builds the daemon, and the API when configured. Keys are read from the environment here, once. */
export function buildOperator(config: OperatorConfig, log: Logger, o: DaemonOverrides = {}): Operator {
  const env = o.env ?? process.env;
  const provider = o.provider ?? new JsonRpcProvider(config.rpcUrl);
  const settlerKey = config.keys.settler && loadKey(config.keys.settler, provider, env);
  const hotWallet = config.keys.hotWallet && loadKey(config.keys.hotWallet, provider, env);
  const ownerKey = config.keys.owner && loadKey(config.keys.owner, provider, env);
  const relay =
    o.relay ??
    (config.relay.kind === 'http' ? new HttpSettlementRelay(config.relay.url, ownerKey) : new FileSettlementRelay(config.relay.dir));
  const apiContexts: ApiContext[] = [];

  const auth = config.trees.authorizationEnv ? env[config.trees.authorizationEnv] : undefined;
  const transport =
    o.transport ?? new IPFSTreeTransport({ apiUrl: config.trees.apiUrl, gatewayUrl: config.trees.gatewayUrl, authorization: auth });
  const store = o.store ?? new LocalTreeStore(path.join(config.stateDir, 'trees'));
  const engine =
    o.engine ??
    (config.engine.kind === 'grpc'
      ? new GrpcEpochEngine({ endpoint: config.engine.endpoint, evidence: config.engine.evidence, signers: config.engine.signers })
      : new LocalEpochEngine());

  const runtimes: ContextRuntime[] = config.contexts.map((ctx) => {
    const attestations = o.attestations?.(ctx) ?? new EASProvider(config.attestations.graphqlUrl, ctx.schemaUID);
    const chain = new EthersClientChain(provider, ctx.client, ctx.fromBlock ?? 0);
    const ctxLog = log.child({ context: ctx.name });
    apiContexts.push({ name: ctx.name, client: ctx.client, chain, store });
    const snapshotParams = {
      provider,
      attestations,
      schemaUID: ctx.schemaUID,
      schemaDefinition: ctx.schemaDefinition,
      blockTag: config.blockTag,
      fromBlock: ctx.fromBlock
    };
    const jobs: ContextRuntime['jobs'] = [];

    for (const role of ctx.roles) {
      if (role === 'tier1') {
        const settler = new DriftSettler(settlerKey!);
        jobs.push({
          role,
          run: (status) =>
            runTier1(
              {
                chain,
                actions: new ReputationClientActions(hotWallet!, ctx.client),
                store,
                settler: settlerKey!.address,
                bondScanDepth: config.bondScanDepth,
                log: ctxLog.child({ role }),
                settle: async (epoch) => {
                  const snapshot = await loadEpochSnapshot({ ...snapshotParams, client: ctx.client, epoch });
                  const r = await settleEpochTier1({ settler, client: ctx.client, snapshot, engine, transport, store });
                  return { root: r.root, treeURI: r.treeURI, txHash: r.txHash };
                }
              },
              status
            )
        });
      } else if (role === 'tier2-owner') {
        const safeSettler = new SafeSettler(provider, ctx.tier2!.safe, ctx.client);
        const steps = makeTier2Steps({
          base: { safeSettler, relay, now: o.now },
          owner: ownerKey!,
          sender: hotWallet!,
          compute: { snapshot: snapshotParams, engine },
          transport,
          store,
          contextUID: async () => (await chain.state()).contextUID,
          commitWindow: ctx.tier2!.commitWindowSeconds,
          revealWindow: ctx.tier2!.revealWindowSeconds
        });
        const deps = {
          chain,
          actions: new ReputationClientActions(hotWallet!, ctx.client),
          store,
          safe: ctx.tier2!.safe,
          steps,
          bondScanDepth: config.bondScanDepth,
          log: ctxLog.child({ role })
        };
        jobs.push({ role, run: (status) => runTier2Owner(deps, status) });
      } else if (role === 'watcher') {
        const challenge = ctx.watcher?.challenge ?? false;
        jobs.push({
          role,
          run: createWatcher({
            chain,
            // The hot wallet is required only when challenging (config validation).
            actions: hotWallet ? new ReputationClientActions(hotWallet, ctx.client) : noActions,
            compute: async (epoch) => {
              const snapshot = await loadEpochSnapshot({ ...snapshotParams, client: ctx.client, epoch });
              return engine.computeEpoch(snapshot.input);
            },
            fetchPosted: async (epoch) => (await resolveEpochTree(provider, ctx.client, epoch, transport, { fromBlock: ctx.fromBlock })).tree,
            challenge,
            challenger: hotWallet?.address ?? '0x' + '00'.repeat(20),
            log: ctxLog.child({ role })
          })
        });
      } else {
        throw new DriftConfigError(`DRIFT operator: unknown role '${String(role)}' (context '${ctx.name}').`);
      }
    }
    return { config: ctx, jobs };
  });

  const daemon = new OperatorDaemon(runtimes, log, config.pollIntervalSeconds * 1000);
  if (!config.api) return { daemon };

  const intervalMs = config.pollIntervalSeconds * 1000;
  const ownersCache = new Map<string, { at: number; owners: Promise<string[]> }>();
  const owners = (safe: string): Promise<string[]> => {
    const hit = ownersCache.get(safe.toLowerCase());
    if (hit && Date.now() - hit.at < 60_000) return hit.owners;
    const fresh = new Contract(safe, ['function getOwners() view returns (address[])'], provider).getOwners!() as Promise<string[]>;
    ownersCache.set(safe.toLowerCase(), { at: Date.now(), owners: fresh });
    fresh.catch(() => ownersCache.delete(safe.toLowerCase()));
    return fresh;
  };
  const api = buildApi({
    logger: log.child({ component: 'api' }),
    status: () => daemon.status(),
    contexts: apiContexts,
    ready: async () => {
      const s = daemon.status();
      const nowS = Math.floor(Date.now() / 1000);
      if (s.lastTickAt === undefined) return { ready: false, reason: 'no tick completed yet' };
      if ((nowS - s.lastTickAt) * 1000 > 3 * intervalMs + 60_000) return { ready: false, reason: `last tick at ${s.lastTickAt} is stale` };
      try {
        await Promise.race([provider.getBlockNumber(), new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), 5000))]);
      } catch (err) {
        return { ready: false, reason: `RPC unreachable: ${(err as Error).message}` };
      }
      return { ready: true };
    },
    relay:
      config.api.serveRelay && config.relay.kind === 'file'
        ? { store: relay, safes: config.api.relaySafes, owners }
        : undefined
  });
  return { daemon, api, listen: { host: config.api.host, port: config.api.port } };
}

/** Builds a daemon from a validated config, without the API. */
export function buildDaemon(config: OperatorConfig, log: Logger, o: DaemonOverrides = {}): OperatorDaemon {
  return buildOperator(config, log, o).daemon;
}

import * as path from 'path';
import { JsonRpcProvider, type Provider } from 'ethers';
import type { Logger } from 'pino';
import { DriftConfigError, DriftSettler, type IAttestationProvider } from '@drift-network/sdk';
import { EASProvider } from '@drift-network/sdk/providers';
import { LocalEpochEngine, type IEpochEngine } from '@drift-network/sdk/engines';
import { IPFSTreeTransport, type IMerkleStore, type ITreeTransport } from '@drift-network/sdk/merkle';
import { GrpcEpochEngine } from '../engines/GrpcEpochEngine.js';
import { LocalTreeStore } from '../store/LocalTreeStore.js';
import { loadEpochSnapshot } from '../pipeline/snapshot.js';
import { settleEpochTier1 } from '../pipeline/tier1.js';
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
  env?: NodeJS.ProcessEnv;
}

/** Builds a daemon from a validated config. Keys are read from the environment here, once. */
export function buildDaemon(config: OperatorConfig, log: Logger, o: DaemonOverrides = {}): OperatorDaemon {
  const env = o.env ?? process.env;
  const provider = o.provider ?? new JsonRpcProvider(config.rpcUrl);
  const settlerKey = config.keys.settler && loadKey(config.keys.settler, provider, env);
  const hotWallet = config.keys.hotWallet && loadKey(config.keys.hotWallet, provider, env);

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
                  const snapshot = await loadEpochSnapshot({
                    provider,
                    client: ctx.client,
                    epoch,
                    attestations,
                    schemaUID: ctx.schemaUID,
                    schemaDefinition: ctx.schemaDefinition,
                    blockTag: config.blockTag,
                    fromBlock: ctx.fromBlock
                  });
                  const r = await settleEpochTier1({ settler, client: ctx.client, snapshot, engine, transport, store });
                  return { root: r.root, treeURI: r.treeURI, txHash: r.txHash };
                }
              },
              status
            )
        });
      } else {
        throw new DriftConfigError(`DRIFT operator: role '${role}' (context '${ctx.name}') is not implemented in this build yet.`);
      }
    }
    return { config: ctx, jobs };
  });

  return new OperatorDaemon(runtimes, log, config.pollIntervalSeconds * 1000);
}

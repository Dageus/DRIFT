import Fastify, { type FastifyBaseLogger, type FastifyInstance } from 'fastify';
import type { Logger } from 'pino';
import { DriftNotFoundError, DriftValidationError } from '@drift-network/sdk';
import { findLeaves, type IMerkleStore } from '@drift-network/sdk/merkle';
import { isAddress } from 'ethers';
import { isFinalized, type ClientChain } from '../daemon/chain.js';
import type { DaemonStatus } from '../daemon/daemon.js';
import { registerRelayRoutes, type RelayRoutesOptions } from './relayRoutes.js';

export interface ApiContext {
  name: string;
  client: string;
  chain: ClientChain;
  store: IMerkleStore;
}

export interface ApiOptions {
  status: () => DaemonStatus;
  /** Readiness: RPC reachable and the loop ticking. */
  ready: () => Promise<{ ready: boolean; reason?: string }>;
  contexts: ApiContext[];
  /** More Prometheus text appended to /metrics (the recorder's derived metrics). */
  extraMetrics?: () => string;
  /** Serve the Tier 2 relay too. */
  relay?: RelayRoutesOptions;
  logger: Logger;
}

const ZERO_ROOT = '0x' + '00'.repeat(32);

/**
 * Untrusted-data notice sent with every proof. The operator is not trusted: a client must check
 * each proof against the root committed on chain (epochRoots(epoch)) before using it, which is
 * exactly what the contract does on claimReputation and castVoteWithProofs.
 */
export const PROOF_NOTICE =
  'Unverified operator data. Check each proof against epochRoots(epoch) on the client contract before relying on it.';

/**
 * The operator's HTTP API. It reads chain state, the daemon's in-memory status and the local tree
 * store; it never signs and holds no keys, so exposing it adds no authority. Errors are JSON
 * `{ error }` with a matching status code.
 */
export function buildApi(o: ApiOptions): FastifyInstance {
  // pino's Logger and Fastify's logger type differ only in generics; the instance is the same.
  const app = Fastify({ loggerInstance: o.logger as unknown as FastifyBaseLogger, bodyLimit: 64 * 1024 }) as unknown as FastifyInstance;

  const find = (key: string): ApiContext | undefined =>
    o.contexts.find((c) => c.name === key || (isAddress(key) && c.client.toLowerCase() === key.toLowerCase()));
  const epochOf = (raw: string): bigint | null => (/^[1-9][0-9]{0,17}$/.test(raw) ? BigInt(raw) : null);

  app.get('/health', async () => ({ ok: true }));

  app.get('/ready', async (_req, reply) => {
    const r = await o.ready();
    return reply.code(r.ready ? 200 : 503).send(r);
  });

  app.get('/status', async () => o.status());

  app.get<{ Params: { ctx: string; epoch: string } }>('/contexts/:ctx/epochs/:epoch', async (req, reply) => {
    const ctx = find(req.params.ctx);
    const epoch = epochOf(req.params.epoch);
    if (!ctx) return reply.code(404).send({ error: `unknown context ${req.params.ctx}` });
    if (epoch === null) return reply.code(400).send({ error: 'epoch must be a positive integer' });
    const [state, now, root] = await Promise.all([ctx.chain.state(), ctx.chain.headTimestamp(), ctx.chain.epochRoot(epoch)]);
    if (root.toLowerCase() === ZERO_ROOT) return reply.code(404).send({ error: `no root committed for epoch ${epoch}` });
    const [postedAt, openChallenges, bond, finalized, treeURI] = await Promise.all([
      ctx.chain.epochPostedAt(epoch),
      ctx.chain.openChallengeCount(epoch),
      ctx.chain.epochBondAmount(epoch),
      isFinalized(ctx.chain, state, epoch, now),
      ctx.chain.epochTreeURI(epoch)
    ]);
    return {
      context: ctx.name,
      contextUID: state.contextUID,
      epoch: epoch.toString(),
      root,
      treeURI,
      postedAt: postedAt.toString(),
      disputeWindowEndsAt: (postedAt + state.disputeWindow).toString(),
      openChallenges: openChallenges.toString(),
      bond: bond.toString(),
      finalized
    };
  });

  app.get<{ Params: { ctx: string; epoch: string; node: string } }>('/contexts/:ctx/epochs/:epoch/proofs/:node', async (req, reply) => {
    const ctx = find(req.params.ctx);
    const epoch = epochOf(req.params.epoch);
    if (!ctx) return reply.code(404).send({ error: `unknown context ${req.params.ctx}` });
    if (epoch === null) return reply.code(400).send({ error: 'epoch must be a positive integer' });
    if (!isAddress(req.params.node)) return reply.code(400).send({ error: 'node must be an address' });
    void reply.header('x-drift-trust', 'unverified');

    const [state, committedRoot] = await Promise.all([ctx.chain.state(), ctx.chain.epochRoot(epoch)]);
    let tree;
    try {
      tree = await ctx.store.loadTree(state.contextUID, epoch);
    } catch (err) {
      if (err instanceof DriftNotFoundError || err instanceof DriftValidationError) {
        return reply.code(404).send({ error: `this operator holds no tree for epoch ${epoch}`, notice: PROOF_NOTICE });
      }
      throw err;
    }
    const leaves = findLeaves(tree, req.params.node).map((l) => ({ role: l.value[2]!, score: l.value[3]!, proof: l.proof }));
    const body = {
      notice: PROOF_NOTICE,
      context: ctx.name,
      epoch: epoch.toString(),
      node: req.params.node.toLowerCase(),
      treeRoot: tree.root,
      committedRoot,
      matchesCommitted: tree.root.toLowerCase() === committedRoot.toLowerCase(),
      leaves
    };
    return leaves.length ? body : reply.code(404).send({ ...body, error: 'no leaf for this node in the stored tree' });
  });

  app.get('/metrics', async (_req, reply) => {
    const s = o.status();
    const lines = [
      '# HELP drift_operator_ticks_total Reconcile ticks completed.',
      '# TYPE drift_operator_ticks_total counter',
      `drift_operator_ticks_total ${s.ticks}`,
      '# HELP drift_operator_last_tick_seconds Unix time of the last completed tick.',
      '# TYPE drift_operator_last_tick_seconds gauge',
      `drift_operator_last_tick_seconds ${s.lastTickAt ?? 0}`,
      '# HELP drift_operator_current_epoch Current epoch of each context.',
      '# TYPE drift_operator_current_epoch gauge',
      ...s.contexts.map((c) => `drift_operator_current_epoch{context="${c.name}"} ${c.currentEpoch ?? 0}`),
      '# HELP drift_operator_alerts Alerts raised on the latest tick.',
      '# TYPE drift_operator_alerts gauge',
      ...s.contexts.flatMap((c) =>
        (['warn', 'error'] as const).map((l) => `drift_operator_alerts{context="${c.name}",level="${l}"} ${c.alerts.filter((a) => a.level === l).length}`)
      ),
      '# HELP drift_operator_job_errors Contexts whose latest tick had a failing job.',
      '# TYPE drift_operator_job_errors gauge',
      ...s.contexts.map((c) => `drift_operator_job_errors{context="${c.name}"} ${c.lastError ? 1 : 0}`)
    ];
    return reply.type('text/plain; version=0.0.4').send(lines.join('\n') + '\n' + (o.extraMetrics?.() ?? ''));
  });

  if (o.relay) registerRelayRoutes(app, o.relay);
  return app;
}

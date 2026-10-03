// @drift-network/operator: everything that produces or checks a settlement, for Node processes
// run by settlers, Safe owners and watchers. The client side (claims, votes, local mode, tree
// resolution) stays in @drift-network/sdk, which this package builds on.

// Settlement pipeline: snapshot at t_E, Tier 1, Tier 2 steps, relay.
export * from './pipeline/index.js';

// Tier 2: a Safe as the ERC-1271 trusted settler.
export * from './safe/index.js';

// Remote (gRPC) and committee epoch engines.
export * from './engines/index.js';

// Filesystem tree store, kept to answer omission challenges.
export { LocalTreeStore } from './store/LocalTreeStore.js';

// Operator daemon and its configuration.
export * from './daemon/index.js';

// The HTTP API (and Fastify) is at '@drift-network/operator/api'. The relay client needs no server.
export { HttpSettlementRelay, relayRequestDigest, RELAY_PREFIX, SIGNER_HEADER, SIGNATURE_HEADER } from './relay/http.js';

// Event recorder: versioned JSONL log and derived metrics.
export * from './recorder/index.js';

// JSON-RPC provider that retries rate-limited requests.
export { RetryingJsonRpcProvider, type RetryOptions } from './rpc/RetryingJsonRpcProvider.js';

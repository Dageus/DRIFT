// HTTP API: status, epochs, proofs, metrics, and the Tier 2 relay over HTTP. Separate entry point,
// so that loading the operator does not load Fastify, an optional dependency.
export { buildApi, PROOF_NOTICE } from './server.js';
export type { ApiOptions, ApiContext } from './server.js';
export { registerRelayRoutes } from './relayRoutes.js';
export type { RelayRoutesOptions } from './relayRoutes.js';

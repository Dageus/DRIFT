// Operator daemon: a stateless reconcile loop over the settlement pipeline. Run it with the
// `drift-operator` CLI, or embed it with buildDaemon.
export { parseConfig } from './config.js';
export type { OperatorConfig, ContextConfig, KeyRef, Role, BlockTag } from './config.js';
export { loadKey } from './keys.js';
export { EthersClientChain, ReputationClientActions, isFinalized } from './chain.js';
export type { ClientChain, ClientActions, ClientState, ChallengeView } from './chain.js';
export { runTier1 } from './jobs/tier1.js';
export type { Tier1JobDeps, SettledEpoch } from './jobs/tier1.js';
export { OperatorDaemon } from './daemon.js';
export type { Job, ContextRuntime, DaemonStatus } from './daemon.js';
export type { ContextStatus, ChallengeStatus, Alert } from './status.js';
export { buildDaemon } from './wiring.js';
export type { DaemonOverrides } from './wiring.js';

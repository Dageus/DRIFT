// Remote engines over the engine protocol (packages/protos/drift/engine/v1). Kept off the
// '@drift-network/sdk/engines' entry point so in-process users do not load gRPC.
export { GrpcEpochEngine } from './GrpcEpochEngine.js';
export type { GrpcEpochEngineConfig, EvidenceKind } from './GrpcEpochEngine.js';
export { CommitteeEpochEngine } from './CommitteeEpochEngine.js';
export type { CommitteeEpochEngineConfig } from './CommitteeEpochEngine.js';

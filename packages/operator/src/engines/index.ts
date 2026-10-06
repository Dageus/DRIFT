// Remote engines over the engine protocol (packages/protos/drift/engine/v1). They live in the
// operator package so SDK users never load gRPC.
export { GrpcEpochEngine } from './GrpcEpochEngine.js';
export type { GrpcEpochEngineConfig, EvidenceKind } from './GrpcEpochEngine.js';
export { CommitteeEpochEngine } from './CommitteeEpochEngine.js';
export type { CommitteeEpochEngineConfig } from './CommitteeEpochEngine.js';

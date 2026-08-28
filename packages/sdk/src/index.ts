// Main entry — the framework-agnostic core: constructing a Drift client, settling epochs, and
// the shared types every module speaks. Reputation engines, attestation providers, and trust/
// Merkle storage each have their own subpath entry point instead of being re-exported here:
//   @drift-network/sdk/engines   — EigenTrustEngine, TemporalDecayEngine, WeightedLocalEngine, ...
//   @drift-network/sdk/providers — EASProvider, IAttestationProvider
//   @drift-network/sdk/trust     — LocalTrustStore, NodeTrustStore, ITrustStore
//   @drift-network/sdk/merkle    — LocalTreeStore, IMerkleStore (Node-only)
// Splitting this way keeps `Drift` itself importable without pulling in every engine/provider a
// consumer isn't using, while still shipping as one package/version instead of several.
export { Drift } from './drift.js';
export type { DriftConfig } from './drift.js';

// Core Types
export type {
  AttestationRecord,
  AttestationData,
  ReputationOptions,
  GlobalReputationOptions,
  LocalReputationOptions,
  VotingPowerOptions,
  ReputationResult
} from './types.js';

// Settler & Proofs
export { DriftSettler, EpochNotSynchronizedError } from './settler.js';
export type { ScoreEntry, ProofOfStatePayload } from './settler.js';

// Errors — every error the SDK throws intentionally extends DriftError; catch that (or a
// specific subclass) to distinguish recognized SDK failures from unexpected bugs.
export {
  DriftError,
  DriftConfigError,
  DriftValidationError,
  DriftNotFoundError,
  DriftProviderError,
  DriftContractRevertError,
  DriftUnknownRevertError
} from './errors.js';

// Utilities
export { SchemaEncoder } from './schema-encoder.js';
export * as utils from './utils.js';

// Engine & Provider Interfaces
export type { IReputationEngine } from './engines/IReputationEngine.js';
export type { IAttestationProvider } from './providers/IAttestationProvider.js';

// Governance read-model types (returned by GovernanceModule.getProposal/getProposalSnapshot)
export type { ProposalView, ProposalSnapshotView } from './contracts/WeightedGovernanceClientContract.js';

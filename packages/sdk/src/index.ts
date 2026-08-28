// Framework-agnostic core: the Drift client, epoch settlement, shared types. Engines, providers,
// and trust/Merkle storage live at their own subpaths instead — see README (Package Layout):
//   @drift-network/sdk/engines | /providers | /trust | /merkle
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

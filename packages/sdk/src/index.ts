// Main entry
export { Drift } from './drift';
export type { DriftConfig } from './drift';

// Core Types
export type {
  AttestationRecord,
  AttestationData,
  ReputationOptions,
  GlobalReputationOptions,
  LocalReputationOptions,
  VotingPowerOptions,
  ReputationResult
} from './types';

// Settler & Proofs
export { DriftSettler } from './settler';
export type { ScoreEntry, ProofOfStatePayload } from './settler';

// Utilities
export { SchemaEncoder } from './schema-encoder';
export * as utils from './utils';

// Engine & Provider Interfaces
export type { IReputationEngine } from './engines/IReputationEngine';
export type { IAttestationProvider } from './providers/IAttestationProvider';

// Main entry
export { Drift } from './drift';
export type {
  AttestationRecord,
  AttestationData,
  ReputationOptions,
  GlobalReputationOptions,
  LocalReputationOptions,
  VotingPowerOptions
} from './types';

// Individual classes for tree-shaking
export { DriftSettler } from './settler';

// Utilities
export { SchemaEncoder } from './schema-encoder';
export * as utils from './utils';

// Types only
export type { IReputationEngine } from './engines/IReputationEngine';
export type { IAttestationProvider } from './providers/IAttestationProvider';

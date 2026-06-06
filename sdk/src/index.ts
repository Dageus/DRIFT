// Main entry
export { Drift } from './drift';
export type { ReputationOptions, GlobalReputationOptions, LocalReputationOptions, VotingPowerOptions } from './drift';

// Individual classes for tree-shaking
export { DriftClient } from './client';
export { DriftSettler } from './settler';
export { DriftFactory } from './factory';

// Utilities
export { SchemaEncoder } from './schema-encoder';
export * as utils from './utils';
export { CORE_ERROR_DECODER, GOVERNANCE_ERROR_DECODER } from './errors';

// Types only
export type { DriftConfig } from './client';
export type { IReputationEngine } from './engines/IReputationEngine';
export type { IAttestationProvider } from './providers/IAttestationProvider';
export type { AttestationRecord, AttestationData } from './request';

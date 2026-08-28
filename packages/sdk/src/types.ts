import { IReputationEngine } from './engines/IReputationEngine.js';

/** Raw attestation from any provider. The data field is opaque bytes. */
export interface AttestationRecord {
  uid: string; // bytes32 hex
  schemaUID: string; // bytes32 hex
  attester: string; // address
  subject: string; // address
  timestamp: number;
  revoked: boolean;
  data: string; // hex-encoded raw bytes — decoded by engine, not provider
}

/** Decoded, engine-ready representation. Produced by the engine from raw records. */
export interface AttestationData {
  uid: string;
  subject: string;
  score: bigint; // decoded from data bytes
  timestamp: number;
}

export interface GlobalReputationOptions {
  mode: 'global';
  /** Context UID (bytes32 hex) */
  context: string;
  /** Role identifier (bytes32 hex). If omitted, sums across all roles. */
  role?: string;
}

export interface LocalReputationOptions {
  mode: 'local';
  /** Context UID (bytes32 hex) */
  context: string;
  /** The viewer whose trust graph to use (address) */
  viewer: string;
  /** EAS schema UID to query */
  schemaUID: string;
  /** ABI type definition for decoding attestation data. Default: "uint256 score" */
  schemaDef?: string;
  /** Optional: override the default engine (EigenTrust + local weights) */
  engine?: IReputationEngine;
}

export interface VotingPowerOptions {
  mode: 'voting';
  /** Governance client contract address */
  governanceClient: string;
}

export type ReputationOptions = GlobalReputationOptions | LocalReputationOptions | VotingPowerOptions;

export interface GlobalReputationResult {
  /** ERC-1155 token balance for the requested context+role */
  balance: bigint;
  /** Breakdown per role (only present when no specific role requested) */
  breakdown?: Record<string, bigint>;
}

export interface LocalReputationResult {
  /** Computed subjective score (0-10000 scaled) */
  score: bigint;
  /** Number of attestations considered */
  attestationsUsed: number;
  /** Engine that produced the score */
  engine: string;
}

export type ReputationResult<T extends ReputationOptions> = T extends GlobalReputationOptions
  ? GlobalReputationResult
  : T extends LocalReputationOptions
    ? LocalReputationResult
    : T extends VotingPowerOptions
      ? bigint
      : never;

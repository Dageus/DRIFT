import type { AttestationRecord } from '../types';

export interface IReputationEngine {
  /** Receives raw records, decodes data field internally, returns score. */
  calculateScore(records: AttestationRecord[]): bigint;
}

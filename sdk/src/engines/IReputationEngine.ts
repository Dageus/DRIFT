import type { AttestationRecord } from '../request';

export interface IReputationEngine {
  /** Receives raw records, decodes data field internally, returns score. */
  calculateScore(records: AttestationRecord[]): bigint;
}

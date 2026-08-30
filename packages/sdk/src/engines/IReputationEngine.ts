import type { AttestationRecord } from '../types.js';

export interface IReputationEngine {
  /**
   * Receives raw records (potentially the full context graph, not just edges about `subject`)
   * and decodes the data field internally. `subject` names which node's score to return —
   * required rather than inferred, since a full-graph record set has no single implicit subject.
   */
  calculateScore(records: AttestationRecord[], subject: string): bigint;
}

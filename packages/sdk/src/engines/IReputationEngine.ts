import type { AttestationRecord } from '../types.js';

export interface IReputationEngine {
  /**
   * Receives raw records (potentially the full context graph, not just edges about `subject`)
   * and decodes the data field internally. `subject` names which node's score to return —
   * required rather than inferred, since a full-graph record set has no single implicit subject.
   */
  calculateScore(records: AttestationRecord[], subject: string): bigint;

  /**
   * Scores every node appearing in `records`, plus any in `extraNodes`, in a single pass.
   *
   * Settlement needs a leaf per admitted pair, i.e. the whole vector. Obtaining that through
   * repeated `calculateScore` calls costs O(N) full evaluations — for a graph-propagation engine
   * whose single evaluation is already O(N^2), that makes settling a context O(N^3) while
   * recomputing an identical power iteration N times and discarding N-1 results each time.
   * Implementations must compute the vector once.
   */
  calculateAll(records: AttestationRecord[], extraNodes?: string[]): Map<string, bigint>;
}

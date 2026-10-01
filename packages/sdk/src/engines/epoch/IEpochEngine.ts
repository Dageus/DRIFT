import type { EpochInput, EpochResult } from './protocol.js';

/**
 * Settlement-side engine boundary. `IReputationEngine` stays the synchronous, in-process
 * interface used for local (viewer-subjective) queries; an `IEpochEngine` computes one whole
 * epoch for the settler and may run anywhere: in process, behind gRPC, in a committee, or in the
 * zkVM. Implementations return the scores together with evidence binding the settlement root to
 * the exact input (see packages/engines/SPEC.md).
 */
export interface IEpochEngine {
  computeEpoch(input: EpochInput): Promise<EpochResult>;
}

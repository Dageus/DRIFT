import type { IReputationEngine } from '../IReputationEngine';
import type { AttestationRecord } from '../../request';

export class WeightedLocalEngine implements IReputationEngine {
  /**
   * @param peerWeights A local map of how much User A values their immediate friends' opinions.
   * e.g., { "0xFriendC...": 90n, "0xFriendD...": 40n }
   */
  constructor(private readonly peerWeights: Record<string, bigint>) {}

  calculateScore(records: AttestationRecord[]): bigint {
    if (records.length === 0) return 0n;

    let weightedScoreTotal = 0n;
    let totalWeightApplied = 0n;

    for (const record of records) {
      // Who made the statement about Subject B? (This is 'C' in your professor's example)
      const attesterC = record.attester.toLowerCase();

      // Does User A have a local peer weight assigned to Attester C?
      // If not, default their opinion weight to a minimal baseline (e.g., 5n)
      const cWeightFromA = this.peerWeights[attesterC] ?? 5n;

      // Decode the raw score that C gave to B (Assuming simple uint256 payload standard)
      // For real use, pair with SchemaEncoder
      const rawScoreCGaveToB = BigInt(record.data);

      // Apply the transitive social weight multiplier
      weightedScoreTotal += rawScoreCGaveToB * cWeightFromA;
      totalWeightApplied += cWeightFromA;
    }

    return totalWeightApplied === 0n ? 0n : weightedScoreTotal / totalWeightApplied;
  }
}

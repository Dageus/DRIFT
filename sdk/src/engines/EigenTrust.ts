import { AbiCoder } from 'ethers';
import type { IReputationEngine } from './IReputationEngine';
import type { AttestationRecord } from '../request';

export type WeightResolver = (attester: string) => bigint;

export class EigenTrustEngine implements IReputationEngine {
  private readonly coder = AbiCoder.defaultAbiCoder();

  /**
   * @param schemaDefinition e.g., "uint256 score, string courseId"
   * @param weightResolver A function that returns the trust weight for a given attester.
   * Defaults to returning 1n (simple average) if not provided.
   */
  constructor(
    private readonly schemaDefinition: string,
    private readonly weightResolver: WeightResolver = () => 1n
  ) {}

  calculateScore(records: AttestationRecord[]): bigint {
    if (records.length === 0) return 0n;

    // Extract just the types (e.g., ["uint256", "string"]) for the AbiCoder
    const types = this.schemaDefinition.split(',').map((f) => f.trim().split(' ')[0]);

    let total = 0n;
    let weight = 0n;

    for (const record of records) {
      try {
        const decoded = this.coder.decode(types, record.data);
        const rawScore = BigInt(decoded[0]); // Assumes the first field is the score

        // Resolve the weight dynamically (Local DB, On-Chain, or Default)
        const trustWeight = this.weightResolver(record.attester.toLowerCase());

        total += rawScore * trustWeight;
        weight += trustWeight;
      } catch {
        // Malformed data — skip this record safely
        continue;
      }
    }

    return weight === 0n ? 0n : total / weight;
  }
}

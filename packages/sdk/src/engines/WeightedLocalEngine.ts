import { AbiCoder } from 'ethers';
import type { IReputationEngine } from './IReputationEngine.js';
import type { AttestationRecord } from '../types.js';

export interface WeightedLocalEngineConfig {
  /** Viewer-specific trust weights: { attesterAddress_lowerCase => weight } */
  peerWeights: Record<string, bigint>;
  /** Default weight for unknown attesters. Default: 5n */
  defaultWeight?: bigint;
  /** ABI type string for decoding attestation data. Default: "uint256 score" */
  schemaDefinition?: string;
}

/**
 * Local reputation engine: subjective trust-weighted attestation scoring.
 *
 * Each viewer maintains their own trust graph (peerWeights). When evaluating
 * a subject, this engine queries ALL attestations about that subject and weights
 * each attester's opinion by how much the viewer trusts them.
 *
 * This is purely local/SDK — never settles to chain. Used for personal
 * reputation dashboards, lending decisions, hiring, etc.
 */
export class WeightedLocalEngine implements IReputationEngine {
  private readonly coder = AbiCoder.defaultAbiCoder();
  private readonly peerWeights: Record<string, bigint>;
  private readonly defaultWeight: bigint;
  private readonly types: string[];

  constructor(config: WeightedLocalEngineConfig) {
    this.peerWeights = config.peerWeights;
    this.defaultWeight = config.defaultWeight ?? 5n;
    const schema = config.schemaDefinition ?? 'uint256 score';
    this.types = schema.split(',').map((f) => f.trim().split(' ')[0]!);
  }

  calculateScore(records: AttestationRecord[], subject: string): bigint {
    const targetSubject = subject.toLowerCase();
    // Direct-aggregation engine, not a graph-propagation one: `records` may be the full context
    // graph (IAttestationProvider.fetchAllContextRecords), so only keep edges into `subject`.
    const subjectRecords = records.filter((r) => r.subject.toLowerCase() === targetSubject);
    if (subjectRecords.length === 0) return 0n;

    let weightedScoreTotal = 0n;
    let totalWeightApplied = 0n;
    let validRecords = 0;

    for (const record of subjectRecords) {
      // Skip revoked attestations
      if (record.revoked) continue;

      // Resolve viewer's trust in this attester
      const attesterWeight = this.peerWeights[record.attester.toLowerCase()] ?? this.defaultWeight;

      // Decode the attestation data field properly
      let rawScore: bigint;
      try {
        const decoded = this.coder.decode(this.types, record.data);
        rawScore = BigInt(decoded[0]);
        validRecords++;
      } catch {
        // Malformed data — skip this record
        continue;
      }

      weightedScoreTotal += rawScore * attesterWeight;
      totalWeightApplied += attesterWeight;
    }

    if (totalWeightApplied === 0n || validRecords === 0) return 0n;
    return weightedScoreTotal / totalWeightApplied;
  }
}

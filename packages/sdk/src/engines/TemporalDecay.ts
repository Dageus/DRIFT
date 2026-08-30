import { AbiCoder } from 'ethers';
import type { IReputationEngine } from './IReputationEngine.js';
import type { AttestationRecord } from '../types.js';

export interface TemporalDecayEngineConfig {
  /** ABI type string for decoding attestation data. Default: "uint256 score" */
  schemaDefinition?: string;
  /** Half-life in milliseconds. Default: 30 days */
  halfLifeMs?: number;
  /** Floor weight for very old attestations (0-1). Default: 0.05 */
  decayFloor?: number;
}

/**
 * Temporal decay reputation engine.
 *
 * More recent attestations count more. Uses exponential decay:
 *   weight = max(decayFloor, 2^(-age / halfLife))
 *
 * This models the intuition that a professor's attestation from last
 * semester is more relevant than one from 3 years ago.
 *
 * Combines well with WeightedLocalEngine or EigenTrustEngine by
 * pre-filtering records, or used standalone for time-sensitive contexts.
 */
export class TemporalDecayEngine implements IReputationEngine {
  private readonly coder = AbiCoder.defaultAbiCoder();
  private readonly types: string[];
  private readonly halfLifeMs: number;
  private readonly decayFloor: number;
  private readonly ln2: number = 0.69314718056;

  constructor(config: TemporalDecayEngineConfig = {}) {
    const schema = config.schemaDefinition ?? 'uint256 score';
    this.types = schema.split(',').map((f) => f.trim().split(' ')[0]!);
    this.halfLifeMs = config.halfLifeMs ?? 30 * 24 * 60 * 60 * 1000;
    this.decayFloor = config.decayFloor ?? 0.05;
  }

  calculateScore(records: AttestationRecord[], subject: string): bigint {
    const targetSubject = subject.toLowerCase();
    // Direct-aggregation engine, not a graph-propagation one: `records` may be the full context
    // graph (IAttestationProvider.fetchAllContextRecords), so only keep edges into `subject`.
    const validRecords = records.filter((r) => !r.revoked && r.subject.toLowerCase() === targetSubject);
    if (validRecords.length === 0) return 0n;

    const now = Date.now();
    let weightedSum = 0n;
    let totalWeight = 0n;

    for (const record of validRecords) {
      let rawScore: bigint;
      try {
        const decoded = this.coder.decode(this.types, record.data);
        rawScore = BigInt(decoded[0]);
      } catch {
        continue;
      }

      // Exponential decay: w = 2^(-age / halfLife) = e^(-age * ln2 / halfLife)
      const ageMs = now - record.timestamp * 1000;
      const decay = Math.max(this.decayFloor, Math.exp(-(ageMs * this.ln2) / this.halfLifeMs));

      const weight = BigInt(Math.round(decay * 10000));
      weightedSum += rawScore * weight;
      totalWeight += weight;
    }

    if (totalWeight === 0n) return 0n;
    return weightedSum / totalWeight;
  }
}

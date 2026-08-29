import { AbiCoder } from 'ethers';
import type { IReputationEngine } from './IReputationEngine.js';
import type { AttestationRecord } from '../types.js';

export type WeightResolver = (attester: string) => bigint;

export interface EigenTrustEngineConfig {
  /** ABI type string for decoding attestation data. E.g. "uint256 score" or "uint256 grade,uint256 maxGrade" */
  schemaDefinition: string;
  /** How to weight each attester. Defaults to uniform weight (1n). */
  weightResolver?: WeightResolver;
  /** Number of power-iteration steps. Default: 10. */
  iterations?: number;
  /** Convergence threshold. Default: 0.0001. */
  epsilon?: number;
  /** Damping factor for random teleport (0-1). Default: 0.15. */
  alpha?: number;
}

const SCALE = 1000000n; // Fixed-point precision factor for BigInt math
const MULTIPLIER = 10000n; // Target score bounds normalization factor

export class EigenTrustEngine implements IReputationEngine {
  private readonly coder = AbiCoder.defaultAbiCoder();
  private readonly types: string[];
  private readonly weightResolver: WeightResolver;
  private readonly iterations: number;
  private readonly epsilon: number;
  private readonly alpha: number;

  constructor(config: EigenTrustEngineConfig) {
    this.types = config.schemaDefinition.split(',').map((f) => f.trim().split(' ')[0]!);
    this.weightResolver = config.weightResolver ?? (() => 1n);
    this.iterations = config.iterations ?? 10;
    this.epsilon = config.epsilon ?? 0.0001;
    this.alpha = config.alpha ?? 0.15;
  }

  calculateScore(records: AttestationRecord[]): bigint {
    const validRecords = records.filter((r) => !r.revoked);
    if (validRecords.length === 0) return 0n;

    // Phase 1: Parse data and map the local interaction graph
    const allNodes = new Set<string>();
    const outboundScores = new Map<string, Map<string, bigint>>();

    for (const record of validRecords) {
      try {
        const decoded = this.coder.decode(this.types, record.data);
        const rawScore = BigInt(decoded[0]);
        if (rawScore < 0n) continue;

        const attester = record.attester.toLowerCase();
        const subject = record.subject.toLowerCase();

        allNodes.add(attester);
        allNodes.add(subject);

        if (!outboundScores.has(attester)) {
          outboundScores.set(attester, new Map());
        }
        const subjectMap = outboundScores.get(attester)!;
        subjectMap.set(subject, (subjectMap.get(subject) ?? 0n) + rawScore);
      } catch {
        // Skip malformed records safely without disrupting the pipeline
        continue;
      }
    }

    if (allNodes.size === 0) return 0n;

    // Canonical iteration order (A5(iii)/A3 determinism): sort explicitly rather than relying on
    // Set insertion order, which tracks the caller-supplied `records` order. Row/column layout of
    // the transition matrix must be independent of storage/indexer traversal order so two callers
    // fetching the same A_c^E in different order compute a bit-identical result. Bigint fixed-point
    // addition happens to be order-independent regardless, but that's incidental to the accumulator
    // choice, not a guarantee — don't rely on it if the accumulation logic ever changes.
    const nodes = Array.from(allNodes).sort();
    const numNodes = nodes.length;

    // Detect the targeted subject from the active context. Canonical selection (A3/A5(iii)):
    // in production every record shares one subject (IAttestationProvider.fetchUserRecords
    // returns records about a single target), so this reduces to that subject regardless of
    // order. For a general multi-subject graph, pick the lexicographically smallest subject
    // deterministically instead of validRecords[0], which tracks caller-supplied array order.
    // Non-null: validRecords.length > 0 already checked above, so .sort()[0] always exists.
    const targetSubject = validRecords.map((r) => r.subject.toLowerCase()).sort()[0]!;
    const targetIndex = nodes.indexOf(targetSubject);
    if (targetIndex === -1) return 0n;

    // Precalculate row sums for transition matrix normalization
    const rowSums = new Map<string, bigint>();
    for (const [attester, subjectMap] of outboundScores) {
      let sum = 0n;
      for (const score of subjectMap.values()) {
        sum += score;
      }
      rowSums.set(attester, sum);
    }

    // Phase 2: Compute and normalize the personalized pre-trust vector (p)
    const pWeights = nodes.map((node) => {
      try {
        const w = this.weightResolver(node);
        return w > 0n ? w : 0n;
      } catch {
        return 0n;
      }
    });

    const totalPWeight = pWeights.reduce((a, b) => a + b, 0n);
    const pVector = new Array<bigint>(numNodes);

    if (totalPWeight > 0n) {
      for (let i = 0; i < numNodes; i++) {
        pVector[i] = (pWeights[i]! * SCALE) / totalPWeight;
      }
    } else {
      const uniform = SCALE / BigInt(numNodes);
      for (let i = 0; i < numNodes; i++) {
        pVector[i] = uniform;
      }
    }

    // Initialize steady-state vector (t) with the pre-trust baseline
    let t = [...pVector];

    const alphaScaled = BigInt(Math.round(this.alpha * Number(SCALE)));
    const oneMinusAlphaScaled = SCALE - alphaScaled;
    const epsilonScaled = BigInt(Math.round(this.epsilon * Number(SCALE)));

    // Phase 3: Run the EigenTrust power iteration loop
    for (let iter = 0; iter < this.iterations; iter++) {
      const nextT = new Array<bigint>(numNodes).fill(0n);

      // nodes/t/nextT/pVector are all always length numNodes — every index below is in-bounds
      // by loop construction (i, j < numNodes).
      for (let i = 0; i < numNodes; i++) {
        const srcNode = nodes[i]!;
        const srcRank = t[i]!;
        if (srcRank === 0n) continue;

        const rowSum = rowSums.get(srcNode) ?? 0n;

        if (rowSum > 0n) {
          const subjectMap = outboundScores.get(srcNode)!;
          for (let j = 0; j < numNodes; j++) {
            const targetNode = nodes[j]!;
            const scoreij = subjectMap.get(targetNode) ?? 0n;

            const matrixTransition = (scoreij * SCALE) / rowSum;
            const totalTransition = (oneMinusAlphaScaled * matrixTransition + alphaScaled * pVector[j]!) / SCALE;

            nextT[j]! += (srcRank * totalTransition) / SCALE;
          }
        } else {
          // Handle dangling nodes (e.g. the subject) by distributing transitions via p
          for (let j = 0; j < numNodes; j++) {
            nextT[j]! += (srcRank * pVector[j]!) / SCALE;
          }
        }
      }

      // Evaluate convergence threshold (L1-norm delta)
      let delta = 0n;
      for (let i = 0; i < numNodes; i++) {
        const diff = nextT[i]! - t[i]!;
        delta += diff > 0n ? diff : -diff;
      }

      t = nextT;

      if (delta < epsilonScaled) {
        break;
      }
    }

    // Phase 4: Output the targeted node's score normalized to the MULTIPLIER scale
    // This scales the relative steady-state rank vector back to a legible reputation range.
    return (t[targetIndex]! * MULTIPLIER) / SCALE;
  }
}

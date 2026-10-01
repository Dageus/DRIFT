import { EigenTrustEngine } from '../EigenTrust.js';
import type { IEpochEngine } from './IEpochEngine.js';
import {
  ENGINE_ID,
  canonicalize,
  encodeJournal,
  inputDigest,
  settle,
  validateInput,
  type EpochInput,
  type EpochResult
} from './protocol.js';

/**
 * Runs the reference EigenTrust implementation in process. This is Tier 1 when the settler runs
 * it directly, and the oracle the Rust engine is tested against (packages/engines/vectors).
 */
export class LocalEpochEngine implements IEpochEngine {
  async computeEpoch(input: EpochInput): Promise<EpochResult> {
    validateInput(input);
    const c = canonicalize(input);

    const explicit = new Map(c.pretrust.map((w) => [w.node, w.weight]));
    const engine = new EigenTrustEngine({
      schemaDefinition: c.schemaDefinition,
      alpha: c.params.alphaPpm / 1e6,
      epsilon: c.params.epsilonPpm / 1e6,
      iterations: c.params.iterations,
      weightResolver: (node) => explicit.get(node.toLowerCase()) ?? c.defaultWeight
    });
    const scores = engine.calculateAll(
      c.records,
      c.members.map((m) => m.node)
    );

    const { entries, merkleRoot } = settle(c, scores);
    const digest = inputDigest(c);
    const journal = { engineId: ENGINE_ID, contextUID: c.contextUID, epoch: c.epoch, tE: c.tE, inputDigest: digest, merkleRoot };
    return {
      scores,
      entries,
      inputDigest: digest,
      merkleRoot,
      journal,
      journalBytes: encodeJournal(journal),
      evidence: { kind: 'none' }
    };
  }
}

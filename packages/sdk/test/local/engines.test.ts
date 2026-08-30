import { describe, it, expect } from 'vitest';
import { AbiCoder } from 'ethers';
import { EigenTrustEngine } from '../../src/engines/EigenTrust.js';
import { TemporalDecayEngine } from '../../src/engines/TemporalDecay.js';
import type { AttestationRecord } from '../../src/types.js';

describe('Reputation Engines', () => {
  const coder = AbiCoder.defaultAbiCoder();

  const createRecord = (
    attester: string,
    subject: string,
    score: number,
    ageMs: number = 0,
    revoked = false
  ): AttestationRecord => ({
    uid: '0x123',
    schemaUID: '0xabc',
    attester,
    subject,
    timestamp: Math.floor((Date.now() - ageMs) / 1000),
    revoked,
    data: coder.encode(['uint256'], [score])
  });

  describe('EigenTrustEngine', () => {
    it('should correctly calculate steady-state reputation for a simple graph', () => {
      const engine = new EigenTrustEngine({ schemaDefinition: 'uint256 score' });

      const records = [
        createRecord('0xA', '0xB', 100),
        createRecord('0xB', '0xC', 100),
        createRecord('0xC', '0xA', 100)
      ];

      const score = engine.calculateScore(records, '0xA');

      expect(score).toBeGreaterThan(3000n);
      expect(score).toBeLessThan(3500n);
    });

    it('should handle empty arrays and revoked records gracefully', () => {
      const engine = new EigenTrustEngine({ schemaDefinition: 'uint256 score' });
      const records = [createRecord('0xA', '0xB', 100, 0, true)];

      expect(engine.calculateScore([], '0xB')).toBe(0n);
      expect(engine.calculateScore(records, '0xB')).toBe(0n);
    });

    it('resolves the score for the requested subject, not whichever node happens to sort first', () => {
      // Single edge A -> B: B (the vouched-for node, purely receives mass) must score higher than
      // A (the attester, purely sends mass) at any iteration depth. Previously the engine had no
      // `subject` parameter at all and always inferred whichever node happened to sort first among
      // record subjects (here always '0xA', since '0xB' never appears as a record's `subject`) —
      // meaning a caller could never even ask for B's score. This pins that both directions now
      // resolve independently and correctly.
      const engine = new EigenTrustEngine({ schemaDefinition: 'uint256 score' });
      const records = [createRecord('0xA', '0xB', 100)];

      const scoreA = engine.calculateScore(records, '0xA');
      const scoreB = engine.calculateScore(records, '0xB');

      expect(scoreB).toBeGreaterThan(scoreA);
    });

    it('returns a defined nonzero score for an isolated but queried subject, instead of silently 0n', () => {
      const engine = new EigenTrustEngine({ schemaDefinition: 'uint256 score' });
      const records = [createRecord('0xA', '0xB', 100)];

      // '0xZ' never appears as attester or subject in any record — previously this returned 0n
      // because the node was never inserted into the graph at all (targetIndex === -1), which is
      // indistinguishable from a genuinely zero-trust result. It should instead resolve to the
      // node's pretrust-only (teleport) share, a defined nonzero value.
      expect(engine.calculateScore(records, '0xZ')).toBeGreaterThan(0n);
    });

    it('should be deterministic under a canonical node ordering (A3/A5(iii))', () => {
      // Same attestation set, deliberately submitted in several different orders (simulating
      // different indexers/storage backends returning A_c^E in different traversal order).
      // The engine must resolve a canonical order internally and produce a bit-identical score
      // regardless of the order records arrive in.
      const records = [
        createRecord('0xD', '0xA', 40),
        createRecord('0xA', '0xB', 100),
        createRecord('0xC', '0xA', 70),
        createRecord('0xB', '0xC', 100),
        createRecord('0xC', '0xB', 30),
        createRecord('0xB', '0xD', 20)
      ];

      const forward = new EigenTrustEngine({ schemaDefinition: 'uint256 score' }).calculateScore(records, '0xA');
      const reversed = new EigenTrustEngine({ schemaDefinition: 'uint256 score' }).calculateScore(
        [...records].reverse(),
        '0xA'
      );

      // Fixed shuffle distinct from both forward and reverse order.
      const shuffled = [records[3]!, records[0]!, records[5]!, records[1]!, records[4]!, records[2]!];
      const shuffledScore = new EigenTrustEngine({ schemaDefinition: 'uint256 score' }).calculateScore(
        shuffled,
        '0xA'
      );

      expect(reversed).toBe(forward);
      expect(shuffledScore).toBe(forward);
    });
  });

  describe('TemporalDecayEngine', () => {
    it('should discount older attestations based on half-life', () => {
      const thirtyDaysMs = 30 * 24 * 60 * 60 * 1000;
      const engine = new TemporalDecayEngine({ halfLifeMs: thirtyDaysMs });

      const records = [createRecord('0xA', '0xB', 100, 0), createRecord('0xC', '0xB', 100, thirtyDaysMs)];

      const score = engine.calculateScore(records, '0xB');
      expect(score).toBe(100n);
    });

    it('should handle malformed ABI data without crashing', () => {
      const engine = new TemporalDecayEngine();
      const records = [
        createRecord('0xA', '0xB', 100),
        { ...createRecord('0xC', '0xB', 50), data: '0xinvalidjunkbytes' }
      ];

      expect(engine.calculateScore(records, '0xB')).toBe(100n);
    });

    it('ignores records about other subjects when fed the full context graph', () => {
      const engine = new TemporalDecayEngine();
      const records = [createRecord('0xA', '0xB', 100), createRecord('0xC', '0xD', 999)];

      expect(engine.calculateScore(records, '0xB')).toBe(100n);
    });
  });
});

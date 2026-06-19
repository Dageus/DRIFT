import { describe, it, expect } from 'vitest';
import { AbiCoder } from 'ethers';
import { EigenTrustEngine } from '../../src/engines/EigenTrust';
import { TemporalDecayEngine } from '../../src/engines/TemporalDecay';
import type { AttestationRecord } from '../../src/types';

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

      const score = engine.calculateScore(records);

      expect(score).toBeGreaterThan(3000n);
      expect(score).toBeLessThan(3500n);
    });

    it('should handle empty arrays and revoked records gracefully', () => {
      const engine = new EigenTrustEngine({ schemaDefinition: 'uint256 score' });
      const records = [createRecord('0xA', '0xB', 100, 0, true)];

      expect(engine.calculateScore([])).toBe(0n);
      expect(engine.calculateScore(records)).toBe(0n);
    });
  });

  describe('TemporalDecayEngine', () => {
    it('should discount older attestations based on half-life', () => {
      const thirtyDaysMs = 30 * 24 * 60 * 60 * 1000;
      const engine = new TemporalDecayEngine({ halfLifeMs: thirtyDaysMs });

      const records = [createRecord('0xA', '0xB', 100, 0), createRecord('0xC', '0xB', 100, thirtyDaysMs)];

      const score = engine.calculateScore(records);
      expect(score).toBe(100n);
    });

    it('should handle malformed ABI data without crashing', () => {
      const engine = new TemporalDecayEngine();
      const records = [
        createRecord('0xA', '0xB', 100),
        { ...createRecord('0xC', '0xB', 50), data: '0xinvalidjunkbytes' }
      ];

      expect(engine.calculateScore(records)).toBe(100n);
    });
  });
});

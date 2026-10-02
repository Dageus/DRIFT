import { describe, it, expect } from 'vitest';
import { parseEther, parseUnits } from 'ethers';
import { ExperimentConfigError, parseExperimentConfig } from '../../src/config.js';
import { baseConfig } from './fixtures.js';

describe('experiment config', () => {
  it('parses amounts exactly from decimal strings', () => {
    const c = parseExperimentConfig(baseConfig({ reserveEth: '0.0125', gas: { maxFeeGwei: '12.5', priorityFeeGwei: '0.5' } }));
    expect(c.reserveWei).toBe(parseEther('0.0125'));
    expect(c.gas.maxFeeWei).toBe(parseUnits('12.5', 'gwei'));
    expect(c.marginBps).toBe(15_000n);
    expect(c.bonds.settlementWei).toBe(parseEther('0.001'));
  });

  it('reports every problem at once', () => {
    try {
      parseExperimentConfig(
        baseConfig({
          chainId: 0,
          nodes: -1,
          gas: { maxFeeGwei: 10 },
          bonds: { settlementEth: '0.0001' },
          funder: { mnemonicEnv: 'E2E_MNEMONIC', index: 0 },
          margin: 0.5,
          typo: 1
        })
      );
      expect.unreachable();
    } catch (e) {
      const p = (e as ExperimentConfigError).problems.join('\n');
      for (const s of ['chainId', 'nodes', 'gas.maxFeeGwei', 'bonds.settlementEth', 'funder.mnemonicEnv', 'margin', 'typo']) expect(p).toContain(s);
    }
  });

  it('rejects floats for amounts, so no ETH value goes through floating point', () => {
    expect(() => parseExperimentConfig(baseConfig({ reserveEth: 0.01 }))).toThrow(/reserveEth: expected a decimal string/);
  });

  it('checks scenario consistency', () => {
    expect(() => parseExperimentConfig(baseConfig({ tier1: { epochs: 0 } }))).toThrow(/challenge scenarios run on the Tier 1 context/);
    expect(() => parseExperimentConfig(baseConfig({ tier2: { epochs: 2, owners: 3, threshold: 4 } }))).toThrow(/tier2.threshold/);
    expect(() => parseExperimentConfig(baseConfig({ attestations: { perNodePerRound: 6, rounds: 1 } }))).toThrow(/below nodes/);
  });

  it('defaults and checks the deployment settings', () => {
    const cfg = parseExperimentConfig(baseConfig());
    expect(cfg.runTag).toBe('drift-e2e');
    expect(cfg.timing).toEqual({ epochLengthSeconds: 3600, disputeWindowSeconds: 900, responseWindowSeconds: 900 });
    expect(cfg.eas.address).toBe('0xC2679fBD37d54388Ce493F1DB75320D236e1815e');
    expect(() => parseExperimentConfig(baseConfig({ runTag: 'Bad Tag' }))).toThrow(/runTag/);
    expect(() => parseExperimentConfig(baseConfig({ timing: { epochLengthSeconds: 200, disputeWindowSeconds: 100, responseWindowSeconds: 100 } }))).toThrow(
      /must exceed disputeWindowSeconds \+ responseWindowSeconds/
    );
    expect(() => parseExperimentConfig(baseConfig({ eas: { address: '0x1234' } }))).toThrow(/eas.address/);
  });
});

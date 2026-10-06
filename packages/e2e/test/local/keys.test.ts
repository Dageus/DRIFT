import { describe, it, expect } from 'vitest';
import { Mnemonic } from 'ethers';
import { deriveSlots, deriveWallet, loadFunder, loadMnemonic, newMnemonic, slotIndices, LAYOUT } from '../../src/keys.js';
import { parseExperimentConfig } from '../../src/config.js';
import { ANVIL_MNEMONIC, baseConfig } from './fixtures.js';

describe('experiment keys', () => {
  it("derive at m/44'/60'/0'/0/i, matching Foundry's vm.deriveKey (anvil's well-known accounts)", () => {
    const [d, s] = deriveSlots(ANVIL_MNEMONIC, [
      { role: 'deployer', ordinal: 0, index: 0 },
      { role: 'tier1-settler', ordinal: 0, index: 1 }
    ]);
    expect(d!.address).toBe('0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266');
    expect(s!.address).toBe('0x70997970C51812dc3A010C7d01b50e0d17dc79C8');
    expect(s!.path).toBe("m/44'/60'/0'/0/1");
    expect(deriveWallet(ANVIL_MNEMONIC, 1).address).toBe(s!.address);
  });

  it('assign fixed, non-overlapping index ranges by role', () => {
    const cfg = parseExperimentConfig(baseConfig({ nodes: 5 }));
    const slots = slotIndices(cfg);
    const idx = slots.map((s) => s.index);
    expect(new Set(idx).size).toBe(idx.length);
    expect(slots.filter((s) => s.role === 'tier2-owner').map((s) => s.index)).toEqual([10, 11, 12]);
    expect(slots.filter((s) => s.role === 'node').map((s) => s.index)).toEqual([1000, 1001, 1002, 1003, 1004]);
    expect(slots.find((s) => s.role === 'deployer')!.index).toBe(LAYOUT.deployer);
  });

  it('do not change when the experiment grows: node 3 is the same key with 5 or 50 nodes', () => {
    const small = deriveSlots(ANVIL_MNEMONIC, slotIndices(parseExperimentConfig(baseConfig({ nodes: 5 }))));
    const big = deriveSlots(ANVIL_MNEMONIC, slotIndices(parseExperimentConfig(baseConfig({ nodes: 50 }))));
    const node3 = (xs: typeof small) => xs.find((s) => s.role === 'node' && s.ordinal === 3)!.address;
    expect(node3(big)).toBe(node3(small));
  });

  it('omit roles a run does not use', () => {
    const cfg = parseExperimentConfig(baseConfig({ tier2: { epochs: 0 }, adversarial: { watcherChallenges: 0 } }));
    const roles = new Set(slotIndices(cfg).map((s) => s.role));
    expect(roles.has('tier2-owner')).toBe(false);
    expect(roles.has('tier2-hot')).toBe(false);
    expect(roles.has('watcher-hot')).toBe(false);
  });

  it('newMnemonic is a valid 24-word phrase; a bad mnemonic is rejected naming only the variable', () => {
    const m = newMnemonic();
    expect(m.split(' ')).toHaveLength(24);
    expect(() => Mnemonic.fromPhrase(m)).not.toThrow();
    const secret = 'test test test test test test test test test test test test';
    expect(() => loadMnemonic('E2E_MNEMONIC', { E2E_MNEMONIC: secret })).toThrow(/E2E_MNEMONIC does not hold a valid mnemonic/);
    try {
      loadMnemonic('E2E_MNEMONIC', { E2E_MNEMONIC: secret });
    } catch (e) {
      expect((e as Error).message).not.toContain(secret);
    }
    expect(() => loadMnemonic('E2E_MNEMONIC', {})).toThrow(/E2E_MNEMONIC is not set/);
  });

  it('loads the funder from a private key or a mnemonic index, never echoing the secret', () => {
    const pk = '0x' + '11'.repeat(32);
    expect(loadFunder({ privateKeyEnv: 'F' }, { F: pk }).address).toMatch(/^0x/);
    expect(loadFunder({ mnemonicEnv: 'M', index: 1 }, { M: ANVIL_MNEMONIC }).address).toBe('0x70997970C51812dc3A010C7d01b50e0d17dc79C8');
    expect(() => loadFunder({ privateKeyEnv: 'F' }, { F: 'nope' })).toThrow(/^F does not hold a valid private key$/);
  });
});

import { HDNodeWallet, Mnemonic, Wallet, randomBytes } from 'ethers';
import type { ExperimentConfig, FunderSource } from './config.js';
import { MAX_NODES, MAX_TIER2_OWNERS } from './config.js';

/** Every experiment key is m/44'/60'/0'/0/<index>, the path Foundry's vm.deriveKey(mnemonic, i) uses. */
export const BASE_PATH = "m/44'/60'/0'/0";

export type Role =
  | 'deployer'
  | 'tier1-settler'
  | 'tier1-hot'
  | 'tier2-hot'
  | 'watcher-hot'
  | 'tier2-owner'
  | 'node';

/**
 * Fixed index ranges, so a key's role never depends on the experiment's size. The deployer is
 * index 0 because packages/contracts/script/Deploy.s.sol deploys from vm.deriveKey(MNEMONIC, 0).
 */
export const LAYOUT = {
  deployer: 0,
  'tier1-settler': 1,
  'tier1-hot': 2,
  // Index 3 was a single Tier 2 hot wallet. Each owner runs its own daemon and sends from its own
  // hot wallet (one key must never be used by two processes at once, or their nonces collide).
  'watcher-hot': 4,
  tier2OwnerBase: 10,
  tier2HotBase: 30,
  nodeBase: 1000
} as const;

export interface KeySlot {
  role: Role;
  /** Position within its role (owner #, node #); 0 for single-key roles. */
  ordinal: number;
  index: number;
  path: string;
  address: string;
}

/** The slots an experiment uses, in a stable order. Addresses are filled by `deriveSlots`. */
export function slotIndices(cfg: Pick<ExperimentConfig, 'nodes' | 'tier1' | 'tier2' | 'adversarial'>): Omit<KeySlot, 'address' | 'path'>[] {
  if (cfg.tier2.owners > MAX_TIER2_OWNERS) throw new Error(`at most ${MAX_TIER2_OWNERS} Tier 2 owners`);
  if (cfg.nodes > MAX_NODES) throw new Error(`at most ${MAX_NODES} nodes`);
  const out: Omit<KeySlot, 'address' | 'path'>[] = [{ role: 'deployer', ordinal: 0, index: LAYOUT.deployer }];
  if (cfg.tier1.epochs > 0) {
    out.push({ role: 'tier1-settler', ordinal: 0, index: LAYOUT['tier1-settler'] });
    out.push({ role: 'tier1-hot', ordinal: 0, index: LAYOUT['tier1-hot'] });
  }
  if (cfg.tier2.epochs > 0) {
    for (let i = 0; i < cfg.tier2.owners; i++) out.push({ role: 'tier2-owner', ordinal: i, index: LAYOUT.tier2OwnerBase + i });
    for (let i = 0; i < cfg.tier2.owners; i++) out.push({ role: 'tier2-hot', ordinal: i, index: LAYOUT.tier2HotBase + i });
  }
  if (cfg.adversarial.watcherChallenges > 0) out.push({ role: 'watcher-hot', ordinal: 0, index: LAYOUT['watcher-hot'] });
  for (let i = 0; i < cfg.nodes; i++) out.push({ role: 'node', ordinal: i, index: LAYOUT.nodeBase + i });
  return out;
}

function baseNode(mnemonic: string): HDNodeWallet {
  // Mnemonic.fromPhrase validates the checksum, so a typo fails here, not with silently wrong keys.
  return HDNodeWallet.fromMnemonic(Mnemonic.fromPhrase(mnemonic.trim()), BASE_PATH);
}

/** Derives addresses (and only addresses) for every slot. */
export function deriveSlots(mnemonic: string, slots: Omit<KeySlot, 'address' | 'path'>[]): KeySlot[] {
  const base = baseNode(mnemonic);
  return slots.map((s) => ({ ...s, path: `${BASE_PATH}/${s.index}`, address: base.deriveChild(s.index).address }));
}

/** The private key of one slot, for the sweeper. Never logged. */
export function deriveWallet(mnemonic: string, index: number): HDNodeWallet {
  return baseNode(mnemonic).deriveChild(index);
}

/** A fresh 24-word mnemonic. */
export function newMnemonic(): string {
  return Mnemonic.fromEntropy(randomBytes(32)).phrase;
}

/** The funder's wallet from the environment. Errors name variables, never values. */
export function loadFunder(src: FunderSource, env: NodeJS.ProcessEnv = process.env): Wallet | HDNodeWallet {
  if ('privateKeyEnv' in src) {
    const v = env[src.privateKeyEnv];
    if (!v) throw new Error(`environment variable ${src.privateKeyEnv} is not set`);
    try {
      return new Wallet(v.trim());
    } catch {
      throw new Error(`${src.privateKeyEnv} does not hold a valid private key`);
    }
  }
  const v = env[src.mnemonicEnv];
  if (!v) throw new Error(`environment variable ${src.mnemonicEnv} is not set`);
  try {
    return baseNode(v).deriveChild(src.index);
  } catch {
    throw new Error(`${src.mnemonicEnv} does not hold a valid mnemonic`);
  }
}

export function loadMnemonic(envName: string, env: NodeJS.ProcessEnv = process.env): string {
  const v = env[envName];
  if (!v) throw new Error(`environment variable ${envName} is not set`);
  try {
    Mnemonic.fromPhrase(v.trim());
  } catch {
    throw new Error(`${envName} does not hold a valid mnemonic`);
  }
  return v.trim();
}

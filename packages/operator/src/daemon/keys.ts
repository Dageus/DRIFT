import { Wallet, type Provider } from 'ethers';
import { DriftConfigError } from '@drift-network/sdk';
import type { KeyRef } from './config.js';

/**
 * Loads a key from the environment variable a KeyRef names. Errors name the variable, never its
 * value, and the key never leaves the returned Wallet.
 */
export function loadKey(ref: KeyRef, provider: Provider, env: NodeJS.ProcessEnv = process.env): Wallet {
  const value = env[ref.env];
  if (!value) throw new DriftConfigError(`DRIFT operator: environment variable ${ref.env} is not set.`);
  try {
    return new Wallet(value.trim(), provider);
  } catch {
    throw new DriftConfigError(`DRIFT operator: ${ref.env} does not hold a valid private key.`);
  }
}

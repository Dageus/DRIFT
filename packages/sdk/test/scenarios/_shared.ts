import * as anvil from '../fixtures/anvil.config';

const NETWORK = process.env.NETWORK || 'anvil';

export type NetworkConfig = typeof anvil;

const configs: Record<string, NetworkConfig> = {
  anvil
};

const config = configs[NETWORK];

if (!config) {
  throw new Error(`Unknown network: "${NETWORK}". Available: ${Object.keys(configs).join(', ')}`);
}

export const {
  provider,
  deployer,
  tester,
  alice,
  bob,
  ADDRESSES,
  SCHEMAS,
  validateConfig,
  getPendingNonce,
  sendWithSyncedNonce
} = config;

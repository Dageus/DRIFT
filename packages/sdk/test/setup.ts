console.log('Loading setup.ts...');
import { beforeAll, afterAll } from 'vitest';
import { provider, deployer, tester, alice, bob, validateConfig, getPendingNonce } from './fixtures/anvil.config';

beforeAll(async () => {
  validateConfig();

  try {
    const network = await provider.getNetwork();
    const deployerAddr = await deployer.getAddress();
    const deployerBal = await provider.getBalance(deployerAddr);

    if (deployerBal === 0n) {
      throw new Error(`Deployer ${deployerAddr} has no funds.`);
    }
  } catch (err) {
    console.error('[setup] Failed:', err);
    throw err;
  }

  await getPendingNonce(await tester.getAddress());
  await getPendingNonce(await alice.getAddress());
  await getPendingNonce(await bob.getAddress());
});

afterAll(async () => {
  console.log('[setup] Tests complete');
});

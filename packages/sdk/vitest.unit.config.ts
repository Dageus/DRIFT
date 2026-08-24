import { defineConfig } from 'vitest/config';

/**
 * Hermetic unit-test config: no live anvil node, no MNEMONIC, no deployed contracts. Restricted
 * to test files that don't import test/scenarios/_shared.ts (which resolves wallets/addresses
 * from a live chain at module-load time, independent of any setupFiles guard) — see
 * test/e2e/**. This is what `npm test` runs in CI (A8); `npm run test:e2e` runs the full,
 * infra-dependent suite via vitest.config.ts.
 */
export default defineConfig({
  test: {
    include: ['test/local/**/*.test.ts', 'test/merkle-alignment.test.ts'],
    pool: 'forks',
    maxWorkers: 1
  }
});

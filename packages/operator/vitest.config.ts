import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';

const sdk = (p: string) => fileURLToPath(new URL(`../sdk/src/${p}`, import.meta.url));

/**
 * Hermetic by default: the anvil e2e (DRIFT_E2E_ANVIL) and the Rust engine tests (built binary)
 * skip themselves when their prerequisites are missing. The SDK resolves to its sources, so tests
 * do not need it built.
 */
export default defineConfig({
  resolve: {
    alias: [
      { find: /^@drift-network\/sdk$/, replacement: sdk('index.ts') },
      { find: /^@drift-network\/sdk\/(.+)$/, replacement: sdk('$1/index.ts') }
    ]
  },
  test: {
    include: ['test/local/**/*.test.ts'],
    pool: 'forks',
    maxWorkers: 1
  }
});

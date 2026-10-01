import { defineConfig } from 'vitest/config';

/** Hermetic by default; the anvil funding test runs only with DRIFT_E2E_ANVIL set. */
export default defineConfig({
  test: {
    include: ['test/local/**/*.test.ts'],
    pool: 'forks',
    maxWorkers: 1
  }
});

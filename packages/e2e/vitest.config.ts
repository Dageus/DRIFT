import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';

const src = (pkg: string, p: string) => fileURLToPath(new URL(`../${pkg}/src/${p}`, import.meta.url));

/** Hermetic by default; anvil tests run only with DRIFT_E2E_ANVIL set. Workspace packages resolve to sources. */
export default defineConfig({
  resolve: {
    alias: [
      { find: /^@drift-network\/sdk$/, replacement: src('sdk', 'index.ts') },
      { find: /^@drift-network\/sdk\/(.+)$/, replacement: src('sdk', '$1/index.ts') },
      { find: /^@drift-network\/operator$/, replacement: src('operator', 'index.ts') }
    ]
  },
  test: {
    include: ['test/local/**/*.test.ts'],
    pool: 'forks',
    maxWorkers: 1
  }
});

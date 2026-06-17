import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    setupFiles: ['./test/setup.ts'],
    pool: 'forks',
    maxWorkers: 1,
    fileParallelism: false,
    testTimeout: 10_000,
    hookTimeout: 80_000,
    sequence: {
      concurrent: false,
      shuffle: false,
      hooks: 'list'
    }
  }
});

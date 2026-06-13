import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    pool: 'forks',
    maxWorkers: 1,
    fileParallelism: false,
    testTimeout: 10_000,
    hookTimeout: 8_000,
    sequence: {
      concurrent: false,
      shuffle: false,
      hooks: 'list',
    }
  }
});

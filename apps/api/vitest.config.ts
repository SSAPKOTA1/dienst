import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    // tests change roles and statuses and expect the next request to see it
    env: { PRINCIPAL_CACHE_MS: '0' },
    globalSetup: ['./test/global-setup.ts'],
    fileParallelism: false,
    testTimeout: 30000,
    hookTimeout: 60000,
    include: ['test/**/*.test.ts'],
    coverage: {
      provider: 'v8',
      include: ['src/**'],
      exclude: ['src/db/types.ts', 'src/seed/**', 'src/worker.ts', 'src/server.ts'],
      thresholds: { statements: 88, branches: 74, functions: 91, lines: 91 },
    },
  },
});

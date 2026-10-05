import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    coverage: {
      provider: 'v8',
      include: ['src/**'],
      // the legal core: thresholds are a floor, raise them when coverage grows
      thresholds: { statements: 90, branches: 88, functions: 85, lines: 93 },
    },
  },
});

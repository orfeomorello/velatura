import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: [
      'packages/*/test/**/*.test.ts',
      'packages/*/src/**/*.test.ts',
      'apps/*/src/**/*.test.ts',
      'scripts/**/*.test.ts',
    ],
    environment: 'node',
    reporters: 'default',
    // the temporary folders of the tests do not survive the run
    globalSetup: ['./scripts/test-cleanup.ts'],
  },
});

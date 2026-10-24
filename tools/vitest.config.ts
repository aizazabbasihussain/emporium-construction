import path from 'node:path';
import { defineConfig } from 'vitest/config';

// Tooling self-tests run child processes (vitest, depcruise, eslint, tsc), so they are slow and
// must not run in parallel with each other or with the main coverage run.
export default defineConfig({
  test: {
    name: '@emporium/tools',
    root: path.resolve(import.meta.dirname, '..'),
    include: ['tools/__tests__/**/*.test.ts'],
    testTimeout: 300_000,
    hookTimeout: 300_000,
    fileParallelism: false,
  },
});

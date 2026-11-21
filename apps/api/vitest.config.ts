import { defineProject } from 'vitest/config';

// API tests use an in-process PGlite database and run in parallel with the whole suite, so a test
// that takes well under a second alone can pass 5 seconds under load. Same reason as web and db.
export default defineProject({
  test: {
    name: '@emporium/api',
    include: ['src/**/*.test.ts'],
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
});

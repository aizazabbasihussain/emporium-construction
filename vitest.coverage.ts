import type { CoverageOptions } from 'vitest/node';

/** Business logic that must stay at 100% coverage (P0-01 BR-3). */
export const businessLogicGlobs = [
  'packages/domain/**/*.ts',
  'apps/api/src/modules/*/service/**/*.ts',
  'apps/api/src/modules/*/policy/**/*.ts',
  // Repository tooling with real logic (P0-02 T-4).
  'tools/docs-check/src/**/*.ts',
];

/** Exclusions are limited to tests, generated code, type files, index re-exports and config. */
export const coverageExcludes = [
  '**/*.test.ts',
  '**/*.test.tsx',
  '**/*.d.ts',
  '**/generated/**',
  '**/index.ts',
  '**/*.config.*',
];

export function coverageOptions(include: string[] = businessLogicGlobs): CoverageOptions {
  return {
    provider: 'v8',
    include,
    exclude: coverageExcludes,
    reporter: ['text-summary', 'json-summary', 'lcov'],
    reportsDirectory: 'coverage',
    thresholds: { lines: 100, branches: 100, functions: 100, statements: 100 },
  };
}

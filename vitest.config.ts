import { defineConfig } from 'vitest/config';
import { coverageOptions } from './vitest.coverage.ts';

export default defineConfig({
  test: {
    projects: ['packages/*', 'apps/*', 'tools/docs-check'],
    coverage: coverageOptions(),
  },
});

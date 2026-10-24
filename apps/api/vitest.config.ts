import { defineProject } from 'vitest/config';

export default defineProject({
  test: { name: '@emporium/api', include: ['src/**/*.test.ts'] },
});

import { defineProject } from 'vitest/config';

// PGlite takes a few seconds to start, so database tests get a longer timeout.
export default defineProject({
  test: { name: '@emporium/db', testTimeout: 60_000, hookTimeout: 60_000 },
});

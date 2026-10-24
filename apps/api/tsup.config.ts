import { defineConfig } from 'tsup';

export default defineConfig({
  entry: ['src/main.ts'],
  format: ['esm'],
  target: 'node22',
  platform: 'node',
  clean: true,
  sourcemap: true,
  // Workspace packages ship as TypeScript source, so they are bundled in.
  noExternal: [/^@emporium\//],
});

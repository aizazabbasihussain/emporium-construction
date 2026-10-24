import react from '@vitejs/plugin-react';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  plugins: [react()],
  server: { port: 5173 },
  test: {
    name: '@emporium/web',
    environment: 'jsdom',
    globals: true,
    // Ant Design forms render slowly when the whole suite runs in parallel.
    testTimeout: 15_000,
    setupFiles: ['./src/test-setup.ts'],
    include: ['src/**/*.test.{ts,tsx}'],
  },
});

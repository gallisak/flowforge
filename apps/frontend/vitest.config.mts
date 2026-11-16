import react from '@vitejs/plugin-react';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';
const ROUTE_TESTS = 'test/**/*-route.test.ts';

export default defineConfig({
  plugins: [react()],
  resolve: { alias: { '@': fileURLToPath(new URL('.', import.meta.url)) } },
  test: {
    setupFiles: ['test/setup.ts'],
    restoreMocks: true,
    unstubGlobals: true,
    projects: [
      { extends: true, test: { name: 'routes', environment: 'node', include: [ROUTE_TESTS] } },
      { extends: true, test: { name: 'ui', environment: 'jsdom', include: ['test/**/*.test.{ts,tsx}'], exclude: [ROUTE_TESTS] } },
    ],
  },
});

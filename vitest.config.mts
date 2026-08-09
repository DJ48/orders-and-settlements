import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['lib/**/*.test.ts', 'test/**/*.test.ts'],
    // The first run downloads a mongod binary; later runs still spin up a replica set.
    hookTimeout: 180_000,
    testTimeout: 60_000,
  },
  resolve: {
    // Mirrors the `@/*` alias in tsconfig.json so tests resolve imports the same way Next does.
    alias: { '@': fileURLToPath(new URL('.', import.meta.url)) },
  },
});

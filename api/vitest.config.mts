import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    // Tests live in test/, mirroring the src/ tree.
    include: ['test/**/*.test.ts'],
    // Integration tests spin up an in-memory MongoDB replica set; the first run downloads
    // the mongod binary, which is slow but cached afterwards.
    hookTimeout: 180_000,
    testTimeout: 60_000,
  },
});

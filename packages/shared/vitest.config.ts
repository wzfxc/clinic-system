import path from 'node:path';
import { defineConfig } from 'vitest/config';

// Integration tests read DATABASE_URL from the repo-root .env; variables already
// set in the environment (CI) win because loadEnvFile never overrides them.
try {
  process.loadEnvFile(path.resolve(import.meta.dirname, '../../.env'));
} catch (err) {
  if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
}

export default defineConfig({
  // Integration tests create a database per file and run concurrent transactions.
  test: { include: ['src/**/*.test.ts'], testTimeout: 30_000 },
});

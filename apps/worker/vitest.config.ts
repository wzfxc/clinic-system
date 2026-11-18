import path from 'node:path';
import swc from 'unplugin-swc';
import { defineConfig } from 'vitest/config';

// Integration tests read DATABASE_URL and REDIS_URL from the repo-root .env; variables already
// set in the environment (CI) win because loadEnvFile never overrides them.
try {
  process.loadEnvFile(path.resolve(import.meta.dirname, '../../.env'));
} catch (err) {
  if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
}

// SWC потрібен для decorator metadata (NestJS DI); esbuild його не емітить.
export default defineConfig({
  test: { include: ['src/**/*.test.ts'], testTimeout: 30_000 },
  plugins: [swc.vite({ module: { type: 'es6' } })],
});

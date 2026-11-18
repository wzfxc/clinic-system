import path from 'node:path';
import { defineConfig } from '@playwright/test';

try {
  process.loadEnvFile(path.resolve(process.cwd(), '../../.env'));
} catch {
  // Environment variables may already be provided.
}

export default defineConfig({
  testDir: './e2e',
  timeout: 60_000,
  expect: { timeout: 15_000 },
  workers: 1,
  use: {
    baseURL: process.env.WEB_URL ?? 'http://localhost:3000',
  },
  webServer: [
    {
      command: 'node ../api/dist/main.js',
      url: 'http://localhost:4000/health',
      reuseExistingServer: true,
      timeout: 60_000,
    },
    {
      command: 'pnpm start -p 3000',
      url: 'http://localhost:3000',
      reuseExistingServer: true,
      timeout: 60_000,
    },
  ],
});

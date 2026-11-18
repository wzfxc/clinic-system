import swc from 'unplugin-swc';
import { defineConfig } from 'vitest/config';

// SWC потрібен для decorator metadata (NestJS DI); esbuild його не емітить.
export default defineConfig({
  test: { include: ['src/**/*.test.ts'] },
  plugins: [swc.vite({ module: { type: 'es6' } })],
});

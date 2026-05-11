import path from 'path';
import { fileURLToPath } from 'url';
import { defineConfig } from 'vitest/config';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');

export default defineConfig({
  resolve: {
    alias: {
      // Mirror the alias from the main vitest.config.ts so `src/` imports work
      src: path.resolve(root, 'src'),
    },
  },
  test: {
    root,
    environment: 'node',
    include: ['src/graph/__tests__/eval/**/*.eval.test.ts'],

    // Run setup BEFORE any test file is imported so module-level env reads work
    setupFiles: ['./test/eval-setup.ts'],

    // Agent calls are slow — give each test plenty of time
    testTimeout: 180_000,
    hookTimeout: 60_000,

    // Sequential: one example at a time prevents LLM rate-limit issues and
    // makes failure output readable.
    pool: 'forks',
    poolOptions: {
      forks: {
        singleFork: true,
      },
    },
  },
});

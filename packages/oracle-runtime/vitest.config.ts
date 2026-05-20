import { defineConfig, mergeConfig } from 'vitest/config';
import nestConfig from '@ixo/vitest-config/nest';

/**
 * Two modes:
 *  - default (`vitest run`)         — unit tests, fast, mocked ambient services.
 *  - `int`   (`vitest run --mode int`) — integration tests, real Nest boot, real
 *                                       upstreams when env is provisioned.
 *
 * Vitest's `mergeConfig` concats arrays (`include`, `setupFiles`, …), so each
 * block builds the merged base then *overwrites* the include/exclude/setup
 * fields explicitly. Keeps `pnpm test` from picking up `.int.test.ts` files
 * and `pnpm test:integration` from running unit tests twice.
 *
 * Integration mode runs files SEQUENTIALLY (`fileParallelism: false`).
 * Each integration test file boots a real Nest oracle that connects to the
 * same Matrix admin user — running two boots concurrently triggers Matrix
 * one-time-key collisions on the server.
 */
export default defineConfig(({ mode }) => {
  if (mode === 'int') {
    const merged = mergeConfig(nestConfig, {});
    merged.test = {
      ...merged.test,
      include: ['src/**/*.int.test.ts', 'test/**/*.int.test.ts'],
      exclude: ['node_modules', 'dist'],
      testTimeout: 120_000,
      hookTimeout: 120_000,
      setupFiles: ['./src/testing/integration/setup.ts'],
      fileParallelism: false,
    };
    return merged;
  }

  const merged = mergeConfig(nestConfig, {});
  merged.test = {
    ...merged.test,
    // Default mode is unit tests only — never collect integration files.
    exclude: [
      ...(merged.test?.exclude ?? []),
      '**/*.int.test.ts',
    ],
    setupFiles: ['./test-setup.ts'],
  };
  return merged;
});

import nestConfig from '@ixo/vitest-config/nest';
import { defineConfig, mergeConfig } from 'vitest/config';

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
 * Integration mode runs files in PARALLEL (one fork per file). Each fork
 * mints its own Matrix device session in setup.ts so there are no one-time-key
 * collisions on the homeserver.
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
      slowTestThreshold: 60_000 * 3,
    };
    return merged;
  }

  const merged = mergeConfig(nestConfig, {});
  merged.test = {
    ...merged.test,
    // Default mode is unit tests only — never collect integration files.
    exclude: [...(merged.test?.exclude ?? []), '**/*.int.test.ts'],
    setupFiles: ['./test-setup.ts'],
  };
  return merged;
});

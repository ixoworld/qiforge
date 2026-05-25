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
/**
 * Coverage exclude patterns shared by both modes. The set is calibrated so the
 * reported number reflects *production code you'd reasonably want tested*, not
 * the raw line count of everything in `src/`. Excluded:
 *
 *   - `dist/**` — compiled JS, never executed by tests (would dominate as 0%).
 *   - `**\/*.config.ts` — build/test configs.
 *   - test scaffolding (`src/testing/**`, `**\/__test-fixtures__/**`, `**\/*.int.test.ts`).
 *   - DTOs + barrel `index.ts` + `*.d.ts` (definitions only, no logic).
 *   - thin transports (`messages.controller.ts`, `sessions.controller.ts`) —
 *     covered by integration tests, intentionally not unit-tested.
 *   - boot wiring (`create-oracle-app.ts`, `graceful-shutdown.ts`) — same
 *     reason, hit by integration tests only.
 *   - out-of-scope modules (`ws/`, `editor/`, `matrix/checkpointer/`, `llm/`,
 *     `composio/`, `credits/`, `user-preferences/`, `slack.service.ts`) — no
 *     unit tests yet, would skew the rollup. Re-include once tests land.
 */
const COVERAGE_EXCLUDE = [
  'dist/**',
  '**/*.config.ts',
  '**/*.d.ts',
  '**/index.ts',
  '**/types.ts',
  '**/__test-fixtures__/**',
  '**/dto/*.dto.ts',
  'src/testing/**',
  'test/**',
  'src/**/*.int.test.ts',
  'src/modules/messages/messages.controller.ts',
  'src/modules/sessions/sessions.controller.ts',
  'src/bootstrap/create-oracle-app.ts',
  'src/bootstrap/graceful-shutdown.ts',
  'src/plugins/editor/**',
  'src/matrix/checkpointer/**',
  'src/llm/**',
  'src/plugins/composio/**',
  'src/plugins/credits/**',
  'src/plugins/slack/slack.service.ts',
  'src/plugins/user-preferences/**',
  'src/modules/ws/**',
  'src/utils/emoji.ts',
];

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
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json-summary'],
      exclude: COVERAGE_EXCLUDE,
    },
  };
  return merged;
});

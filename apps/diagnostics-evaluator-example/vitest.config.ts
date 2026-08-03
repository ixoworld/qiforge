import { mergeConfig, defineConfig } from 'vitest/config';
import nestConfig from '@ixo/vitest-config/nest';

/**
 * Tests live in `test/` rather than beside the source: they exercise the
 * shipped `domain.md` against the real evaluator, so they belong to the app
 * rather than to any one module in it.
 */
export default defineConfig(() => {
  const merged = mergeConfig(nestConfig, {});
  merged.test = {
    ...merged.test,
    include: ['test/**/*.test.ts'],
    exclude: ['node_modules', 'dist'],
  };
  return merged;
});

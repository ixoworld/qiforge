import { defineConfig } from 'vitest/config';

/**
 * Plain-Node vitest project for the runtime core (`src/core/**`) and the
 * bundled plugins (`src/plugins/**`). Both are pure TypeScript over `fetch` +
 * LangChain, so they need no workerd; running them here keeps the fast
 * feedback loop separate from the Workers-pool suite in `vitest.config.ts`
 * (`pnpm test`). Invoke with `pnpm test:core`.
 */
export default defineConfig({
  test: {
    environment: 'node',
    // The editor and flows plugin tests are NOT here: they must run under
    // workerd (the Workers-pool project in `vitest.config.ts`) because they
    // prove the BlockNote markdown→blocks bridge and @ixo/editor/core on the
    // real runtime.
    include: [
      'src/core/**/*.test.ts',
      'src/plugins/*.test.ts',
      'src/plugins/!(editor|flows)/**/*.test.ts',
      'src/secrets/**/*.test.ts',
      'src/memory/**/*.test.ts',
      'src/llm/**/*.test.ts',
      'src/attachments/**/*.test.ts',
    ],
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
});

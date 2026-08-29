import baseConfig, { defineConfig, mergeConfig } from '@ixo/vitest-config/base';

export default mergeConfig(
  baseConfig,
  defineConfig({
    resolve: {
      alias: {
        '@ixo/oracle-runtime/plugin-api': new URL(
          '../oracle-runtime/src/plugin-api/index.ts',
          import.meta.url,
        ).pathname,
        '@ixo/common/ai/tools/action-caller': new URL(
          '../common/src/ai/tools/action-caller.ts',
          import.meta.url,
        ).pathname,
      },
    },
    test: {
      include: ['tests/**/*.test.ts'],
    },
  }),
);

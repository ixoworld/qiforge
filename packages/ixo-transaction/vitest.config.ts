import baseConfig, { defineConfig, mergeConfig } from '@ixo/vitest-config/base';

export default mergeConfig(
  baseConfig,
  defineConfig({
    resolve: {
      alias: {
        '@ixo/oracle-runtime': new URL(
          './tests/fixtures/oracle-runtime-stub.ts',
          import.meta.url,
        ).pathname,
      },
    },
    test: {
      include: ['tests/**/*.test.ts'],
    },
  }),
);

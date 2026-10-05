import baseConfig, { defineConfig, mergeConfig } from '@ixo/vitest-config/base';

export default mergeConfig(
  baseConfig,
  defineConfig({
    test: {
      include: ['tests/**/*.test.ts'],
    },
  }),
);

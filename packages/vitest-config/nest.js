import swc from 'unplugin-swc';
import { defineConfig, mergeConfig } from 'vitest/config';
import baseConfig from './base.js';

export default mergeConfig(
  baseConfig,
  defineConfig({
    plugins: [
      swc.vite({
        module: { type: 'es6' },
      }),
    ],
  }),
);

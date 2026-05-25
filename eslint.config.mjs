import { base } from '@ixo/eslint-config/base';
import vitest from '@vitest/eslint-plugin';

export default [
  // Core rules from shared preset (includes ignores, recommended presets,
  // all TS rules, JS disableTypeChecked)
  ...base,

  // Project-specific ignores (supplement base ignores)
  {
    ignores: [
      '**/*.config.js',
      '**/*.config.mjs',
      '**/*.config.cjs',
      '**/*.setup.js',
      'apps/app/**',
      'packages/vitest-config/**',
      'packages/eslint-config/prettier-base.cjs',
    ],
  },

  // Set tsconfigRootDir for monorepo root (base uses projectService: true
  // but doesn't set tsconfigRootDir)
  {
    files: ['**/*.ts', '**/*.tsx'],
    languageOptions: {
      parserOptions: { tsconfigRootDir: import.meta.dirname },
    },
  },

  // NestJS app + backend packages
  {
    files: [
      'packages/common/src/**/*.ts',
      'packages/events/src/**/*.ts',
      'packages/matrix/src/**/*.ts',
      'packages/data-store/src/**/*.ts',
      'packages/oracles-chain-client/src/**/*.ts',
      'packages/slack/src/**/*.ts',
      'packages/logger/src/**/*.ts',
      'packages/sqlite-saver/src/**/*.ts',
      'packages/ucan/src/**/*.ts',
    ],
    rules: {
      '@typescript-eslint/explicit-module-boundary-types': 'off',
      '@typescript-eslint/no-extraneous-class': 'off',
    },
  },

  // Client SDK (library)
  {
    files: [
      'packages/oracles-client-sdk/src/**/*.ts',
      'packages/oracles-client-sdk/src/**/*.tsx',
    ],
    rules: {
      '@typescript-eslint/explicit-function-return-type': 'off',
    },
  },

  // Test files
  {
    files: [
      '**/__tests__/**/*.[jt]s?(x)',
      '**/?(*.)+(spec|test).[jt]s?(x)',
    ],
    plugins: { vitest },
    rules: {
      ...vitest.configs.recommended.rules,
    },
  },
];

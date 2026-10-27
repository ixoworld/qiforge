import vitest from '@vitest/eslint-plugin';
import { base } from './base.js';

/**
 * NestJS ESLint flat config. Extends base with NestJS-specific rules and Vitest.
 */
export const nest = [
  ...base,
  {
    files: ['**/*.ts', '**/*.tsx'],
    rules: {
      '@typescript-eslint/explicit-module-boundary-types': 'off',
      '@typescript-eslint/no-extraneous-class': 'off',
    },
  },
  {
    files: ['**/__tests__/**/*.[jt]s?(x)', '**/?(*.)+(spec|test).[jt]s?(x)'],
    plugins: { vitest },
    rules: {
      ...vitest.configs.recommended.rules,
    },
  },
];

export default nest;

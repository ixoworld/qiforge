import { defineConfig, mergeConfig } from 'vitest/config';

export { defineConfig, mergeConfig };

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    passWithNoTests: true,
    include: ['src/**/*.{test,spec}.{ts,tsx}'],
    exclude: ['node_modules', 'dist'],
    coverage: {
      provider: 'v8',
      exclude: [
        'node_modules',
        'dist',
        'test-config',
        'interfaces',
        '**/*.module.ts',
        '**/types/**',
      ],
    },
  },
});

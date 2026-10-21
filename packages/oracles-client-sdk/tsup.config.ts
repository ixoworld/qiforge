import { defineConfig } from 'tsup';

export default defineConfig({
  entry: [
    'src/index.ts',
    'src/live-agent/index.ts',
    'src/action-interactions/index.ts',
  ],
  format: ['cjs', 'esm'],
  dts: true,
  // The interaction contract is ESM-only; bundling it keeps the CommonJS
  // entry loadable on Node versions that cannot `require` ES modules.
  noExternal: ['@ixo/action-interactions'],
});

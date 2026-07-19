/**
 * Same portability gate as @ixo/oracle-core, applied to the WHOLE worker
 * entry graph (this app + core): bundle for a neutral platform with bare
 * package imports external and fail on any `node:` specifier. Proves the
 * spike needs no `nodejs_compat` — which wrangler.toml accordingly omits.
 */
import { build } from 'esbuild';

const result = await build({
  entryPoints: [new URL('../src/index.ts', import.meta.url).pathname],
  bundle: true,
  platform: 'neutral',
  format: 'esm',
  packages: 'external',
  write: false,
  logLevel: 'silent',
});

const output = result.outputFiles.map((f) => f.text).join('\n');
const nodeSpecifiers = output.match(/from\s*["']node:[^"']+["']/g) ?? [];
if (nodeSpecifiers.length > 0) {
  console.error(
    `Worker entry bundle contains Node specifiers:\n  ${nodeSpecifiers.join('\n  ')}`,
  );
  process.exit(1);
}
console.log(
  `@ixo/oracle-worker: neutral-platform entry bundle OK (${(output.length / 1024).toFixed(1)} KiB, 0 node: specifiers).`,
);

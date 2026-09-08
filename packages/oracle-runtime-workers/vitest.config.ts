import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

const here = dirname(fileURLToPath(import.meta.url));
import { cloudflareTest } from '@cloudflare/vitest-pool-workers';

/**
 * Unit/integration tests run INSIDE workerd via the Workers vitest pool, so
 * every test exercises the real runtime (Durable Object SQLite, WASM
 * instantiation, nodejs_compat polyfills) — not a Node approximation.
 *
 * `test/wrangler.test.jsonc` declares the test-only Durable Objects; the
 * entry is `test/worker.ts`.
 */
export default defineConfig({
  resolve: {
    alias: {
      // Mirror the wrangler `alias` (test/wrangler.test.jsonc): the crypto
      // crate's stock entrypoint calls WebAssembly.instantiateStreaming, which
      // workerd lacks. The bot SDK's shim instantiates the build-time-compiled
      // .wasm and dedupes the crate (matrix-js-sdk pins its own copy otherwise).
      '@matrix-org/matrix-sdk-crypto-wasm':
        '@ixo/matrix-bot-workers-sdk/crypto-wasm-shim',
      // Real jsdom needs `node:vm` script contexts, which workerd only stubs.
      // `@blocknote/server-util` (the editor plugin's markdown→blocks bridge)
      // only uses jsdom for a window/document pair, so it gets the
      // linkedom-backed shim instead.
      jsdom: resolve(here, 'src/plugins/editor/jsdom-shim.ts'),
    },
  },
  plugins: [
    cloudflareTest({
      wrangler: { configPath: './test/wrangler.test.jsonc' },
      // Never open a remote Cloudflare session from tests.
      remoteBindings: false,
    }),
  ],
  test: {
    include: ['src/**/*.test.ts', 'test/**/*.test.ts'],
    // Most bundled-plugin unit tests are plain-Node suites (they vi.mock the
    // MCP / composio SDKs, which the workerd module-fallback service cannot
    // serve); they run in the `vitest.core.config.ts` project
    // (`pnpm test:core`). The editor and flows plugins are the exception:
    // their tests MUST run under workerd — they prove the BlockNote
    // markdown→blocks bridge (jsdom→linkedom shim) and the @ixo/editor/core
    // compiler on the real runtime — so they stay in this pool.
    exclude: [
      'src/plugins/*.test.ts',
      'src/plugins/!(editor|flows)/**/*.test.ts',
      // Plain-Node suite (fake fetch); runs in vitest.core.config.ts.
      'src/memory/**/*.test.ts',
      '**/node_modules/**',
    ],
    testTimeout: 60_000,
    hookTimeout: 60_000,
    deps: {
      optimizer: {
        ssr: {
          // Pre-bundle CJS chains so the pool's module-fallback service
          // doesn't stall serving them one HTTP round-trip at a time.
          include: ['wa-sqlite', '@noble/hashes', 'matrix-js-sdk'],
        },
      },
    },
  },
});

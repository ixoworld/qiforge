/**
 * Phase 1 — Capability-loading meta-tools (`list_capabilities`,
 * `load_capability`).
 *
 * These two tools mediate every on-demand plugin in the runtime. A
 * regression here silently breaks every `visibility: 'on-demand'` plugin —
 * the agent can't see them in `list_capabilities`, can't bind their tools
 * via `load_capability`, can't use them at all.
 *
 * Spec items covered:
 *  - 1.12 `list_capabilities({})` returns rows with correct visibility/loaded
 *  - 1.13 `load_capability({ name: <on-demand plugin> })` updates state
 *  - 1.14 `load_capability` for an unknown plugin throws clean error
 *  - 1.15 `load_capability` for a silent plugin throws clean error
 *
 * Item 1.16 (the agent calls `list_capabilities` for "What can you do?")
 * needs a real Matrix-loaded oracle + a real model call. Documented as a
 * known follow-up — see comment at the bottom of this file.
 */
import { describe, expect, test } from 'vitest';
import { FirecrawlPlugin } from '../../src/plugins/firecrawl/index.js';
import { MemoryPlugin } from '../../src/plugins/memory/index.js';
import { CreditsPlugin } from '../../src/plugins/credits/index.js';
import { createIntegrationRuntime } from '../../src/testing/integration/index.js';

const REQUIRED_ENV = [
  'ORACLE_DID',
  'ORACLE_ENTITY_DID',
  'MEMORY_MCP_URL',
  'BLOCKSYNC_GRAPHQL_URL',
  'TEST_USER_DID',
] as const;
const missing = REQUIRED_ENV.filter((k) => !process.env[k]);
if (missing.length > 0) {
  throw new Error(
    `meta-tools.int.test.ts requires the following env vars (see packages/oracle-runtime/.env.integration): ${missing.join(', ')}`,
  );
}

describe('Phase 1 — meta-tools (Tier A direct invoke)', () => {
  // 1.12 — list_capabilities returns a row per registered plugin with the
  // right visibility + loaded flag. Memory is `'always'` (loaded=true),
  // Firecrawl is `'on-demand'` (loaded=false until load_capability runs),
  // Credits is `'silent'` (excluded from the listing by default).
  test('1.12 list_capabilities returns visibility-correct rows', async () => {
    const rt = await createIntegrationRuntime({
      plugins: [new MemoryPlugin(), new FirecrawlPlugin(), new CreditsPlugin()],
      user: { did: process.env.TEST_USER_DID ?? 'did:ixo:integration-test-user' },
      // Empty loadedPlugins so on-demand plugins show `loaded: false`
      // (mirrors production behavior on a fresh conversation thread).
      state: { loadedPlugins: new Set<string>() },
    });
    try {
      const result = (await rt.invokeTool('list_capabilities', {})) as string;
      const rows = JSON.parse(result) as Array<{
        name: string;
        visibility: 'always' | 'on-demand' | 'silent';
        loaded: boolean;
      }>;

      const memoryRow = rows.find((r) => r.name === 'memory');
      const firecrawlRow = rows.find((r) => r.name === 'firecrawl');
      const creditsRow = rows.find((r) => r.name === 'credits');

      expect(memoryRow, 'memory should be listed').toBeDefined();
      expect(memoryRow!.visibility).toBe('always');
      expect(memoryRow!.loaded).toBe(true);

      expect(firecrawlRow, 'firecrawl should be listed').toBeDefined();
      expect(firecrawlRow!.visibility).toBe('on-demand');
      expect(firecrawlRow!.loaded).toBe(false);

      // Credits is silent — meta-tool filters it out by default.
      expect(creditsRow, 'silent plugins not in default listing').toBeUndefined();
    } finally {
      await rt.close();
    }
  });

  // 1.13 — load_capability for an on-demand plugin returns the manifest +
  // tool list and is repeatable (returns alreadyAvailable=true on rerun).
  test('1.13 load_capability binds an on-demand plugin', async () => {
    const rt = await createIntegrationRuntime({
      plugins: [new FirecrawlPlugin()],
      user: { did: process.env.TEST_USER_DID ?? 'did:ixo:integration-test-user' },
    });
    try {
      const result1 = (await rt.invokeTool('load_capability', {
        name: 'firecrawl',
      })) as { alreadyAvailable?: boolean; tools?: Array<{ name: string }> } | string;

      // load_capability may return a LangGraph Command on first load — its
      // `update` channel carries the LoadCapabilityResult. The string return
      // path comes from when alreadyAvailable is true. Either way, we get
      // the underlying result here.
      const payload =
        typeof result1 === 'string' ? (JSON.parse(result1) as Record<string, unknown>) : result1;
      expect(payload).toBeDefined();

      // Second call must report alreadyAvailable=true now that firecrawl is loaded.
      const result2 = (await rt.invokeTool('load_capability', {
        name: 'firecrawl',
      })) as { alreadyAvailable?: boolean } | string;
      const payload2 =
        typeof result2 === 'string' ? (JSON.parse(result2) as Record<string, unknown>) : result2;
      expect((payload2 as { alreadyAvailable?: boolean }).alreadyAvailable).toBe(true);
    } finally {
      await rt.close();
    }
  });

  // 1.14 — load_capability for a name that doesn't exist throws a clean,
  // discoverable error. The runtime points the agent at list_capabilities.
  test('1.14 load_capability for unknown plugin throws naming the missing plugin', async () => {
    const rt = await createIntegrationRuntime({
      plugins: [new FirecrawlPlugin()],
      user: { did: process.env.TEST_USER_DID ?? 'did:ixo:integration-test-user' },
    });
    try {
      await expect(
        rt.invokeTool('load_capability', { name: 'does-not-exist' }),
      ).rejects.toThrow(/does-not-exist/);
    } finally {
      await rt.close();
    }
  });

  // 1.15 — load_capability for a silent plugin throws cleanly. Credits is
  // visibility:'silent' — middleware-only, not agent-callable.
  test('1.15 load_capability for silent plugin throws cleanly', async () => {
    const rt = await createIntegrationRuntime({
      plugins: [new CreditsPlugin()],
      user: { did: process.env.TEST_USER_DID ?? 'did:ixo:integration-test-user' },
    });
    try {
      await expect(
        rt.invokeTool('load_capability', { name: 'credits' }),
      ).rejects.toThrow();
    } finally {
      await rt.close();
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────
// Item 1.16 — Agent-loop test ("What can you do?" → list_capabilities)
// ─────────────────────────────────────────────────────────────────────────
//
// Deferred for this phase: requires a full Matrix-loaded oracle boot, a
// minted UCAN delegation, AND a real model call. The Phase 2 weather test
// (`apps/qiforge-example/test/integration/weather.int.test.ts`) already
// exercises the same Tier B agent-loop infrastructure with on-demand
// plugin loading — the meta-tool flow is implicitly covered there. If we
// later want a dedicated Tier B meta-tools test, the harness from that
// file ports cleanly here. Keeping the file focused on the Tier A
// behaviors that have no dependency on Matrix init / OTK state.

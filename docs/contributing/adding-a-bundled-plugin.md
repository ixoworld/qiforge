# Adding a bundled plugin

A bundled plugin lives in `packages/oracle-runtime/src/plugins/<name>/` and is included in `BUNDLED_PLUGINS`. This is distinct from user-authored plugins, which forks add via `createOracleApp({ plugins: [...] })` — the public docs cover that case.

Reach for a bundled plugin when the capability belongs to every QiForge oracle by default (memory, skills, sandbox, ...) rather than to one specific deployment.

## Checklist

- [ ] Create the plugin directory.
- [ ] Implement the plugin class extending `OraclePlugin`.
- [ ] Write the manifest (carefully — see [manifest concept](../../docs/architecture/plugin-lifecycle.md#manifest)).
- [ ] Add `configSchema` if the plugin needs env vars.
- [ ] Add `autoDetect` if the plugin should opt in conditionally.
- [ ] Implement the hooks the plugin needs (`getTools`, `getSubAgents`, `getMiddlewares`, `getNestModules`, `getSharedState`, etc.).
- [ ] Export the class and a singleton instance from the plugin's `index.ts`.
- [ ] Register in `plugins/index.ts` — export the singleton and add it to `BUNDLED_PLUGINS`.
- [ ] Re-export the class from `packages/oracle-runtime/src/index.ts` so hosts can instantiate with constructor args.
- [ ] Write tests (`*.plugin.test.ts` for unit, `*.plugin.int.test.ts` for integration).
- [ ] Add a row to `ixo-docs/build-an-oracle/reference/plugin-catalog.mdx`.
- [ ] Update `ixo-docs/build-an-oracle/reference/environment-variables.mdx` if the plugin has env vars.

## Directory layout

Look at any of the existing 14 plugins for the canonical structure. The Sandbox plugin is a minimal example with config schema and tools; the Editor plugin is the most complex (sub-agent + many tools + Matrix CRDT integration).

```
plugins/<name>/
├── index.ts             # exports the class + singleton
├── <name>.plugin.ts     # OraclePlugin subclass
├── <name>-tools.ts      # tool builders (optional)
├── <name>-agent.ts      # sub-agent (optional)
├── <name>-middleware.ts # middleware (optional)
├── <name>.module.ts     # Nest module (optional)
├── <name>.plugin.test.ts
└── <name>.plugin.int.test.ts (if it talks to upstream services)
```

## Plugin class

```ts
import {
  OraclePlugin,
  type PluginContext,
  type PluginManifest,
  type PluginTool,
  type RuntimeContext,
  z,
} from '../../plugin-api/index.js';

const NAME = 'my-plugin';
const VERSION = '0.1.0';

const configSchema = z.object({
  MY_PLUGIN_API_URL: z.url(),
});

const manifest: PluginManifest = {
  title: 'My Plugin',
  summary: '...',
  whenToUse: ['...'],
  category: 'data',
  visibility: 'on-demand',
  stability: 'experimental',
};

export class MyPlugin extends OraclePlugin {
  readonly name = NAME;
  readonly version = VERSION;
  readonly manifest = manifest;

  override readonly configSchema = configSchema;

  override readonly autoDetectHint = 'MY_PLUGIN_API_URL';
  override autoDetect(env: NodeJS.ProcessEnv): boolean {
    return Boolean(env.MY_PLUGIN_API_URL);
  }

  override getTools(ctx: PluginContext): PluginTool[] {
    const cfg = configSchema.parse(ctx.config);
    return [
      /* tools */
    ];
  }
}
```

Conventions used by existing bundled plugins:

- `name` is kebab-case.
- `NAME` and `VERSION` are file-local constants — reuse them for log prefixes and tool name prefixes.
- `configSchema` is module-scoped (not a class property literal) so it can be `parse`d in multiple hooks without re-declaring.
- `manifest` is module-scoped.
- `autoDetectHint` is a string surfaced in boot logs when the plugin is excluded.

## Manifest

Treat manifest authoring as system prompting for the LLM. The Memory and Sandbox plugins are the gold standards — read their manifests in full before writing yours.

Key rules:

- `summary` is one sentence; appears in Tier-1 prompt for `always` plugins.
- `whenToUse` should be specific, not vague. "User asks about weather" — too vague. "User asks about current temperature, precipitation, or wind in any city" — better.
- `whenNotToUse` disambiguates from neighbouring plugins. Use it when your plugin's domain overlaps with another's (e.g. Firecrawl explicitly directs API requests to the Sandbox).
- `examples` must reference real tool names. Manifest validation fails boot otherwise.
- `visibility` defaults to `on-demand`. Promote to `always` only when the plugin is needed on most turns — every `always` plugin costs Tier-1 tokens on every turn.
- `category` and `tags` help `list_capabilities` output; tags must be lowercase.

## Hooks — what to implement

| Hook                    | Use when                                                                                      |
| ----------------------- | --------------------------------------------------------------------------------------------- |
| `getTools`              | Tools whose registration depends only on config + identity.                                   |
| `getRequestTools`       | Tools whose registration depends on live state (`state.browserTools`, etc.).                  |
| `getSubAgents`          | Multi-step workflows that benefit from focused prompt and tool set.                           |
| `getRequestSubAgents`   | Sub-agents only constructible per request (e.g. Portal needs `state.browserTools` non-empty). |
| `getMiddlewares`        | Per-turn observation, enrichment, or guardrails.                                              |
| `getNestModules`        | Long-lived services (sockets, BullMQ) or HTTP routes.                                         |
| `getAuthExcludedRoutes` | Paths from your Nest module that don't go through UCAN auth.                                  |
| `getSharedState`        | Exposing a value other plugins might read.                                                    |

Skip hooks you don't need. The class allows everything to be optional.

## Wiring in plugins/index.ts

```ts
// packages/oracle-runtime/src/plugins/index.ts
import { MyPlugin } from './my-plugin/index.js';

export const myPlugin = new MyPlugin();
// ... existing singletons ...

export const BUNDLED_PLUGINS = [
  // ... existing entries ...
  myPlugin,
] as const satisfies ReadonlyArray<OraclePlugin>;
```

And re-export the class:

```ts
// packages/oracle-runtime/src/index.ts
export { MyPlugin } from './plugins/my-plugin/index.js';
```

The plugin's `index.ts` should export both the singleton and the class:

```ts
// packages/oracle-runtime/src/plugins/my-plugin/index.ts
export { MyPlugin } from './my-plugin.plugin.js';
```

## Tests

At minimum, write a unit test using `createTestRuntime`:

```ts
import { describe, expect, it } from 'vitest';
import { createTestRuntime } from '../../testing/index.js';
import { MyPlugin } from './index.js';

describe('MyPlugin', () => {
  it('registers its tools at boot', async () => {
    const { runtime } = await createTestRuntime({
      plugins: [new MyPlugin()],
      config: { MY_PLUGIN_API_URL: 'https://example.com' },
    });
    expect(runtime.toolRegistry.toolNames()).toContain('my_tool');
  });
});
```

If the plugin talks to upstream services (MCPs, REST APIs), add an integration test that hits real endpoints, gated by `.env.integration` (see [testing/integration-tests.md](../testing/integration-tests.md)).

## Public docs update

After landing the plugin, add an entry to:

1. `ixo-docs/build-an-oracle/reference/plugin-catalog.mdx` — name, visibility, category, env vars, what it contributes, dependencies, notes.
2. `ixo-docs/build-an-oracle/reference/environment-variables.mdx` — per-plugin section listing each env var.

Don't duplicate the manifest content in the public docs — the catalog is a catalog, not a re-publication of the manifest.

## House rules

- **No `as any` / `as Type` to silence the compiler.** Find the actual mismatch.
- **No upstream MCP tool description overrides.** If a downstream tool's description is unhelpful, the fix goes in your manifest's `whenToUse` / `whenNotToUse` / `examples`, not in client-side description munging.
- **No module-level singletons** (e.g. `let activeService;`). Plugins must be construction-stateless or hold state on instance fields — see the Weather plugin's `lastBySession` Map.
- **Use `ctx.matrix` / `ctx.llm` / `ctx.ucan` / `ctx.config`.** Never reach for `MatrixManager.getInstance()` or `process.env` directly.

## Read next

- [Plugin lifecycle](../architecture/plugin-lifecycle.md) — when each hook fires.
- [Code conventions](code-conventions.md) — naming, env vars, types.
- [Testing test harness](../testing/test-harness.md) — `createTestRuntime` details.

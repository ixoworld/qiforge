# Test harness

`createTestRuntime` is the framework's unit-test harness. It resolves plugins through the production loader, populates the registries, builds a `RuntimeContext` populated with mock adapters, and returns everything you need to call plugin code in isolation.

Source: `packages/oracle-runtime/src/testing/create-test-runtime.ts`.

## Usage

```ts
import { describe, expect, it } from 'vitest';
import { createTestRuntime } from '@ixo/oracle-runtime/testing';
import { WeatherPlugin } from '../src/plugins/weather/index.js';

describe('WeatherPlugin', () => {
  it('registers get_current_weather', async () => {
    const { runtime } = await createTestRuntime({
      plugins: [new WeatherPlugin()],
      config: { WEATHER_DEFAULT_UNITS: 'celsius' },
    });
    expect(runtime.toolRegistry.toolNames()).toContain('get_current_weather');
  });

  it('returns a weather lookup', async () => {
    const { runtime, runtimeContext } = await createTestRuntime({
      plugins: [new WeatherPlugin()],
      mocks: {
        fetch: async (url) => new Response(JSON.stringify({ /* ... */ })),
      },
    });
    const tool = runtime.toolRegistry.toolByName('get_current_weather');
    const result = await tool!.handler({ city: 'Berlin' }, runtimeContext);
    expect(typeof result).toBe('string');
  });
});
```

## CreateTestRuntimeOptions

```ts
interface CreateTestRuntimeOptions {
  plugins: OraclePlugin[];                                       // required
  features?: Partial<Record<string, FeatureToggle>>;
  config?: Record<string, unknown>;                              // merged env vars
  user?: Partial<RuntimeContext['user']>;                        // override user fields
  session?: Partial<RuntimeContext['session']>;
  state?: Partial<ReadonlyState>;
  identity?: Partial<OracleIdentity>;
  logger?: Logger;                                               // defaults to vi.fn() no-op
  mocks?: {
    fetch?: FetchHandler;
    matrix?: MockMatrixOverrides;
    secrets?: Record<string, string>;
    llm?: { respondWith?: string | string[] };
  };
}
```

The harness defaults to the same opt-in / opt-out semantics as `createOracleApp` — feature toggles default to `'auto'`, plugin `autoDetect` is honoured, manifest validation runs.

## What you get back

```ts
interface TestRuntime {
  runtime: {
    toolRegistry: ToolRegistry;
    subAgentRegistry: SubAgentRegistry;
    middlewareRegistry: MiddlewareRegistry;
    manifestRegistry: ManifestRegistry;
    configSchemaRegistry: ConfigSchemaRegistry;
    sharedStateRegistry: SharedStateRegistry;
  };
  runtimeContext: RuntimeContext;
  pluginContext: PluginContext;
  ambient: AmbientServices;          // mock-backed
}
```

`runtime.toolRegistry.toolByName(name)` returns the wrapped tool — call its handler with the `runtimeContext` to test the handler in isolation.

## Mock adapters

The default mocks come from `testing/mocks.ts`:

| Adapter | Behaviour |
| --- | --- |
| `mockLogger` | `vi.fn()` for every level. No output. Calls are inspectable. |
| `mockLlm` | Returns `'mock-response'` by default. Override via `mocks.llm.respondWith`. |
| `mockMatrix` | All Matrix methods return empty/fixture data. Override per-method via `mocks.matrix`. |
| `mockSecrets` | Returns a fixed `Record<string, string>` from `mocks.secrets`. Empty by default. |
| `mockUcan` | `requireCapability` no-ops, `hasCapability` returns `true`, `mintInvocation` returns a stub. |
| `mockEmit` | Records every event call for assertions. |
| `fetch` | Defaults to throwing "fetch not stubbed". Pass `mocks.fetch` to handle requests. |

`MockMatrixOverrides` and `FetchHandler` are exported from `testing/mocks.ts` if you need explicit types.

## When createTestRuntime is the wrong tool

- **You need the real Nest DI graph.** Plugins that interact with `MessagesController`, `SessionsService`, or other Nest-managed bits don't get those via `createTestRuntime`. Use an integration test instead.
- **You're testing the loader/composer/registries themselves.** They have direct unit tests under `bootstrap/` and `registries/` — don't go through the harness.
- **You need real upstream behaviour.** If your test's value depends on real LLM/Matrix/MCP behaviour, use an integration test.

## Conventions

- One test file per plugin: `<plugin>.plugin.test.ts`. Use `createTestRuntime` for setup.
- Mock at the boundary (fetch, secrets, matrix). Don't mock plugin internals.
- Assert against the registry shape (`toolNames()`, `toolByName(name)`) rather than spying on plugin methods.
- Don't write tests against `createTestRuntime`'s implementation details — assume the API.

## Read next

- [Integration tests](integration-tests.md) — when to go past Layer 1.
- [Overview](overview.md) — the three layers and what each one covers.

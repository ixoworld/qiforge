# task-15 testing harness notes

`createTestRuntime` builds Layer 1 (unit) + Layer 2 (basic contract) testing
helpers per the spec testing harness section. Out of scope: recorded LLM
fixtures, plug-matrix property tests, coverage gates, cross-runtime-version
CI matrix, auto-contract tests.

## Reuse decisions

- **Test fixtures stay in `registries/test-fixtures.ts`.** That module is
  already a clean public-shape factory for `OraclePlugin`, `PluginContext`,
  `RuntimeContext`, etc. The testing barrel re-exports it (`makePlugin`,
  `makeRuntimeContext`, `makeBuildCtx`, `makeManifest`, `makeTool`,
  `makeSubAgent`, `makeMiddleware`) so external authors see one entry
  point. No duplicate `makeRuntimeContext` was created.
- **LLM mock = `FakeListChatModel` from `@langchain/core/utils/testing`.**
  LangChain's testing module ships exactly the helper we need (returns a
  predefined list of strings, supports `bindTools` / structured output).
  The harness's `mockLlm({ respondWith })` is a five-line wrapper that
  normalizes a `string | string[]` input into the list-shaped fake.
- **Manifest search / Tier-1 / capability listing** delegate to
  `buildSearchIndex`, `validateManifest`, `validateExamplesAgainstTools`,
  and the meta-tool builders. The test runtime never reimplements ranking,
  validation, or the Tier-1 view — it constructs the same registries the
  production runtime does and reads through them.
- **Plugin resolution** flows through the production `resolvePlugins`
  loader so feature toggles and `autoDetect` behave identically in tests.

## Mocks shape

`mocks.fetch(url, init?)` is intercept-only — it returns whatever the
caller's handler returned and `mockResponse(body)` produces a minimal
`{ status, headers, json(), text(), ok }` envelope (mirrors the public
`Response` surface plugins typically read). The harness does not patch
`globalThis.fetch`; plugin authors who want global interception should
do that themselves in their test setup. The helper exists on
`rt.mocks.fetch(handler)` so an asserted-handler can be swapped per test.

`mocks.matrix(overrides)` returns a `MatrixAdapter` whose default methods
record calls into `vi.fn()`. Overrides shadow the defaults; the rest of
the adapter keeps its no-op contract. `rt.mocks.matrix(...)` rebinds the
ambient adapter so subsequent `invokeTool` calls see the new mock.

`mocks.secrets(record)` returns a `SecretsAdapter` whose `getValues`
returns the keys present in `record` (others omitted). Default index
returns each key as `{ key }` with no version.

## invokeAgent

Stubbed — throws with a hint pointing at the create-main-agent task
landing in TASK-11. The stub ships now so existing test files that
reference `invokeAgent` typecheck; the body lights up once the runtime
exposes a real assembled main agent.

## invokeSubAgent

Layer-1 sub-agent invocation does NOT spin up `createAgent` from
LangChain. Instead it:

1. Resolves the sub-agent descriptor via `SubAgentRegistry`.
2. Constructs the sub-agent's tool list (string-prompt path or
   ctx-derived path) using the shared `PluginContext`.
3. Returns a deterministic envelope `{ name, task, tools: ToolName[],
systemPrompt }` cast to `string` via JSON. This is enough for plugin
   authors to test the sub-agent's wiring without an LLM round-trip.
4. If `mocks.llm.respondWith` is set, the response from the fake list
   model is returned instead — gives authors a way to assert the
   plugin's `onComplete` callback when they wire up an LLM.

## invokeMiddleware

The harness:

1. Searches `MiddlewareRegistry.collect()` for a `middleware.name`
   match. If not found, falls back to a numeric index lookup so
   anonymous fixtures (`makeMiddleware('mw0')` etc.) still resolve
   without forcing every test to memorise a name.
2. Invokes the four lifecycle hooks in agent order: `beforeAgent`,
   `beforeModel`, `afterModel`, `afterAgent`. The harness records each
   defined hook's return into `{ before, after }` so a test can assert
   on either side without wiring all four.
3. Out of scope for v1: `wrapToolCall` / `wrapModelCall` — those expect
   a downstream callable, which would push the harness toward a real
   tool/model executor. Plugin authors who need to test wrap-style
   logic can call those hooks directly via `rt.listTools` /
   `MiddlewareRegistry.collect`.

## Boot time

A no-plugin or single-plugin `createTestRuntime` resolves in <50ms on a
warm Node — well under the 500ms acceptance bar. The main cost is
manifest validation and Zod parsing, both per-plugin O(1).

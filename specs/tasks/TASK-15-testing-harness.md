# TASK-15: `createTestRuntime` + mocks

**Phase:** 4 — Testing harness
**Spec:** §20
**Effort:** 3 days
**Depends on:** TASK-11
**Blocks:** TASK-16…TASK-31

## Goal

Build `createTestRuntime` so plugin authors (and the bundled plugin conversion tasks) can write unit tests without booting the full app. Lightweight per §20.3 — no LLM fixtures, no plug-matrix property tests.
Check https://docs.langchain.com/oss/javascript/langchain/test and review how they do testing adn what can we befiint from it 
## Deliverables

### Created

- `packages/oracle-runtime/src/testing/create-test-runtime.ts` — `createTestRuntime(opts)` returning `TestRuntime` per §20.2. Builds:
  - A minimal NestJS test container with mocks for ambient services (no real Matrix, no real Redis, no real LLM).
  - Synthesized `PluginContext` and `RuntimeContext` from the test config.
  - A registries snapshot from the provided plugin list.
  - Stub user/session/secrets per the test options.
- `packages/oracle-runtime/src/testing/mocks.ts`:
  - `mockResponse(body, init?)` for fetch.
  - `mockMatrix(overrides)` returning a fake `MatrixManager`-like object with the methods `RuntimeContext.matrix.*` calls.
  - `mockLlm({ respondWith })` — deterministic stub.
  - `mockSecrets(record)` — returns `Record<string, string>` to `getValues`.

### Helpers exposed on `TestRuntime`

Per §20.2: `invokeTool`, `invokeMiddleware`, `invokeSubAgent`, `listTools`, `getManifest`, `listCapabilities`, `findCapability`, `loadCapability`, `assertNoCollisions`, `assertManifestValid`, `mocks.{matrix,fetch}`, `close`.

### Modified

- `packages/oracle-runtime/package.json` — verify `./testing` subpath export resolves.

## Acceptance

- [ ] `await createTestRuntime({ plugins: [new ClimatePlugin()], config: { CLIMATE_API_KEY: 'fake' } })` returns without error.
- [ ] `rt.invokeTool('get_emissions', { facilityId, period })` calls the plugin's tool handler with a synthesized `RuntimeContext`.
- [ ] `rt.invokeMiddleware('myMiddleware', state, runtime)` runs the middleware in isolation.
- [ ] `rt.findCapability('emissions')` returns ranked matches.
- [ ] `rt.loadCapability('climate')` adds `'climate'` to the test runtime's loadedPlugins.
- [ ] `rt.assertNoCollisions()` throws if two test plugins both claim the tool name `foo`.
- [ ] `rt.close()` releases test resources cleanly.
- [ ] Boots in under 500ms for a no-plugin or single-plugin test.

## Out of scope

Per §20.3:
- Recorded LLM fixtures
- Plug-matrix property tests
- Coverage gates
- Cross-runtime-version CI matrix
- Auto-contract tests

These are deferred. Plugin authors can write good unit tests with what's here.

## Notes

- §20.1 lists the six layers; only Layer 1 (unit) and Layer 2 (basic contract: `assertNoCollisions`, `assertManifestValid`) are in scope for v1.
- `createTestRuntime` should NOT start a real Matrix client, real Redis, or real LLM. Pure mocks.
- The `invokeAgent` helper from §20.2's table is OPTIONAL for v1 — it requires LLM mocking which we're deferring. If trivial to implement with a stub, include; otherwise defer.

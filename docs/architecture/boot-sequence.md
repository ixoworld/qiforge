# Boot sequence

`createOracleApp(opts)` in `packages/oracle-runtime/src/bootstrap/create-oracle-app.ts` runs every step below in order. Each step is gated on the previous one — failures abort boot and propagate via the bootstrap logger with `[boot-error]` prefix.

Read this file alongside the source — line numbers in this doc may drift; the source is authoritative.

## Phase-by-phase

### 1. Config validation

`validateConfig(opts.config)` — `config` and `config.name` are required. Throws synchronously.

### 2. Plugin resolution

`resolvePlugins({ bundled, userPlugins, features, env, logger })` in `bootstrap/plugin-loader.ts`:

1. Start with `bundled` (defaults to `BUNDLED_PLUGINS` — 14 instances exported from `plugins/index.ts`).
2. Concatenate `userPlugins` (the host's `plugins` array). Dedupe by `name` — user instances override bundled defaults of the same name.
3. For each plugin without an explicit `features[name]` entry, call `plugin.autoDetect?.(env)` to decide. Plugins without `autoDetect` are on-by-default. `features[name] === true` forces on; `false` forces off; `'auto'` (or missing) runs `autoDetect`.
4. Returns `{ loaded, excluded, softDepGaps }`.

### 3. Topological sort

Order plugins by `dependsOn`. Cycles or missing hard deps surface as resolver errors. Same call returns the sorted list. Order matters for:

- Middleware fire order (`beforeModel` from earlier-registered plugins fires first).
- Tool emission order (deterministic prompts → better LLM caching).

### 4. Manifest validation

For each loaded plugin, `validateManifest(plugin.manifest, plugin.name)` in `manifest/validator.ts`:

- Hard: `summary` non-empty; `whenToUse` ≥ 1 entry when `visibility !== 'silent'`; every `example.tool` references a registered tool.
- Soft: `summary` ≤ 120 chars; `whenToUse` entries ≤ 100 chars and ≤ 8 entries; `tags` all lowercase.

Hard violations are collected; if non-empty, boot throws `Plugin manifest validation failed (N issues)`.

### 5. Schema merge + env validation

`composeEnvSchema(loaded, baseEnvSchema, logger)` extends the base Tier-0 schema (`config/base-env-schema.ts`) with every loaded plugin's `configSchema`. Collisions log a warning; later-defined wins.

`validateEnv(schema, env, pluginOwnership)` runs the merged schema against `process.env`. Failures collect into typed errors (`{ plugin, field, message }`) so the boot reporter can name the offending plugin and offer the disable hint.

### 6. LLM provider cross-check

`validateLlmProviderKey(validated.config)` — Zod can't express "the API key for the selected provider is required". This step does it: when `LLM_PROVIDER='openrouter'`, `OPEN_ROUTER_API_KEY` must be present; when `'nebius'`, `NEBIUS_API_KEY` must be present.

### 7. Build OracleIdentity

`identity = { name, org, description, entityDid, prompt }` — built from `opts.config` plus the validated `ORACLE_ENTITY_DID` env. A missing/empty `ORACLE_ENTITY_DID` after validation throws explicitly.

### 8. Registry population

Six registries are constructed and populated:

```ts
const registries = {
  tools: new ToolRegistry(),
  subAgents: new SubAgentRegistry(),
  middlewares: new MiddlewareRegistry(),
  manifests: new ManifestRegistry(),
  configSchema: new ConfigSchemaRegistry(),
  sharedState: new SharedStateRegistry(),
};
for (const plugin of resolved.loaded) {
  registries.tools.register(plugin);
  // ... etc
}
```

Each registry runs its own collision checks. See `registries/*.ts`.

### 9. Plugin Nest modules

```ts
const pluginNestModules = resolved.loaded.flatMap((p) => {
  const ctx = buildPluginContext({ config, identity, availablePlugins, logger, pluginName: p.name });
  return p.getNestModules?.(ctx) ?? [];
});
```

Each plugin's `getNestModules(ctx)` is called with a freshly built `PluginContext`. The result flattens into a single array passed into the dynamic module.

### 10. Auth exclusions

Plugin-declared and host-declared exclusions merge:

```ts
const pluginAuthExclusions = [
  ...resolved.loaded.flatMap((p) => p.getAuthExcludedRoutes?.() ?? []),
  ...(opts.authExcludedRoutes ?? []),
];
```

Passed into the `RuntimeAppModule` configurer, which wires `MiddlewareConsumer.exclude(...)` for `AuthHeaderMiddleware`.

### 11. Build RuntimeAppModule

`RuntimeAppModule.register({ validatedEnv, userNestModules, pluginNestModules, pluginAuthExclusions, enableSubscriptionMiddleware })`. The `enableSubscriptionMiddleware` boolean is `true` when the `credits` plugin is loaded — the credits plugin's presence flips Tier-0 `SubscriptionMiddleware` on.

### 12. File processing provider

`setFileProcessingProvider(...)` wires the LLM provider getter that `FileProcessingService` lazily reads on first call. Must run before `NestFactory.create` constructs `FileProcessingService` — module-level constraint.

### 13. NestFactory.create

```ts
const nestApp = await NestFactory.create(appModule, { bufferLogs: false });
```

CORS enabled (configurable origin, fixed allowed headers/methods). Swagger UI mounts at `/docs`. Both guarded with `typeof X === 'function'` so test runtimes that stub `NestFactory.create` don't blow up.

### 14. AmbientServices

`buildAmbientServices({ nestApp, config, identity, availablePlugins, logger })` resolves every Tier-0 service via `nestApp.get(...)` and packs them into an `AmbientServices` bag that `MessagesController` reads on every request to build a `RuntimeContext`.

### 15. Warm boot caches

```ts
await registries.tools.collectBoot(warmBuildCtx);
registries.subAgents.collectBoot(warmBuildCtx);
registries.middlewares.collect(warmBuildCtx);
```

Each registry calls every plugin's boot-time hook (`getTools`, `getSubAgents`, `getMiddlewares`) once and caches the result. Per-request agent builds reuse the cache; only `getRequestTools` / `getRequestSubAgents` re-run per turn.

### 16. Merge MainAgentHooks

```ts
const defaultHooks: MainAgentHooks = checkpointSync
  ? { checkpointerForUser: async (userDid) => SqliteSaver.fromDatabase(await checkpointSync.getUserDatabase(userDid)) }
  : {};
const mergedHooks: MainAgentHooks = { ...defaultHooks, ...opts.hooks };
```

The default checkpointer is per-user SQLite backed by `UserMatrixSqliteSyncService`. Host can override via `opts.hooks.checkpointerForUser`.

### 17. Populate OracleRuntimeBundleHolder

The Holder pattern: Nest constructs the holder empty in step 13; `createOracleApp` populates it here; `MessagesService` reads from it per request via DI. This breaks the chicken-and-egg between Nest's DI lifecycle and ambient services (which need the Nest container to exist before they can resolve UCAN/Matrix/etc.).

See `modules/messages/oracle-runtime-bundle.ts`.

### 18. Schedule Matrix init (background)

Unless `skipMatrixInit: true`:

- Defer to next macrotask (`setImmediate`) so host code has a chance to attach `onPluginStatusChange` / `onError` handlers before the first dispatch.
- Dispatch `{ plugin: 'matrix', from: 'pending', to: 'pending' }`.
- Call `matrixManager.init()`. On success: call `wireSigningAndEncryptionKeys` (loads UCAN signing mnemonic + P-256 encryption key from the oracle's Matrix account room), dispatch `{ from: 'pending', to: 'loaded' }`. On failure: dispatch `{ from: 'pending', to: 'failed', reason }` plus `onError(err, 'matrix-init')`.

Unless `skipGracefulShutdown: true`: register a SIGTERM/SIGINT handler that closes the Nest app and disconnects Matrix cleanly.

### 19. Return OracleApp

The returned object exposes `getNestApp`, `ambient`, `plugins.status`, `beforeListen`, `onError`, `onPluginStatusChange`, `listen`. `listen` calls every registered `beforeListen` then `nestApp.listen(port, '0.0.0.0')`. `listen` can be called only once (tracked via `started: boolean`).

## What can fail boot

The bootstrap logger reports `[boot-error]` for each issue. Aborts when:

- Plugin resolver throws (cycle / missing hard dep).
- Manifest validation collects errors.
- Env validation collects errors.
- LLM provider cross-check fails.
- `ORACLE_ENTITY_DID` is empty after validation.

What does NOT fail boot:

- Matrix init failures (background; dispatched via `onError` and `onPluginStatusChange`).
- Key setup failures inside `wireSigningAndEncryptionKeys` (warns; auth-requiring routes will 401 until provisioned).
- Soft-dep gaps (logged but not fatal).

## Read next

- [Plugin lifecycle](plugin-lifecycle.md) — what registries call when.
- [Modules](modules.md) — the always-on Nest modules constructed in step 11–14.
- [Matrix and checkpointer](matrix-and-checkpointer.md) — step 18 in detail.

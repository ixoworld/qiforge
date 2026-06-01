# Code conventions

Patterns enforced via code review on this project. Stick to them — exceptions need justification in the PR.

## Types

- **No `as any` / `as unknown as X` casts to silence the compiler.** Find the actual type mismatch and fix it. Casts often hide real bugs and survive refactors. The only exception is the documented cross-package type-identity workaround for `SqliteSaver` → `BaseCheckpointSaver` in `bootstrap/create-oracle-app.ts` — and that one has a comment explaining why.
- **Prefer Zod over `as Type`.** If you have an `unknown` and want a typed value, parse it through a schema. Boot env, plugin config, every `ctx.config` access — all go through `configSchema.parse(...)`.
- **Open interfaces with declaration merging.** `SharedAccessors`, `ReadonlyState` are open; plugins extend them via declaration merging in their own files.
- **`readonly` everywhere it makes sense.** Plugin fields, manifest objects, ReadonlySet, ReadonlyArray. Mutation is the unusual case.

## Imports

- **`.js` extensions in TypeScript source.** Required by NodeNext module resolution. `import { foo } from './bar.js'` — even when the file is `.ts`.
- **Type-only imports.** `import type { X } from 'y'` for things only used in types. Helps tree-shaking and clarifies intent.
- **No deep imports across package boundaries.** Inside `@ixo/oracle-runtime` use relative paths. From the outside, import from the package root only.

## Env vars

- **Per-plugin prefix in SHOUT_SNAKE_CASE.** `WEATHER_DEFAULT_UNITS`, `MEMORY_MCP_URL`, `SLACK_BOT_OAUTH_TOKEN`. Never bare names.
- **Tier-0 vars are owned by `config/base-env-schema.ts`.** Don't add to it from a plugin — declare a sibling schema if you need to read core vars without owning them.
- **Required vs optional matters.** A field that's optional in the schema but required in practice is a footgun. If your plugin truly cannot run without the var, mark it required (no `.optional()`, no `.default()`).

## Logging

- **Use `ctx.logger` / `rtCtx.logger`, never `console.log`.** Loggers are plugin-scoped (auto-prefixed with the plugin name) and pluggable.
- **Structured fields, not concatenated strings.** `ctx.logger.log('skill loaded', { skillId, version })` beats `ctx.logger.log(`Loaded skill ${skillId} v${version}`)`. Better for log aggregators.
- **`debug` and `verbose` are optional** on the `Logger` interface — guard before using: `if (ctx.logger.debug) ctx.logger.debug(...)`.

## Errors

- **Throw descriptive errors.** `throw new Error('memory: MEMORY_MCP_URL is required')` is good. `throw new Error('config error')` is bad.
- **Include the plugin name in messages from plugin code.** Boot errors do this automatically; ad-hoc errors should too.
- **Don't swallow errors silently.** If you can recover, log first. If you can't, throw.

## Tests

- **Vitest, not Jest.** The project standardised on Vitest. New tests use Vitest's `describe`/`it`/`expect`/`vi`.
- **`createTestRuntime` for unit tests of plugins.** Don't roll your own runtime context — the harness exists for this.
- **Integration tests load `.env.integration` and throw on missing env at file load.** No `describe.skipIf(...)` for env gates. Silent skips hide broken setups.
- **No `skipMatrixInit` / `skipGracefulShutdown` in integration tests as a speed-up.** Integration tests must boot the same way production does.
- **Don't widen test assertions to mask a flake.** If a test fails, investigate. Adding `or X or Y` to a regex throws away the assertion's value.
- **Don't edit plugin code to make tests pass.** Max two test-side retry attempts per failure; then stop and ask. Plugin source is presumed-working production code.

## Plugin authoring

- **Never override upstream MCP tool descriptions.** Pass through verbatim. Missing guidance goes in the manifest's `whenToUse` / `whenNotToUse` / `examples` — never in client-side description munging.
- **No module-level singletons** in plugin code (`let activeStore;`). Either construction-stateless or hold state on instance fields.
- **Don't reach for ambient singletons.** No `MatrixManager.getInstance()`, no `process.env.X` reads. Use `ctx.matrix` / `ctx.config`.
- **Manifest `whenToUse` should be specific, not vague.** "Weather questions" → too vague. "User asks about current temperature, precipitation, or wind in any city" → specific.

## Comments

- **No task/spec metadata in source.** Don't write `TASK-XX`, `§N.Y`, or "lands in TASK-XX" in source files. Comments are for runtime/architecture, not project tracking.
- **Default to no comments.** Only add one when the WHY is non-obvious. Don't explain WHAT well-named code already says.
- **No multi-paragraph docstrings** on functions. One short line max. The function name and types should do most of the work.

## Boot-time vs request-time

- **Pick the right hook.** If your tool's _registration_ depends only on config, use `getTools`. If it depends on live state, use `getRequestTools`. Don't put cheap-but-stable work in `getRequestTools` — that's a recomputation cost per turn.
- **Tool handlers always see `RuntimeContext`.** Even when the tool was registered via boot-time `getTools`. The boot/runtime split is about _registration_, not _execution_.

## Auto memory rules

These are encoded in `CLAUDE.md` and the persistent memory layer. They apply to every contribution:

- Active codebase = `packages/oracle-runtime` + `apps/qiforge-example`. Legacy `apps/app` is gone — don't reference it in new code or comments.
- No `as any` to silence the compiler.
- No skip-real-services flags in integration tests.
- No upstream MCP tool description overrides.
- Manifest manifestos: `whenToUse` requires specific triggers; `whenNotToUse` disambiguates.

## Read next

- [Adding a bundled plugin](adding-a-bundled-plugin.md) — applies all of the above.
- [Testing](../testing/overview.md) — the test layers and patterns.

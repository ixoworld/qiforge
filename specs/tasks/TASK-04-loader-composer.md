# TASK-04: Plugin loader + schema composer

**Phase:** 1 — Foundation
**Spec:** §10.5, §12, §14, §22.4
**Effort:** 3 days
**Depends on:** TASK-03
**Blocks:** TASK-11

## Goal

Build the boot-time plugin loader: resolve `features` toggles + bundled list + user plugins, topo-sort by `dependsOn`, log soft-dep gaps, merge `configSchema`s into a single Zod object, validate `process.env` against the merged schema, and emit clear errors per §14.2.

## Deliverables

### Created

- `packages/oracle-runtime/src/bootstrap/plugin-loader.ts`:
  - `resolvePlugins({ features, bundled, userPlugins })` returns the final plugin list, applying auto-detect rules per §11.2.
  - `topoSort(plugins)` returns ordered list. Errors on cycles or unmet hard deps with `boot.plugin.dep_missing` event.
  - Cascades hard deps: disabling `credits` auto-disables `claim-processing` per §11.2.
- `packages/oracle-runtime/src/bootstrap/schema-composer.ts`:
  - `composeEnvSchema(plugins, baseSchema)` merges plugin `configSchema`s into a single Zod object.
  - `validateEnv(mergedSchema, processEnv)` parses; on error, emits a structured boot error naming the plugin owning each missing var.
- `packages/oracle-runtime/src/bootstrap/inspect.ts` — basic `inspect()` returning JSON per §14.3 (plugin list, status, tier-1 prompt placeholder until TASK-07/08, soft-dep resolution, collisions). Pretty printer can be added in TASK-33.
- Unit tests: feature auto-detect, topo cycle detection, hard-dep cascade, env merge, env validation error message format.

## Acceptance

- [ ] `resolvePlugins({ features: { slack: false }, bundled: [...] })` excludes `slackPlugin`.
- [ ] `resolvePlugins({ features: { slack: true } })` with no `SLACK_BOT_OAUTH_TOKEN` env throws boot error per §11.2.
- [ ] `resolvePlugins({ features: { credits: false } })` cascades — `claim-processing` is removed from the final list, with one log line.
- [ ] `topoSort` errors on cycles with both plugin names in the message.
- [ ] `composeEnvSchema` correctly merges two plugins' Zod schemas.
- [ ] `validateEnv` with a missing `MEMORY_MCP_URL` returns an error naming `memoryPlugin`.
- [ ] `inspect()` returns a JSON object with `runtime.version`, `plugins[]`, `topo[]`, `collisions[]`, `warnings[]`.

## Out of scope

- The `qiforge inspect` CLI (TASK-33).
- Health checks and status polling (out of scope per spec — removed in v3).
- The `createOracleApp` factory itself (TASK-11).
- Runtime context building (TASK-05).

## Notes

- §14.1 has the boot phase order. Follow it strictly.
- Boot errors should also emit a single JSON line to stderr per §14.2 if `LOG_FORMAT=json`. Pretty stderr otherwise.
- Hard cascade convention: a plugin disabled because its `dependsOn` wasn't loaded is logged once with `event: boot.plugin.cascaded_off`.

# TASK-33: CLI updates (`qiforge plugin new`, `env`, `inspect`)

**Phase:** 6 — Final integration
**Spec:** §14.3, §22.15
**Effort:** 3 days
**Depends on:** TASK-32
**Blocks:** TASK-34

## Goal

Update the `qiforge-cli` (separate repo) with three new subcommands: `qiforge plugin new <name>` for scaffolding, `qiforge env` for env-var listing, and `qiforge inspect` for resolved-registry inspection.

## Deliverables

In the `qiforge-cli` repo:

- `qiforge plugin new <name>` — scaffolds:
  - `src/plugins/<name>.plugin.ts` — class skeleton with manifest stub + 1 sample tool, per §20.4.
  - `src/plugins/<name>.plugin.test.ts` — 3 tests using `createTestRuntime`: boot, sample tool happy path, manifest snapshot.
  - `src/plugins/<name>.fixtures/.gitkeep` — placeholder.
  - `src/plugins/README-<name>.md` — mirrors the manifest as docs.
- `qiforge env` — runs the runtime's env compositor, prints all currently-installed plugins' env vars as a `.env` template:
  ```
  # Tier-0 (always required)
  NODE_ENV=
  PORT=3000
  ORACLE_NAME=
  ...

  # tasksPlugin
  REDIS_URL=

  # memoryPlugin
  MEMORY_MCP_URL=
  MEMORY_ENGINE_URL=
  ```
- `qiforge inspect` — runs the runtime's `inspect()` from TASK-04, prints in the format §14.3 shows. Variants: `--tier1`, `--plugin <name>`, `--json`.
- (Update existing `qiforge new` (scaffolds a new oracle fork) to use the new starter shape from §18.)

## Acceptance

- [ ] `qiforge plugin new climate` produces a working class-based plugin in the current repo's `apps/app/src/plugins/climate.plugin.ts` with passing test.
- [ ] `qiforge env` correctly identifies installed plugins (by inspecting the running fork's `package.json` + the import graph) and prints the merged env template.
- [ ] `qiforge inspect` boots the app in inspect-only mode (no HTTP listen), runs the resolver, prints the output.
- [ ] `qiforge inspect --json` emits machine-readable JSON.
- [ ] CLI changes versioned and published.

## Out of scope

- Codemod tooling (`qiforge migrate`) — deferred to a follow-up versioning ticket per §23 open decisions.
- Embeddings-based search debugging — TF-IDF only per §23.1.
- IDE plugins / VSCode extensions.

## Notes

- The CLI is a separate repo (`qiforge-cli`). This task PR-lands changes there, NOT in this monorepo.
- The CLI's import of the runtime to call `inspect()` requires the runtime's CLI-friendly entry point. If running `qiforge inspect` requires booting NestJS (which is heavy), provide a leaner inspect mode that skips Nest DI but still resolves plugins/registries.
- `qiforge new` (scaffolds a fork) updates: replaces the old apps/app structure with the §18 starter shape.

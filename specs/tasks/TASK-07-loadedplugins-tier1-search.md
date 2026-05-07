# TASK-07: `loadedPlugins` state field + Tier-1 renderer + TF-IDF search

**Phase:** 2 — Discovery & Composition
**Spec:** §9, §10, §11
**Effort:** 2 days
**Depends on:** TASK-02, TASK-03
**Blocks:** TASK-08, TASK-10

## Goal

Three pieces that together power dynamic plugin discovery: (1) the new `loadedPlugins` state field — the only addition to today's `state.ts`; (2) the Tier-1 prompt renderer that turns manifests into the always-on capability block; (3) the TF-IDF index that powers `find_capability`.

## Deliverables

### Modified

- `apps/app/src/graph/state.ts` — add ONE field, no renames:
  ```ts
  loadedPlugins: Annotation<string[]>({
    reducer: (current, update) =>
      Array.from(new Set([...(current ?? []), ...(update ?? [])])),
    default: () => [],
  }),
  ```

### Created

- `packages/oracle-runtime/src/manifest/tier1-renderer.ts`:
  - `renderTier1(manifests, healthSnapshot)` returns a string.
  - Includes only plugins with `visibility: 'always'` (and degraded `'on-demand'` plugins per §6.1 wording — but with health checks gone in v3, just `'always'`).
  - Alphabetical order by plugin name.
  - Format: `- {name}: {summary}` — exactly as §6.1 / §9.1 show.
  - Tracks token count; if total > 1500, log a warning and demote lowest-invoked plugins to `'on-demand'` per §9.4 / §6.4. Invocation tracking stub for now.
- `packages/oracle-runtime/src/manifest/search.ts`:
  - `buildSearchIndex(manifests)` — TF-IDF over `whenToUse + tags + summary` for each plugin (visibility `'always'` or `'on-demand'`; silent excluded).
  - `searchCapability(index, query, limit=5)` returns ranked `{ name, score, summary, matchReason }[]`.
  - Stop-word filter, basic tokenizer.
- Unit tests: render Tier-1 from 3 fake manifests in correct order; TF-IDF retrieves expected plugin for a known query.

## Acceptance

- [ ] `state.loadedPlugins` exists with the right reducer (set-union) and default `[]`.
- [ ] No other field in `state.ts` is renamed or removed.
- [ ] `renderTier1([memoryManifest, tasksManifest, slackManifest], {})` with slack `'on-demand'` returns a block listing only `memory` and `tasks`, alphabetical, format `- name: summary`.
- [ ] Token-budget warning fires when manifests exceed 1500 tokens.
- [ ] `searchCapability(index, 'send to slack')` ranks `slackPlugin` first.
- [ ] Silent plugins are excluded from the search index.

## Out of scope

- The four meta-tools (TASK-08).
- Embeddings as an alternative ranker (open decision §23.1, deferred).
- Invocation-count persistence (stub for now; track in-memory only).

## Notes

- TF-IDF library: simple in-process implementation is fine. No external dep.
- The `loadedPlugins` reducer must be a set-union (deduplicate) per §11. Loaded plugins persist across turns within a thread; they reset when the thread changes (the checkpointer handles per-thread isolation).
- §11.2 explains why state, not runtime context: persistence across turns within a thread.

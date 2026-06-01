# TASK-21: Convert `domainIndexerPlugin`

**Phase:** 5 — Bundled plugin conversion
**Spec:** §16.1
**Effort:** 1 day
**Depends on:** TASK-11, TASK-15
**Blocks:** TASK-32
**Parallel with:** other plugin conversion tasks

## Goal

Convert the domain indexer feature (domain analysis, entity lookup) into a plugin. Sub-agent only. `visibility: 'always'`.

## Deliverables

### Created

- `packages/oracle-runtime/src/plugins/domain-indexer/domain-indexer.plugin.ts` — class with manifest, `configSchema: { DOMAIN_INDEXER_URL: z.string() }`, `getSubAgents(ctx)` returning the domain-indexer sub-agent.
- `packages/oracle-runtime/src/plugins/domain-indexer/index.ts`
- `packages/oracle-runtime/src/plugins/domain-indexer/domain-indexer.plugin.test.ts`

### Moved (`git mv`)

- `apps/app/src/graph/agents/domain-indexer-agent.ts` → `packages/oracle-runtime/src/plugins/domain-indexer/domain-indexer-agent.ts`

## Acceptance

- [ ] Plugin loads with `DOMAIN_INDEXER_URL` set.
- [ ] `call_domain_indexer_agent` tool appears in agent's tool list.
- [ ] Sub-agent invocation works end-to-end.
- [ ] Test: stubbed indexer returns mock data; sub-agent returns string result.

## Out of scope

- New indexer features.

## Notes

- Same shape as TASK-20 (firecrawl). Use it as a template.

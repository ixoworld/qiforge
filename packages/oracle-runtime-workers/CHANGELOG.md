# @ixo/oracle-runtime-workers

## 0.15.0

### Minor Changes

- [#297](https://github.com/ixoworld/qiforge/pull/297) [`d38f90a`](https://github.com/ixoworld/qiforge/commit/d38f90a06efaf641ae73d1e75e51464c187e3751) Thanks [@ig-shaun](https://github.com/ig-shaun)! - Turn budgets and hardened tool execution. Every turn now runs under a shared budget (`TURN_MAX_TOKENS`, `TURN_MAX_TOOL_CALLS`, `TURN_TIMEOUT_MS`) covering the main agent, its sub-agents and the helper models; exhaustion ends the turn with a terminal `error` frame (`kind: budget_exhausted`) and keeps the work done so far. Tool calls are scheduled per user object (writes one at a time, reads and sub-agents in bounded lanes), a write whose outcome is unknown is claimed in the run ledger so an identical call is not repeated blindly, and only read-only tools are retried after a transient failure. Sub-agents inherit the abort signal, await their completion hook, and no longer get an "authorization override" retry after a refusal. The context guard never resends an unchanged request after a provider overflow. `@ixo/oracle-runtime-workers/prompt` exposes the prompt composer for contract tests.

### Patch Changes

- [#318](https://github.com/ixoworld/qiforge/pull/318) [`9bb456a`](https://github.com/ixoworld/qiforge/commit/9bb456a87f161d4fd787f91b16ea6cda13226a1c) Thanks [@youssefhany-ixo](https://github.com/youssefhany-ixo)! - Dependency updates. The LangGraph stack moves to `@langchain/langgraph` 1.4.17, `@langchain/langgraph-checkpoint` 1.1.5, `@langchain/langgraph-checkpoint-sqlite` 1.0.4, `@langchain/langgraph-checkpoint-validation` 1.1.1 and `@langchain/mcp-adapters` 1.1.4. Both SQLite checkpoint savers now accept the `counters_since_delta_snapshot` metadata key that `langgraph-checkpoint` 1.1.5 adds for delta channels. Also updates `@tavily/core` 0.7.12, `mammoth` 1.12.3, `@digitalbazaar/http-client` 4.4.0, `@changesets/changelog-github` ^0.7.0, and lockfile-only bumps for `jose`, `@ixo/matrix-crdt`, `@nestjs/swagger` and `vitest`.

- Updated dependencies [[`9bb456a`](https://github.com/ixoworld/qiforge/commit/9bb456a87f161d4fd787f91b16ea6cda13226a1c)]:
  - @ixo/common@1.5.1

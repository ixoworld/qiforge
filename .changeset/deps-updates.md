---
'@ixo/common': patch
'@ixo/matrix': patch
'@ixo/oracle-runtime': patch
'@ixo/oracle-runtime-workers': patch
'@ixo/sqlite-saver': patch
---

Dependency updates. The LangGraph stack moves to `@langchain/langgraph` 1.4.17, `@langchain/langgraph-checkpoint` 1.1.5, `@langchain/langgraph-checkpoint-sqlite` 1.0.4, `@langchain/langgraph-checkpoint-validation` 1.1.1 and `@langchain/mcp-adapters` 1.1.4. Both SQLite checkpoint savers now accept the `counters_since_delta_snapshot` metadata key that `langgraph-checkpoint` 1.1.5 adds for delta channels. Also updates `@tavily/core` 0.7.12, `mammoth` 1.12.3, `@digitalbazaar/http-client` 4.4.0, `@changesets/changelog-github` ^0.7.0, and lockfile-only bumps for `jose`, `@ixo/matrix-crdt`, `@nestjs/swagger` and `vitest`.

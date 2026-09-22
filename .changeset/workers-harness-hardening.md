---
'@ixo/oracle-runtime-workers': minor
---

Turn budgets and hardened tool execution. Every turn now runs under a shared budget (`TURN_MAX_TOKENS`, `TURN_MAX_TOOL_CALLS`, `TURN_TIMEOUT_MS`) covering the main agent, its sub-agents and the helper models; exhaustion ends the turn with a terminal `error` frame (`kind: budget_exhausted`) and keeps the work done so far. Tool calls are scheduled per user object (writes one at a time, reads and sub-agents in bounded lanes), a write whose outcome is unknown is claimed in the run ledger so an identical call is not repeated blindly, and only read-only tools are retried after a transient failure. Sub-agents inherit the abort signal, await their completion hook, and no longer get an "authorization override" retry after a refusal. The context guard never resends an unchanged request after a provider overflow. `@ixo/oracle-runtime-workers/prompt` exposes the prompt composer for contract tests.

# Workers harness hardening: turn budgets, tool execution, write claims

**Status:** implemented in `packages/oracle-runtime-workers` (Sep 2026), not yet released. Builds on [durable runs](durable-runs.md) and [context budgets](context-budgets.md); the Node runtime is out of scope.

## Why

A turn could accumulate model and tool work without bound (only the graph
recursion limit stopped it), a write whose call failed on the wire could be
repeated by the model with no idea whether it had already happened, tool
calls ran with unbounded concurrency, and every tool — writes included — was
retried after a transient failure. A sub-agent that refused a task was
re-asked with a fabricated "authorization override".

## Guarantees

1. **One budget per turn** (`turn-budget.ts`). `TURN_MAX_TOKENS` (default
   500k), `TURN_MAX_TOOL_CALLS` (120) and `TURN_TIMEOUT_MS` (10 min) apply
   across the main agent, every sub-agent it dispatches and the helper models
   (summarizer, extraction). Model calls are charged by the metered LLM
   adapter (`budgeted-llm.ts`): a chars/4 estimate plus the reply reserve is
   reserved before the provider is contacted and settled to the provider's
   reported usage when the call ends. Tool calls are charged by the
   tool-execution middleware. The deadline aborts the run with the limit as
   the reason. Exhaustion is terminal: the stream carries one `error` frame
   (`kind: 'budget_exhausted'`, `limit: 'tokens' | 'tools' | 'time'`,
   `retryable: false`) and a `done` with `failed: true`; checkpoints and
   tool results already produced are kept. `TURN_RECURSION_LIMIT` stays the
   separate guard against a runaway graph.
2. **Bounded concurrency per user object** (`tool-scheduler.ts`). Writes run
   one at a time across every session and turn of the object; reads up to
   four at a time; sub-agent dispatches up to four, in their own lane so a
   child waiting for a parent's slot can never deadlock it. A wait ends with
   the turn's abort signal.
3. **A write with an unknown outcome is not repeated blindly**
   (`middlewares/tool-execution.ts`, `turn_write_claims` in the run
   ledger). Before a write runs, the SHA-256 of its tool name and canonical
   arguments is claimed. A returned outcome — success or a failure the
   service reported — releases the claim. An abort, the deadline, a dropped
   connection or a 5xx keeps it. An identical call while a claim stands is
   answered with an error tool message telling the model to verify with a
   read and ask the user (the claim becomes `warned`, owned by that run);
   the same turn stays blocked, a later turn that asks again runs it. Claims
   are per user object (every session), and are dropped with the run
   retention (7 days). This complements the tool marks of durable runs,
   which stop LangGraph from re-executing the very same call id after a
   restart; claims cover the model issuing a _new_ call for the same write.
4. **Only reads are retried.** The tool-retry middleware retries a transient
   failure once, for tools classified `read` (declared, MCP `readOnlyHint`,
   or the name convention in `tool-marks.ts`). Writes are never retried by
   the runtime; the model is told and decides. Provider-level retries of the
   model call itself are unchanged (`maxRetries: 2`).
5. **Sub-agents are honest.** A refusal is returned as the sub-agent's
   answer; the runtime no longer re-asks with an authorization it did not
   have. The parent's abort signal cancels the child graph. `onComplete` is
   awaited before the result reaches the parent (a failing hook is logged).
6. **No unchanged retry after a provider overflow.** The context guard
   retries once only when the hard prune made the request strictly smaller.
7. **Client framing is exact.** The SDK's SSE parser follows the
   specification (lines across reads, `\r\n`, multi-line `data:`, comments
   never end a frame); its behaviour on ids, malformed frames and aborts is
   unchanged, so the durable-run re-join protocol is untouched.

## What is recorded

- `turn_runs.usage` — the turn's `TurnUsage` JSON (estimated and reported
  tokens, model calls, tool attempts, elapsed), written once when the run
  ends. Diagnostics, not billing.
- `turn_write_claims` — fingerprint, tool name, run id, session id, started
  at, state. Never the arguments.

## Deliberate limits

Token counts are estimates until the provider reports usage; image and
audio inputs are not estimated. Claims match identical arguments only: the
same write with different wording is a different write. A downstream
service without an idempotency key still needs its own reconciliation.
Provider-backed comparative evaluation and deployed cancellation drills are
release gates, not something the unit suites can show.

## Files

`core/turn-budget.ts`, `core/budgeted-llm.ts`, `core/tool-scheduler.ts`,
`core/middlewares/tool-execution.ts`, `do/run-store.ts` (claims, usage),
`do/user-oracle-do.ts` (wiring, deadline), `do/sse-stream.ts` (limit
frame), `core/main-agent.ts` (read-only retry), `core/subagent-as-tool.ts`,
`core/middlewares/context-guard.ts`, `core/middlewares/summarization.ts`,
`@ixo/oracles-client-sdk` `utils/sse-parser.ts`.

# Context budgets: per-model windows, capped tool results, pruning

**Status:** implemented in `packages/oracle-runtime-workers` (Sep 2026), not yet released.

## Why

The summarizer condensed history after 20 messages or 40k estimated tokens
whatever the model, tool results entered history whole, and nothing knew how
large the model's window really was. A 1M-context model was summarized at the
same point as a 32k one; one big MCP dump could blow a small window between
two checks; and a provider rejection ended the turn with a raw error.

## Guarantees

1. **The window is the model's own.** Resolved per model id (`context-window.ts`):
   operator override → OpenRouter `/models` listing (same cached fetch as the
   prices; BYO-native ids are looked up under their vendor prefix) → the
   `MODEL_CONTEXT_TOKENS` default. A provider's "too long" error that names a
   limit lowers the window for that model permanently (Durable Object KV,
   `ctxwin:<model>`); nothing is ever learned upwards. Modelled on Hermes
   Agent's resolution chain, trimmed to the sources this runtime has.
2. **Every limit is a fraction of that window** (`context-budget.ts`):
   summarize at 50%, prune under pressure at 35%, cap a single tool result at
   12% (in chars, ×4), refuse a request above 95% minus the reply reserve
   (8k tokens, at most a quarter of the window). The 20-message trigger is
   gone unless `CONTEXT_SUMMARIZE_MESSAGES` asks for one.
3. **Big results are always both truncated and preserved** (`result-cap.ts`).
   Above the cap the model sees the first 40% and last 60% of the visible
   budget plus a footer naming the saved result (`sha-256` of the content);
   `read_result` pages it back by byte range. No per-tool policy: every tool,
   MCP servers and sub-agents included, gets the same treatment.
4. **Preserved results never grow the hot store unbounded** (`result-store.ts`).
   Under 1 MB they live in the object's SQLite (`tool_results`), above that in
   the R2 tier bucket under `<object id>/results/<id>`. Rows expire after
   24 h (`sweep()` at boot removes rows and objects), go with their session,
   and identical results share one row. A DO SQL row holds 2 MB, so the R2
   boundary is not tunable above 1.5 MB.
5. **Requests are trimmed before they are sent, never the state**
   (`context-guard.ts`). Above the prune threshold, tool results outside the
   kept tail become one-line placeholders (a capped result keeps its
   `read_result` handle) and results identical to a later one become
   back-references — request-only, no model call, the checkpoint and the
   transcript untouched. A request still above the cap after a hard prune is
   refused with a clear message. A provider overflow learns the window,
   prunes hard and retries once.
6. **A failed summary keeps the history** (`summarization.ts`): the
   summarizer's error text never replaces the conversation.

## Storage and cost

- Windows: one `/models` fetch per isolate-hour (already made for prices);
  one KV read per model per boot; one KV write per learned limit.
- Capped results: one `tool_results` row (or one R2 put plus one index row)
  per result above the cap — rare by construction — plus one delete at expiry.
- Pruning and guarding: no writes; chars/4 estimates over the request.

## Knobs

| Env                             | Default | Meaning                                                                     |
| ------------------------------- | ------- | --------------------------------------------------------------------------- |
| `MODEL_CONTEXT_TOKENS`          | 100000  | Window for models no source knows (min 16000)                               |
| `MODEL_CONTEXT_OVERRIDES`       | —       | `model=tokens,…` explicit windows (win over everything but a learned limit) |
| `CONTEXT_SUMMARIZE_FRACTION`    | 0.5     | Summarize the history at this share of the window                           |
| `CONTEXT_PRUNE_FRACTION`        | 0.35    | Prune old tool results in the request above this share                      |
| `CONTEXT_RESULT_CAP_FRACTION`   | 0.12    | One tool result may occupy this share (×4 chars)                            |
| `CONTEXT_RESULT_CAP_MAX_CHARS`  | 200000  | Ceiling on that cap (≈ 50k tokens), whatever the window                     |
| `CONTEXT_REQUEST_FRACTION`      | 0.95    | A request may use this share, reply reserve included                        |
| `CONTEXT_OUTPUT_RESERVE_TOKENS` | 8000    | Reserved for the reply (capped at a quarter of the window)                  |
| `CONTEXT_SUMMARIZE_MESSAGES`    | unset   | Optional message-count trigger on top of the token one                      |
| `CONTEXT_KEEP_MESSAGES`         | 10      | Recent messages the summarizer keeps verbatim                               |
| `TOOL_RESULT_TTL_HOURS`         | 24      | Saved-result lifetime                                                       |
| `TOOL_RESULT_R2_MIN_BYTES`      | 1000000 | Results this size or larger go to R2 (64 KiB … 1.5 MB)                      |

## Adding a model

No window table to maintain. A new OpenRouter model resolves from the catalog
as soon as it is listed; the one manual step is the selectable-model
allow-list (`MODEL_CATALOG`, `src/core/llm.ts`). A model OpenRouter does not
list falls to the 100k default until a provider overflow lowers it — pin it
with `MODEL_CONTEXT_OVERRIDES` when the real window is known.

## Diagnostics

`GET /debug/context?model=<id>` (with `ORACLE_DEBUG_ROUTES=true`) shows the
resolved window and its origin, every derived threshold, and the saved-result
store's row and byte counts per tier. `&session=<id>` adds the session's
working context — the messages of its latest checkpoint (count, summaries,
tool messages, a chars/4 token estimate; the transcript row count sits next
to it, never condensed) — and the guard's counters for it (`prunes`, `hardPrunes`,
`prunedResults`, `overflowRetries`, `refusals`) — the guard reports every
prune, overflow retry and refusal through `onEvent`, the object folds them
into `ctxstats:<session>` in KV (ordered writes, dropped with the session).
Logs: `[context] model=… window=… (origin) …` per turn, `[context] … pruned N
tool result(s)`, `[context] … window lowered A → B`, `[result-cap] <tool>: N
chars > cap …`, `[summarization] summary failed; keeping the full history`.
Tests assert on the counters, not the logs: `wrangler dev` does not forward
the worker's `console.log` output to the harness, and a deployed oracle has
no log to read.

## Files

- `src/core/context-window.ts` (+ test), `src/core/context-budget.ts` (+ test)
- `src/core/openrouter-pricing.ts` — `fetchOpenRouterContextLengths`
- `src/core/middlewares/result-cap.ts` (+ test), `context-guard.ts` (+ test),
  `summarization.ts` (token-only trigger, failed-summary guard, + test)
- `src/core/read-result-tool.ts`
- `src/do/result-store.ts` (+ workerd test via `result-store-test-do.ts`)
- `src/do/user-oracle-do.ts` — resolver, store, budget per turn, cap
  middleware, per-session guard counters, `contextStatus`;
  `src/shell/app.ts` — `GET /debug/context?model=&byoProvider=&session=`
- `src/core/main-agent.ts` (+ test: the budget binds `read_result`, the guard
  prunes, the token trigger summarizes with no message count)
- `apps/qiforge-workers-example/test/e2e-context.ts` — local and devnet drill
  (`drill_big_result` in `src/drill-plugin.ts`; the devnet oracle pins
  `google/gemini-3.1-flash-lite=32000` in `wrangler.devnet.jsonc` for the pressure
  step, `PRESSURE_MODEL` names another pinned model)

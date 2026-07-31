---
'@ixo/oracle-runtime': minor
---

Graceful error handling for BYO-LLM and platform model failures. Stream errors are classified server-side (`classifyLlmError`) into `rate_limit | billing | auth | timeout | server | network | unknown` with the failing account attributed (`source: byo | platform`, provider, status), and the SSE `error` event now carries the structured payload (friendly message, `retryable`, raw `detail`, `sessionId`/`requestId`) instead of raw SDK text. The stream runner's error path flushes orphaned tool spinners and closes the thinking indicator; BYO models cap retries at 2 (AsyncCaller's default of 6 left rate-limited users in "Thinking..." for a minute); silent BYO→platform fallbacks (missing credential, expired ChatGPT connection) emit a `byo_fallback` notice while the turn continues. A `/simulate-error <preset>` chat trigger (env-gated by `ALLOW_ERROR_SIMULATION`, never for deployed envs) replays faithful provider error shapes for local testing.

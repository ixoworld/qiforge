# @ixo/oracle-runtime

## 1.95.0

### Minor Changes

- [#240](https://github.com/ixoworld/qiforge/pull/240) [`0b1573a`](https://github.com/ixoworld/qiforge/commit/0b1573a2d6ce206c432392ab8f54c85b697f9743) Thanks [@ig-shaun](https://github.com/ig-shaun)! - Add semantic phase, human-only versus agent-capable execution, and governed skill metadata to the QiForge FlowSpec authoring contract. Preserve these fields through compile, Matrix/Yjs storage, read, edit, and validation so Portal-led Blueprint Builder flows can be resumed safely.

- [#242](https://github.com/ixoworld/qiforge/pull/242) [`b6cd393`](https://github.com/ixoworld/qiforge/commit/b6cd393e52c9e375189d1d3e9900f4b5f5cf571d) Thanks [@Michael-Ixo](https://github.com/Michael-Ixo)! - Bring-your-own-credential LLMs for the personal companion (`BYO_LLM_ENABLED`): users connect their ChatGPT subscription (Codex OAuth device flow) or per-provider API keys (OpenAI, Anthropic, Gemini, DeepSeek), stored as server-encrypted secrets in the canonical user↔oracle room. Per-turn a `byo:`-namespaced model id swaps a request-scoped LLM adapter into ambient so the main agent and every sub-agent role run on the user's credential; credits are skipped on BYO turns. Includes the `/byo-llm/*` connect surface (status, device flow, code exchange, API-key save, validate, disconnect), cross-provider reasoning-history sanitation, Responses-API stream handling in the SSE runner, `encryptJWE` + `SecretsService.putSecret` for server-side secret writes, and a `getChatAnthropicModel` factory.

- [#243](https://github.com/ixoworld/qiforge/pull/243) [`b094edc`](https://github.com/ixoworld/qiforge/commit/b094edc5bcf13f1c8043b36c546aef1721add28d) Thanks [@Michael-Ixo](https://github.com/Michael-Ixo)! - Graceful error handling for BYO-LLM and platform model failures. Stream errors are classified server-side (`classifyLlmError`) into `rate_limit | billing | auth | timeout | server | network | unknown` with the failing account attributed (`source: byo | platform`, provider, status), and the SSE `error` event now carries the structured payload (friendly message, `retryable`, raw `detail`, `sessionId`/`requestId`) instead of raw SDK text. The stream runner's error path flushes orphaned tool spinners and closes the thinking indicator; BYO models cap retries at 2 (AsyncCaller's default of 6 left rate-limited users in "Thinking..." for a minute); silent BYO→platform fallbacks (missing credential, expired ChatGPT connection) emit a `byo_fallback` notice while the turn continues. A `/simulate-error <preset>` chat trigger (env-gated by `ALLOW_ERROR_SIMULATION`, never for deployed envs) replays faithful provider error shapes for local testing.

### Patch Changes

- Updated dependencies [[`b6cd393`](https://github.com/ixoworld/qiforge/commit/b6cd393e52c9e375189d1d3e9900f4b5f5cf571d), [`cf21fba`](https://github.com/ixoworld/qiforge/commit/cf21fbab90d7b1e50fdd7d238ecc05375c25f8b4)]:
  - @ixo/common@1.5.0
  - @ixo/oracles-chain-client@2.2.0
  - @ixo/matrix@1.3.0

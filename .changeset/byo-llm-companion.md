---
'@ixo/oracle-runtime': minor
'@ixo/common': minor
'@ixo/oracles-chain-client': minor
---

Bring-your-own-credential LLMs for the personal companion (`BYO_LLM_ENABLED`): users connect their ChatGPT subscription (Codex OAuth device flow) or per-provider API keys (OpenAI, Anthropic, Gemini, DeepSeek), stored as server-encrypted secrets in the canonical user↔oracle room. Per-turn a `byo:`-namespaced model id swaps a request-scoped LLM adapter into ambient so the main agent and every sub-agent role run on the user's credential; credits are skipped on BYO turns. Includes the `/byo-llm/*` connect surface (status, device flow, code exchange, API-key save, validate, disconnect), cross-provider reasoning-history sanitation, Responses-API stream handling in the SSE runner, `encryptJWE` + `SecretsService.putSecret` for server-side secret writes, and a `getChatAnthropicModel` factory.

---
'@ixo/oracle-runtime-workers': minor
---

Model calls that OpenAI accepts, cheaper fallbacks, a record per call, and no silence when the model fails.

- **Tool-schema guard.** OpenAI and Azure compile every function parameter's `pattern` with Python's `re` and refuse the whole request when one does not compile (a Unicode property escape `\p{L}` from a zod `.regex(/…/u)`, a JavaScript named group, `\k<…>`, `[^]`, …). The platform model now leaves such a pattern out of the schema the model is shown (the tool still validates its arguments against its own schema), and warns once per isolate naming the tool and field. Accepted patterns are sent unchanged. The rules were measured on 79 patterns against OpenAI and Azure.
- **Fallbacks.** The `main` role's OpenRouter fallbacks are now `google/gemini-3.1-flash-lite`, then `google/gemini-2.5-flash-lite` (was Qwen3-235B Thinking, uncached on its one provider at ~10× the cost). Per oracle: `OPENROUTER_MAIN_FALLBACKS` (comma list or `none`) and `OPENROUTER_PROVIDER_ORDER` (provider slugs for the default model, or `none`).
- **No reasoning or raw tool output in a chat reply.** Text inside `<think>`/`<thinking>`/`<reasoning>` tags (or before an unmatched closer) is removed, and a model step whose text quotes a JSON tool result verbatim is not delivered.
- **Per-call routing record.** One `[llm-call] {…}` line per platform model call: generation id, requested and served model, provider, fallback (model or provider), prompt / cached / cache-write / output / reasoning tokens, cost, duration, error class. After a fallback or an error, `[llm-call-attempts] {…}` lists every provider OpenRouter tried (read in the background). The record is on the reply as `response_metadata.model_call` and is handed to the new `OraclePlugin.onModelCall(call, ctx)` hook for analytics.
- **Usage counted once.** A streamed reply's `response_metadata.usage` (tokens and cost) was exactly twice the real value; it is now the provider's own.
- **Busy reply on channel turns.** When a channel turn fails because the model could not be reached (provider errors, key limit 402/403, timeout), the person gets one short message (`channelFailureReply` plugin hook, else `CHANNEL_BUSY_REPLY`, else an English default), at most once per chat per 10 minutes, with the cause logged.

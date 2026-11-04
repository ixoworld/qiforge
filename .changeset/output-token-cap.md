---
'@ixo/oracle-runtime-workers': minor
---

Platform model calls are capped at 16,384 output tokens, reasoning included (`LLM_MAX_OUTPUT_TOKENS`; 0 leaves it to the model). A call that loops no longer runs to the model's own limit, which for `openai/gpt-5.6-luna` is 65,536 tokens and about 8 cents. BYO lanes are not capped.

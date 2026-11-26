---
'@ixo/oracle-runtime-workers': minor
---

GPT-6 Luna (`openai/gpt-6-luna`) is the platform default model: a fresh chat, the summarizer, and the `skills` and `subagent` roles run on it unless the deployment sets `DEFAULT_MODEL`. It is in the model catalog (images and files in, 1,050,000-token window, fallback list price $0.10 / $0.50 per million input / output tokens). GPT-5.6 Luna stays selectable; its fallback list price is corrected from $1.00 / $6.00 to OpenRouter's $0.20 / $1.20. Every call to a GPT-6 model (`openai/gpt-6-luna`, `-sol`, `-astra`) is pinned to OpenAI, then Azure, on every role, like the GPT-5.6 models, so repeated prompt prefixes stay cached (`OPENROUTER_GPT_5_6_IDS` is now `OPENROUTER_OPENAI_GPT_PINNED_IDS`, internal).

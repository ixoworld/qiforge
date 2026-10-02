# GPT-6 candidate support

GPT-6 Luna, GPT-6.1 Sol and GPT-6 Astra are additive candidates. Existing defaults, helper roles, prompts, provider credentials and fallback models remain configured as before. Catalog order deliberately keeps existing tier resolution ahead of candidates. Explicit candidate selection uses Responses on managed OpenRouter, OpenAI API-key and ChatGPT-connected routes. ChatGPT-connected account availability still requires an authenticated check.

## Request and state contract

The pinned `@langchain/openai` 1.4.7 recognizes GPT-5 reasoning names but does not recognize GPT-6. `core/gpt6.ts` explicitly selects Responses and supplies reasoning in `modelKwargs`; otherwise the SDK silently omits it. The adapter preserves supplied reasoning effort, maps unsupported `minimal` to `low`, and maps `none` to `low` for Sol 6.1 and Astra. The existing main-role effort remains the initial managed baseline. Sampling and log-probability options are removed. Existing cache retention requests become `prompt_cache_options.ttl: "30m"`.

Requests use `store: false` with encrypted reasoning included. LangChain's `zdrEnabled` conversion selects self-contained history and suppresses provider response-ID replay; this client option does not establish the account's contractual zero-data-retention eligibility. The oracle checkpoint remains authoritative. OpenRouter's Responses API is stateless and rejects stored conversation continuation. [OpenRouter Responses](https://openrouter.ai/docs/api_reference/responses/overview)

The pinned SDK converts tools/results with matching `call_id`, Structured Outputs to `text.format`, text/reasoning stream chunks, and total usage including reasoning tokens. The existing turn-budget callback consumes that usage. Provider pricing is discovered separately; baseline catalog prices are standard short-context input/output estimates, not an invoice or cache-write total. Host authorization, argument validation, receipts, effect idempotency, cancellation and budgets remain enforced outside the model.

Cross-provider reasoning residue is normalized before Responses conversion without mutating checkpointed messages. SSE presents a provider refusal as text once, and reports `status: incomplete` as a failed turn instead of invoking completion persistence. Internal model events remain excluded from user-facing messages.

## Activation gate

Recommendation after evaluation: Luna/Fast, Sol 6.1/Balanced, Astra/Expert. Do not change managed `DEFAULT_MODEL`, personal defaults or helper-role maps based on local tests alone. First publish a runtime release containing this changeset, update Companion's exact dependency and lockfile, and verify all network builds against that release. Then run authenticated candidate smoke tests and comparative workload evaluations.

Required evidence: current deployed revision and catalogs; actual upstream model and effort; tool round trip and multi-turn continuation; refusal/incomplete/error/cancellation; image input; Topic and Flow proposals; schema and permission-denial cases; actual usage, billed cost and p50/p95 latency. Keep provider fallback routing visible when assessing actual upstream model. An advertised model ID does not prove inference availability through a connected account.

The forms gateway and external voice agent are separate services. Neither is migrated by changing the Companion chat catalog. Forms must satisfy the existing 8-second gateway and 10-second route budgets and deterministic proposal validation. Voice requires its own model inventory and evaluation.

## Verification

`src/llm/gpt6.test.ts` exercises the pinned SDK with deterministic provider fixtures, including request bodies, strict tools, tool result IDs, usage, streaming, structured output and cancellation. Core tests cover history normalization; workerd SSE tests cover visible refusals and failed incomplete responses. These establish local contracts, not model task quality or live availability.

Official parameter contract: [GPT-6 migration](https://developers.openai.com/api/docs/guides/latest-model/gpt-6-astra.md#migration-quickstart), [Responses migration](https://developers.openai.com/api/docs/guides/migrate-to-responses).

# Model selection

Users can pick which LLM answers a message, the way they'd switch models in
ChatGPT or Claude. This page covers the runtime side: the catalog, the
`GET /models` endpoint, how a per-request choice is threaded to the agent, and
the env knobs. The client side lives in `@ixo/oracles-client-sdk`
(`useModels` + `useChat({ model })`).

## The pieces

| Concern                              | Location                                                         |
| ------------------------------------ | ---------------------------------------------------------------- |
| Curated catalog + allow-list + tiers | `src/llm/model-catalog.ts`                                       |
| Live OpenRouter price fetch (cached) | `src/llm/openrouter-pricing.ts`                                  |
| `GET /models` endpoint               | `src/modules/models/`                                            |
| Per-request threading                | `dto/send-message.dto.ts` → `agent-builder.ts` → `main-agent.ts` |
| Default + env overrides              | `src/llm/llm-provider.ts`, `src/config/base-env-schema.ts`       |

## Catalog

`MODEL_CATALOG` is a hand-picked list (a handful of models spanning OpenAI,
Google, Anthropic and open-weight families) rather than the full ~300-model
OpenRouter list — exposing everything to a non-technical user is hostile, and
an open list is a cost-control hole. Each entry carries a coarse `tier`
(`everyday` / `balanced` / `top`) that renders as `$` / `$$` / `$$$` plus a
`Fast` / `Balanced` / `Smartest` badge, a plain-language `blurb`, a `vision`
flag, and a **baseline** price used when the live fetch is unavailable.

The catalog is also the **allow-list**: `isAllowedModel(id)` gates the
per-request override, so a client can only select a listed model.

## Pricing and markup

`GET /models` returns the price the user actually pays: the raw OpenRouter
list price × `MODEL_PRICE_MARKUP` (default `1.6`, matching the mainnet
credit-billing markup). Live prices come from OpenRouter's public models API
(`fetchOpenRouterPrices`, cached process-wide for an hour); on any failure the
endpoint falls back to the catalog's baseline prices, so it never breaks.

The raw provider price and the markup multiplier are **not** included in the
response — only the marked-up price, the tier, and the badge. That keeps the
margin off the wire while still telling users what a model costs.

> This is display pricing. Credits are still deducted by the credits plugin's
> `TokenLimiter` from OpenRouter's per-response `usage.cost`; `GET /models`
> does not change billing.

## `GET /models`

`ModelsController` (`src/modules/models/`) returns
`{ models: ModelListItem[], default: string }`. It is **auth-excluded**
(see `AUTH_EXCLUDED_ROUTES` in `runtime-app-module.ts`) so a client can render
the picker before the user has an active subscription. `ModelsModule` is an
always-on core module wired into `RuntimeAppModule`.

## Per-request threading

`getProviderChatModel(role, { model })` already honours an override — the work
was threading a value from the request to it:

```
SendMessageDto.model                       // optional string on the body
  → SendMessagePayload.model
  → AgentBuilder                            // validates via isAllowedModel;
                                            // unknown id → dropped (default)
  → MainAgentRequestContext.model
  → main-agent.ts: resolveModel('main', { model })
```

An unknown or omitted model falls back to the default. Only the `main` role is
user-selectable; sub-agents, vision, guard, etc. keep their role models.

## Default model and env overrides

The default is **GPT-5.4 Nano** (`DEFAULT_MODEL_ID`) — the cheapest capable
OpenAI model. `getModelForRole('main')` returns `getDefaultModelId()`, which an
operator can override per deployment:

| Env var              | Default               | Effect                                                        |
| -------------------- | --------------------- | ------------------------------------------------------------- |
| `DEFAULT_MODEL`      | `openai/gpt-5.4-nano` | Default model for new chats (OpenRouter provider only).       |
| `MODEL_PRICE_MARKUP` | `1.6`                 | Markup applied to raw prices in `GET /models` (display only). |

Model selection applies to the OpenRouter provider; the Nebius provider keeps
its fixed role map.

# Bounded Decisions on Workers

A plugin can register semantic questions and evaluate them from a turn through `ctx.decisions`. Only the definition's explicitly projected state is sent to the provider. The runtime does not expose registered Decisions as agent tools. A host must deliberately call them from a tool, middleware or other application code.

```ts
import { defineDecision, OraclePlugin } from '@ixo/oracle-runtime-workers';
import { z } from 'zod';

const needsHelp = defineDecision({
  name: 'support.needs-help',
  version: '1.0.0',
  description: 'Assess whether the message requests help.',
  inputSchema: z.object({ message: z.string() }),
  project: ({ message }) => ({
    state: { message },
    questions: {
      needsHelp: {
        kind: 'boolean',
        instructions: 'Does the message ask for help?',
        criteria: {
          true: 'Requests assistance.',
          false: 'Does not request assistance.',
        },
      },
    },
  }),
});

class SupportPlugin extends OraclePlugin {
  readonly name = 'support';
  readonly version = '1.0.0';
  readonly manifest = {
    title: 'Support',
    summary: 'Help with support requests.',
    whenToUse: ['A user requests assistance.'],
  };
  getDecisions() {
    return [needsHelp];
  }
}
```

Inside an existing plugin handler, `await ctx.decisions.evaluate(needsHelp, { message })` returns a typed answer, provider/model identifiers, returned model version, timing, usage and a SHA-256 `requestHash` of the serialized projected request. This hash binds local provenance to input; it is not a signature or proof of semantic correctness. Handle rejections explicitly, for example by returning a review-required fact to the IXO Decisions engine. Never translate provider failure into approval or an invented answer.

## Configure the provider

The provider is independent of the agent's generative model. Set it on the **oracle Worker**, which owns turns, rather than the Matrix gateway. Credentials are read from the host's `env`. Cloudflare credentials are not copied into the plugin configuration object.

| Provider       | Worker vars                                                                                      | Worker secrets                                                       |
| -------------- | ------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------- |
| Cloudflare Jev | `DECISION_PROVIDER=cloudflare-jev`, `CLOUDFLARE_ACCOUNT_ID`, optional `CLOUDFLARE_AI_GATEWAY_ID` | `CLOUDFLARE_API_TOKEN` with Workers AI access                        |
| OpenRouter Jev | `DECISION_PROVIDER=openrouter-jev`, optional `OPENROUTER_JEV_MODEL=typesafe/jev-1.13`            | `OPEN_ROUTER_API_KEY` (same spelling as Companion's existing secret) |

`createOracleWorker({ decisionAdapter })` takes precedence over provider environment configuration. Leaving the provider unset is allowed; evaluating without an adapter rejects. Unsupported providers and missing required credentials fail core initialization. Only loaded plugins contribute registrations, and duplicate names fail initialization even within the same plugin.

Cloudflare uses `POST https://api.cloudflare.com/client/v4/accounts/{accountId}/ai/run` with `{ model: 'typesafe/jev', input: { state, questions } }`. Its optional gateway identifier is sent as `cf-aig-gateway-id`.

OpenRouter uses **`POST https://openrouter.ai/api/alpha/decisions`**, with `{ model, state, questions }`. The adapter defaults to `typesafe/jev-1.13`, requires a versioned model name, disables automatic provider fallback and requests `data_collection: 'deny'`. Availability with that routing policy must be verified for the operator's account; there is no silent fallback to a different model or provider. The endpoint is currently alpha. Do not use chat completions or JSON-schema chat output as a replacement for the Jev contract.

Both adapters map `boolean` to Jev `noul`, `choice` to `choice`, and `ordinal` to `score`. Noul is a probability, not a boolean. Scores can be fractional in `0..N-1`. Jev accepts string, object or array state; wrap primitive application values in an explicitly named object field. Provider output is validated against exactly the submitted questions and choices. Model version is required on successful Jev responses.

## Bounds and cancellation

- Default timeout: 5 seconds. Definition/call overrides must be integer milliseconds from 1 to 30,000.
- Maximum eight active adapter calls per runtime instance. A timed-out adapter that ignores cancellation retains its slot until it settles.
- Maximum 16 questions, 32 options per choice, 16 ordinal levels, 64 KiB of state and 128 KiB for the complete request.
- Response reads stop at 256 KiB, including streaming responses without `Content-Length`.
- No automatic retries or redirects. Provider HTTP errors, parser errors, raw causes and string error codes are not exposed.
- The owning turn signal cannot be replaced by a call-specific signal. Both apply; cancellation rejects even if a custom adapter ignores its signal.

Budgets are per runtime instance, not an account billing ceiling. Use Worker request quotas and provider spending limits for aggregate control. Custom adapters are trusted host code; they must settle after abort and perform no side effects.

## Companion deployment contract

The audited implementation is [Companion PR #239](https://github.com/ixoworld/companion/pull/239), commit `bc6962c44829d0981bb461a185b1aa8f0e6817d6`. It pins Workers runtime `0.13.0` and bot SDK `0.7.0`; this patch incorporates that QiForge baseline. It uses separate oracle/gateway scripts in devnet, testnet and mainnet. Preserve its DO bindings, migrations and existing `TopicChatDO` export when adopting the runtime.

Publish `@ixo/decisions` first and then the updated runtime packages. Update Companion's runtime pin and lockfile, set the chosen provider on the oracle Worker, and run an authenticated staging turn before promotion. The existing OpenRouter secret alone does not enable Decisions. Deploying a library does not establish model calibration or payment authority.

**Commerce limitation:** QiForge Workers and Companion currently have no `oracle-payments` plugin or Matrix commerce classifier. PR #312's telemetry remains a Node commerce feature. Enabling `ORACLE_PAYMENTS_ROUTER_ENGINE=decision-shadow` on Workers is unsupported; a separate Workers commerce implementation with host-owned contract/engagement gates is required before claiming commerce parity. General semantic Decisions work independently of that lane.

## Repeatable evidence

From the QiForge root, after installing dependencies:

```sh
node scripts/audit-workers-decisions.mjs --release
node scripts/audit-workers-decisions.mjs --live=cloudflare-jev
node scripts/audit-workers-decisions.mjs --live=openrouter-jev
```

The live checks require the environment credentials above and submit one fixed fictional message. They verify transport, finite answer shape and provenance, not probability thresholds, IXO authority, real user access or settlement. Missing credentials fail the check instead of skipping it.

Sources checked on 2026-09-20: [Cloudflare Jev contract](https://developers.cloudflare.com/ai/models/typesafe/jev/), [OpenRouter's official Decisions transport](https://github.com/OpenRouterTeam/typescript-sdk/blob/1a09de8a9749c72450bade8a373ed2120a2865c0/src/funcs/alphaDecisionsCreate.ts), [request schema](https://github.com/OpenRouterTeam/typescript-sdk/blob/1a09de8a9749c72450bade8a373ed2120a2865c0/src/models/decisionsrequest.ts) and [response schema](https://github.com/OpenRouterTeam/typescript-sdk/blob/1a09de8a9749c72450bade8a373ed2120a2865c0/src/models/decisionsresponse.ts).

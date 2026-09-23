# Bounded semantic decisions

QiForge Decisions are side-effect-free, typed semantic judgments over explicitly
projected state. They sit beside tools, skills, sub-agents, and middleware but
serve a different purpose: a Decision answers a finite question; deterministic
application code decides what consequences, if any, follow.

The runtime-independent core lives in `@ixo/common/ai/decisions`: the types,
`defineDecision`, request/result validation, the `DecisionRuntime` (timeouts,
abort propagation, provenance), the Jev adapters, and `resolveDecisionAdapter`,
which turns env config into an adapter. The Node runtime and the Workers
runtime both consume that module. The Node side adds plugin registration
(`DecisionRegistry`), the boot-time provider check, and
`RuntimeContext.decisions`.

## Why this is a separate primitive

A generative model is appropriate when the system needs to reason, write, plan,
or act through tools. It is a poor default for a repeated decision whose answer
space is already known.

The runtime therefore separates:

```text
state
  ↓
Decision
bounded semantic judgment + probabilities
  ↓
deterministic policy
thresholds / rules / escalation
  ↓
authority
UCAN / contract / human approval
  ↓
action
tool / Flow / payment / chain transaction
```

A Decision never grants authority and never executes a side effect.

## Question types

QiForge exposes provider-neutral names:

| QiForge kind | Meaning                              | Jev mapping                                         |
| ------------ | ------------------------------------ | --------------------------------------------------- |
| `boolean`    | Probability that a condition is true | Noul (true/false criteria folded into instructions) |
| `choice`     | Select one option from a finite set  | Choice                                              |
| `ordinal`    | Place the input on an ordered rubric | Score (at most 10 levels)                           |

Jev is only one possible adapter. Plugin code depends on the QiForge contract,
not on provider-specific request or response shapes.

## Define a Decision

```ts
import { defineDecision } from '@ixo/oracle-runtime';
import { z } from 'zod';

export const routeMessage = defineDecision({
  name: 'oracle-payments.route-message',
  version: '1.0.0',
  description: 'Classify whether a Matrix message requests paid work.',
  inputSchema: z.object({
    text: z.string(),
    services: z.array(
      z.object({
        id: z.string(),
        name: z.string(),
        description: z.string().optional(),
      }),
    ),
  }),
  project(input) {
    return {
      state: {
        message: input.text,
        services: input.services,
      },
      questions: {
        workRequestedNow: {
          kind: 'boolean',
          instructions:
            'Is the user clearly asking the agent to perform a listed paid service now?',
        },
        service: {
          kind: 'choice',
          instructions: 'Which listed service best matches the requested work?',
          options: Object.fromEntries([
            ...input.services.map((service) => [
              service.id,
              service.description ?? service.name,
            ]),
            ['none', 'No single listed service clearly matches.'],
          ]),
        },
      },
    };
  },
});
```

`inputSchema` validates application input. `project()` is the data-minimising
boundary: only its returned `state` is sent to the Decision provider.

## Register from a plugin

```ts
class OraclePaymentsPlugin extends OraclePlugin {
  getDecisions() {
    return [routeMessage];
  }
}
```

Decision names share one process-wide namespace. Duplicate names across plugins
fail boot.

Unlike tools, registered Decisions are not automatically exposed to the
generative agent or rendered into its prompt. Runtime code invokes them
explicitly. A plugin may wrap a Decision in a tool when agent invocation is
intentionally part of the product design.

## Evaluate

A tool or plugin handler can evaluate a typed definition:

```ts
const result = await ctx.decisions.evaluate(routeMessage, {
  text,
  services,
});
```

Runtime infrastructure can resolve a boot-registered Decision by name:

```ts
const result = await ctx.decisions.evaluateByName(
  'oracle-payments.route-message',
  input,
);
```

The result preserves provenance:

```ts
{
  decision: {
    name: 'oracle-payments.route-message',
    version: '1.0.0',
  },
  provider: '...',
  model: '...',
  modelVersion: '...',
  answers: { ... },
  latencyMs: 183,
  evaluatedAt: '...',
}
```

The raw projected state is not copied into the evaluation result.

## Runtime invariants

The core validation layer enforces:

1. At least one and at most 16 questions per evaluation.
2. A finite answer space: choice questions have 2–32 options; ordinal
   questions have 2–10 levels (the Jev Score cap, so a definition that
   validates locally is accepted by every adapter).
3. Projected state may be scalar, array, or object; it must be JSON-serializable and at most 64 KiB by default.
4. Provider answer keys exactly match requested question keys.
5. Choice answers can only select declared options.
6. Probabilities and confidence values are finite numbers in `[0, 1]`.
7. Choice probability maps match the declared option set and sum
   approximately to one; ordinal scores may be fractional but must remain
   inside `0..N-1`, and ordinal probability maps use the declared level indices.
8. Provider failure, timeout, or malformed output throws; the runtime never
   invents a semantic answer.
9. Decision timeout defaults to five seconds unless a definition or caller
   supplies a tighter value.
10. A Decision result has no execution semantics by itself.

Application code must still implement fail-open, fail-closed, human escalation,
payments, and other consequence policy explicitly.

## Tracing

Every evaluation runs as a LangChain run named `decision:<name>`, tagged
`decision`, so the turn's LangSmith tracer records it as a span. The span's
inputs are the Decision name, the projected state and the questions. Its
output is the evaluation, or the error when the provider fails or times out.
Its metadata carries `decision_name`, `decision_version`, `decision_provider`
and `decision_model`. With no tracer active, the run is a plain call.

Where the span attaches depends on where the Decision is evaluated:

- **Inside the graph** (a plugin tool calling `ctx.decisions`), the span nests
  under the tool's run. On Node it finds the parent through LangChain's
  implicit run context. On Workers, which has none, `ctx.decisions` passes the
  tool run's callbacks explicitly.
- **Before the graph** (the capability router and the commerce router), there
  is no parent run. Both routers receive the turn's tracer and metadata in
  `DecisionEvaluateOptions.callbacks` and `.metadata`, resolved by the same
  `resolveLangsmithTracing` call as the turn. The span is its own trace, and
  its `thread_id` metadata matches the graph run's, so LangSmith's thread view
  shows it next to the turn.

The gate is the turn's gate. In selective mode a router span is uploaded only
for a DID on `LANGSMITH_TRACED_DIDS`. In Node's global mode
(`LANGSMITH_TRACING=true`) LangChain attaches its tracer to every run, spans
included. Abort and timeout stay inside `DecisionRuntime`; the runnable never
receives the signal, so callers see the same errors as before.

## Adapter boundary

`DecisionAdapter` is intentionally small:

```ts
interface DecisionAdapter {
  readonly provider: string;
  readonly model: string;

  evaluate(
    request: DecisionRequest,
    options?: { signal?: AbortSignal },
  ): Promise<DecisionProviderResult>;
}
```

Without an adapter, `ctx.decisions.evaluate(...)` throws
`DecisionProviderUnavailableError`. The test runtime provides a deterministic
mock adapter.

### Choosing a provider

An adapter comes from one of two places. A host can supply one directly:

```ts
createOracleApp({
  config,
  decisionAdapter,
});
```

Otherwise `resolveDecisionAdapter(config)` from `@ixo/common` builds one from
env at boot. A host adapter always wins over env configuration, and when one
is supplied the env credential check is skipped entirely. The env keys are the
shared `decisionProviderEnvShape`, spread into the Node base env schema:

```text
DECISION_PROVIDER=openrouter-jev | cloudflare-jev
DECISION_MODEL=<optional model override>
```

| `DECISION_PROVIDER` | Credentials                                                                                                                  |
| ------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| `openrouter-jev`    | Reuses the existing `OPEN_ROUTER_API_KEY`; nothing else to set.                                                              |
| `cloudflare-jev`    | On Node: `CLOUDFLARE_ACCOUNT_ID` + `CLOUDFLARE_API_TOKEN` (Cloudflare REST API). On Workers: just the `AI` binding, no keys. |

Leaving `DECISION_PROVIDER` unset leaves Decisions unconfigured. Selecting a
provider without its credentials fails boot with one reported issue per
missing field. There is no AI Gateway option; requests go straight to the
provider.

`DECISION_MODEL` overrides the default model id. OpenRouter's decisions
endpoint is still alpha, so the OpenRouter adapter pins a specific Jev model
version by default rather than tracking `latest`; Cloudflare uses the
account's `typesafe/jev` model.

### Jev mapping

All Jev adapters share one wire layer (`packages/common/src/ai/decisions/jev/`)
that
maps the provider-neutral request onto Jev's question types without changing
plugin Decision definitions:

- `boolean → noul`. Jev's noul question takes instructions only, so any
  `criteria.true` / `criteria.false` text is folded into the instructions.
- `choice → choice`, with the declared options as Jev criteria.
- `ordinal → score`, with the declared levels as Jev criteria. Jev accepts at
  most 10 levels, which is why the default ordinal limit is 10.

On the way back, probability maps are normalised before validation: any
declared option or level the provider left out is filled with `0`, since a
missing entry means the provider assigned it no mass. Keys that were never
declared still fail validation, as does any answer outside the declared set.

## Testing

`createTestRuntime` can exercise a Decision without constructing any LLM:

```ts
const rt = await createTestRuntime({
  plugins: [plugin],
  mocks: {
    decision: {
      respondWith: {
        answers: {
          workRequestedNow: {
            kind: 'boolean',
            probabilityTrue: 0.97,
          },
        },
      },
    },
  },
});

await rt.invokeDecision('example.route', input);
```

This keeps bounded semantic evaluation independently testable from generative
agent behavior.

## Runtime consumers

Two pieces of runtime infrastructure evaluate a Decision on the message path,
both ahead of the first generative model call and both failing open:

| Consumer                                                             | Decision                        | Where                                                     | What the verdict drives                                                                                                              |
| -------------------------------------------------------------------- | ------------------------------- | --------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| Commerce routing (`ORACLE_PAYMENTS_ROUTER_ENGINE=decision\|-shadow`) | `oracle-payments.route-message` | `modules/messages/message-router.service.ts`, Matrix only | support vs. work persona; see [Matrix commerce](matrix-commerce.md)                                                                  |
| Capability router (`CAPABILITY_ROUTER=on\|shadow`)                   | `runtime.route-capabilities`    | `modules/messages/capability-router.ts`, every ingress    | which on-demand plugin's tools to expose for the turn; see [Meta-tools and discovery](meta-tools-and-discovery.md#capability-router) |

The capability router's Decision and its policy (`decideCapabilityRoute`, the
0.7 floor) are defined in `@ixo/common/ai/decisions/capability-router.ts` so
the Node and Workers runtimes preload on identical rules; only the wiring is
runtime-specific.

## Read next

- [Plugin lifecycle](plugin-lifecycle.md) — when Decisions are registered.
- [Runtime context](runtime-context.md) — how `ctx.decisions` is scoped to a
  turn.
- [Matrix commerce](matrix-commerce.md) — the first production consumer.
- [Meta-tools and discovery](meta-tools-and-discovery.md#capability-router)
  — the second: the pre-model capability preload.

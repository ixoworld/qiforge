# Bounded semantic decisions

QiForge Decisions are side-effect-free, typed semantic judgments over explicitly
projected state. They sit beside tools, skills, sub-agents, and middleware but
serve a different purpose: a Decision answers a finite question; deterministic
application code decides what consequences, if any, follow.

Provider-independent types live in `@ixo/common/ai/decisions`. The Node runtime
adds registration, evaluation, timeout handling, provenance, and
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

| QiForge kind | Meaning                              | Jev mapping |
| ------------ | ------------------------------------ | ----------- |
| `boolean`    | Probability that a condition is true | Noul        |
| `choice`     | Select one option from a finite set  | Choice      |
| `ordinal`    | Place the input on an ordered rubric | Score       |

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
   questions have 2–16 levels.
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

Hosts supply an adapter with:

```ts
createOracleApp({
  config,
  decisionAdapter,
});
```

PR 1 introduces no production provider. Without an adapter,
`ctx.decisions.evaluate(...)` throws `DecisionProviderUnavailableError`.
The test runtime provides a deterministic mock adapter.

The first production adapter maps the provider-neutral question kinds to
TypeSafe Jev through Cloudflare's AI REST API. Enable it with:

```text
DECISION_PROVIDER=cloudflare-jev
CLOUDFLARE_ACCOUNT_ID=<account id>
CLOUDFLARE_API_TOKEN=<token>
CLOUDFLARE_AI_GATEWAY_ID=<optional gateway id>
```

When the provider is selected, the account id and token are required at boot.
An explicit `createOracleApp({ decisionAdapter })` override wins over env
configuration. The optional gateway id is forwarded as
`cf-aig-gateway-id`; third-party Jev requests otherwise use Cloudflare's
default gateway behavior.

The adapter maps `boolean → Noul`, `choice → Choice`, and
`ordinal → Score` without changing plugin Decision definitions.

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

## Read next

- [Plugin lifecycle](plugin-lifecycle.md) — when Decisions are registered.
- [Runtime context](runtime-context.md) — how `ctx.decisions` is scoped to a
  turn.
- [Matrix commerce](matrix-commerce.md) — the first planned production
  consumer.

## Workers and provider hardening

Definitions, validation and provider adapters are shared through `@ixo/decisions`. Node entry points remain compatible; Workers exports the same primitive and supplies `RuntimeContext.decisions`. See the [Workers Decisions contract](../../packages/oracle-runtime-workers/docs/decisions.md) for Cloudflare/OpenRouter configuration, bounded transport, cancellation and deployment gates. The Matrix commerce shadow path remains Node-only.

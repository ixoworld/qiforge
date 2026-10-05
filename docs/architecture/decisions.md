# Bounded semantic decisions

QiForge Decisions are side-effect-free, typed semantic judgments over explicitly
projected state. They sit beside tools, skills, sub-agents, and middleware but
serve a different purpose: a Decision answers a finite question; deterministic
application code decides what consequences, if any, follow.

The runtime-independent core lives in `@ixo/common/ai/decisions`: the types,
`defineDecision`, request/result validation, the `DecisionRuntime` (timeouts,
abort propagation, applicability gating, provenance), the provider registry
and router, the Jev adapters, `resolveDecisionAdapter` (env config to an
adapter), Final Decision Subject binding and receipts, and the packed-question
isolation probe. The Workers runtime (`@ixo/oracle-runtime-workers`) adds
plugin registration (`DecisionRegistry`), boot-time provider resolution in
`createRuntimeCore` (`packages/oracle-runtime-workers/src/core/index.ts`), and
`ctx.decisions`.

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

## Open Decisions profile

QiForge follows the draft
[Open Decisions: Trustworthy Decision-to-Action Profile](../../specs/open-decisions-trustworthy-action.md)
for consequential decision flows. The profile makes the separation above
normative:

```text
Evidence → Semantic Judgment → Decision Policy → Authority → Action
```

In particular:

- semantic confidence MUST NOT be treated as execution authority;
- components that can mutate an executable action MUST run before final subject
  binding, or MUST invalidate and repeat the decision/authorization;
- consequential flows MUST bind approval to a canonical Final Decision Subject
  before execution;
- provider-specific confidence, probability, and calibration semantics MUST NOT
  be conflated;
- MCDA criterion estimates and principal preference weights MUST remain
  logically distinct.

The Decision primitive supplies the profile's OD-J mechanisms (applicability
gating, provenance, the isolation probe) and the OD-A building blocks (subject
binding and receipts). Section 11 of the profile records what is and is not
claimed.

## Final Decision Subject binding

Consequential consumers bind authority to the exact action that was approved
and reject any later mutation:

```ts
import {
  createDecisionAuthorityReceipt,
  createDecisionExecutionReceipt,
} from '@ixo/oracle-runtime-workers';

const subject = {
  kind: 'payment',
  action: paymentInstruction,
  evidenceRefs,
  policyRef: 'rubric:pay-v3',
};

const authority = await createDecisionAuthorityReceipt({
  subject,
  mechanism: 'ucan',
  reference: ucanCid,
});

// Immediately before the side effect:
const { receipt, subject: executable } = await createDecisionExecutionReceipt({
  authority,
  currentSubject: subject,
});

// Perform the effect from `executable`, never from `subject` or
// `paymentInstruction`:
await pay(executable.action);
```

The subject is canonicalised as `ixo-json-v1` (plain JSON only, object keys
sorted by UTF-16 code unit, array order kept, no whitespace, `-0` written as
`0`, numbers and strings as `JSON.stringify` writes them, so `1e21` is
`1e+21`; undefined values, functions, symbols, bigints, non-finite numbers,
sparse arrays, cycles, Dates, Maps, typed arrays and other class instances are
rejected). It must also have a non-empty string `kind` and an `action`. The
canonical bytes are hashed with SHA-256 through Web Crypto, so the functions
are asynchronous and behave the same on Workers and Node.

`createDecisionExecutionReceipt` reads the current subject once (each
property, array length and element exactly once), digests those bytes and
compares the digest with the authority receipt. If the action, evidence
references, policy, or bound context changed, `StaleDecisionSubjectError` is
thrown and nothing is returned. Otherwise it returns `{ receipt, subject }`:
`subject` is parsed back from the very canonical bytes that were hashed and
deeply frozen. **The side effect must run from that returned `subject`.** The
caller's object was only read once; a getter, a proxy or other code holding a
reference can change it after the check, and an effect performed from it
would execute something other than what was authorized.
`assertFinalDecisionSubjectUnchanged(binding, subject)` performs the
comparison alone and returns nothing to execute from, so it is not a
substitute right before a side effect.

The check belongs immediately before the consequential side effect. Middleware
or business logic may mutate a draft action earlier, but mutation after
authority requires the subject to be rebound and authorized again. No runtime
consumer uses these receipts yet; they are the primitive consequential
consumers compose with their own policy and authority.

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
import { defineDecision } from '@ixo/oracle-runtime-workers';
import { z } from 'zod';

export const routeMessage = defineDecision({
  name: 'example.route-message',
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

### Applicability and evidence completeness

`project()` may declare that the projected state is not fit for authoritative
semantic judgment:

```ts
return {
  state,
  applicability: {
    applicable: true,
    evidenceComplete: false,
    reason: 'Delegated task payload is encrypted and unavailable.',
  },
  questions,
};
```

The runtime checks this before it selects or calls a provider. If `applicable`
or `evidenceComplete` is false, it throws `DecisionNotApplicableError` (carrying
the declared `applicability`) and no provider is called. Application policy then
passes through, requests more evidence, or escalates; missing evidence is never
converted into a negative semantic answer. A `reason`, when given, must be
non-empty. Omitted applicability is recorded on the evaluation as
`{ applicable: true, evidenceComplete: true }`.

## Register from a plugin

```ts
class ExamplePlugin extends OraclePlugin {
  getDecisions(ctx: PluginContext) {
    return [routeMessage];
  }
}
```

Decision names share one namespace per oracle. Duplicate names across plugins
fail `warm()` at boot.

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
  'example.route-message',
  input,
);
```

`ctx.decisions` inherits the turn's abort signal and tracer. A caller may pass
`{ providerId }` to evaluate with one specific configured provider (see
[Choosing a provider](#choosing-a-provider)).

The result preserves provenance:

```ts
{
  decision: {
    name: 'example.route-message',
    version: '1.0.0',
  },
  providerId: 'cloudflare-jev',      // configured provider instance
  providerSelection: 'default',      // caller-override | decision-route | default | sole-provider
  provider: 'cloudflare',            // engine
  model: 'typesafe/jev',
  modelVersion: '...',
  applicability: { applicable: true, evidenceComplete: true },
  judgment: {
    method: { kind: 'provider-native', name: 'typesafe-system-one' },
    questionSetVersion: '1.0.0',     // the Decision version
  },
  answers: { ... },
  latencyMs: 183,
  evaluatedAt: '...',
}
```

The raw projected state is not copied into the evaluation result.
`DecisionRuntime` always sets `providerId`, `providerSelection`,
`applicability` and `judgment`; they are optional in the `DecisionEvaluation`
type only so hand-built evaluations (test doubles) written against the earlier
shape still compile.

### Judgment reliability provenance

The `judgment` block records the Decision version as `questionSetVersion` and
whatever method and calibration the adapter declares in
`DecisionProviderResult.provenance`:

```ts
judgment: {
  questionSetVersion: '1.0.0',
  method: {
    kind: 'specialized',
    name: 'L2',
    artifactRef: 'head:qwen3-4b:route:v3',
  },
  calibration: {
    method: 'temperature-scaling',
    artifactRef: 'cal:route:v3',
    workload: 'support-routing',
    version: '3',
    evaluatedAt: '2026-09-24T00:00:00.000Z',
    ece: 0.04,
    brier: 0.12,
  },
}
```

Provenance is validated like the answers: an empty method kind, an empty
optional string, a negative or non-finite ECE/Brier, or an unparseable
`evaluatedAt` fails the evaluation. An adapter that declares nothing is
recorded as `{ kind: 'provider-native' }`, which makes no calibration claim.
The Cloudflare-hosted Jev adapters (`CloudflareJevDecisionAdapter`,
`WorkersAiJevDecisionAdapter`) declare
`{ kind: 'provider-native', name: 'typesafe-system-one' }` and no calibration
when they run their default model, `typesafe/jev`. With any other model
(`DECISION_MODEL` or the `model` option) they declare plain
`{ kind: 'provider-native' }`, because that model's method is not known. Each
result carries its own provenance object. The OpenRouter Jev adapter declares
nothing, so it is recorded as plain `provider-native`.

### Packed-question isolation

Providers that evaluate several questions against shared state can be probed
with `measureDecisionQuestionIsolation(adapter, request)`. The probe evaluates
the packed request, then each question alone against identical state, and
reports per question whether the selection flipped (boolean: the side of 0.5;
choice: the chosen option), the largest probability delta, and for ordinal
questions the score delta. It validates every provider result like the
runtime does and refuses a request declared inapplicable or
evidence-incomplete. It calls the adapter `1 + questions` times and sets no
tolerance: the acceptable delta is a workload or profile policy. Run it in a
test or evaluation harness, not on a live request path.

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
8. Provider failure, timeout, or malformed output (answers or provenance)
   throws; the runtime never invents a semantic answer and never retries on
   or falls back to another provider.
9. A request declared inapplicable or evidence-incomplete is refused before
   any provider is called.
10. Decision timeout defaults to five seconds unless a definition or caller
    supplies a tighter value.
11. A Decision result has no execution semantics by itself, and provider
    selection grants no authority.

Application code must still implement fail-open, fail-closed, human escalation,
payments, and other consequence policy explicitly.

## Tracing

Every evaluation runs as a LangChain run named `decision:<name>`, tagged
`decision`, so the turn's LangSmith tracer records it as a span. The span's
inputs are the Decision name, the projected state and the questions. Its
output is the evaluation, or the error when the provider fails or times out.
Its metadata carries `decision_name`, `decision_version`,
`decision_provider_id`, `decision_provider_selection`, `decision_provider` and
`decision_model`. With no tracer active, the run is a plain call. A request
refused for applicability never starts a span.

Where the span attaches depends on where the Decision is evaluated:

- **Inside the graph** (a plugin tool calling `ctx.decisions`), the span nests
  under the tool's run: Workers has no implicit LangChain run context, so
  `ctx.decisions` passes the tool run's callbacks explicitly.
- **Before the graph** (the capability router), there is no parent run. The
  router receives the turn's tracer and metadata in
  `DecisionEvaluateOptions.callbacks` and `.metadata`, resolved by the same
  `resolveLangsmithTracing` call as the turn. The span is its own trace, and
  its `thread_id` metadata matches the graph run's, so LangSmith's thread view
  shows it next to the turn.

The gate is the turn's gate. In selective mode a router span is uploaded only
for a DID on `LANGSMITH_TRACED_DIDS`. Abort and timeout stay inside
`DecisionRuntime`; the runnable never receives the signal, so callers see the
same errors as before.

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

`DecisionProviderResult` may also carry `provenance` (see
[Judgment reliability provenance](#judgment-reliability-provenance)). An
adapter receives the whole `DecisionRequest`, including `applicability`, but
is only ever called for an applicable request with complete evidence.

### Choosing a provider

The runtime evaluates through a `DecisionProviderRouter` over a
`DecisionProviderRegistry` of configured providers. Each registration pairs a
stable `id` (what policies route to and what evaluations record as
`providerId`) with an adapter. Providers come from:

- **env**: `DECISION_PROVIDER` builds one adapter through
  `resolveDecisionAdapter` and registers it under that value as its id
  (`cloudflare-jev` or `openrouter-jev`);
- **the host**: `createOracleWorker({ decisionProviders })` registers further
  providers beside the env one.

```ts
createOracleWorker({
  config,
  plugins,
  decisionProviders: [{ id: 'semif-local', adapter: semif }],
  decisionProviderPolicy: {
    // Optional; without it the env-selected provider is the default.
    defaultProviderId: 'cloudflare-jev',
    routes: { 'example.route-message': 'semif-local' },
  },
});
```

Selection is deterministic, in this order:

1. the caller's `providerId` (`ctx.decisions.evaluate(def, input, { providerId })`);
2. an exact per-Decision route (`routes[decision.name]`);
3. the policy's `defaultProviderId`, or else the env-selected provider;
4. the only registered provider, when exactly one is configured.

With several providers and none of these naming one, the evaluation is
refused with `AmbiguousDecisionProviderError` rather than picking by
registration order. It subclasses `DecisionProviderUnavailableError`, so
callers that fail open on a missing provider (the capability router) treat it
the same way. An unknown caller `providerId` throws
`DecisionProviderNotFoundError`. With no provider at all, every evaluation
throws `DecisionProviderUnavailableError`. A provider failure is the
evaluation's failure: there is no automatic fallback to another provider and
no retry.

Boot fails (with a `[boot-error]` log) when a policy names an unknown provider,
when two providers share an id (including a host provider named like the env
one), and when `DECISION_PROVIDER` is set without its credentials, whether or
not host providers are also supplied.

Host adapters are constructed once per oracle, outside any Worker `env`, so a
provider that needs a Worker binding, such as Jev on the `AI` binding, comes
from `DECISION_PROVIDER`. The older single-adapter option remains:
`createOracleWorker({ decisionAdapter })` registers that adapter as provider
`host` and makes it the default. It wins over env, which is then neither
checked nor registered, and it is mutually exclusive with `decisionProviders`.

The env keys are the shared `decisionProviderEnvShape`, spread into the
Workers base env schema:

```text
DECISION_PROVIDER=openrouter-jev | cloudflare-jev
DECISION_MODEL=<optional model override>
```

| `DECISION_PROVIDER` | Credentials                                                                                                                            |
| ------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| `openrouter-jev`    | Reuses the existing `OPEN_ROUTER_API_KEY`; nothing else to set.                                                                        |
| `cloudflare-jev`    | The Worker's `AI` binding, no keys. Without the binding: `CLOUDFLARE_ACCOUNT_ID` + `CLOUDFLARE_API_TOKEN` for the Cloudflare REST API. |

Leaving `DECISION_PROVIDER` unset registers no env provider. Selecting a
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

A Decision is testable without any LLM: boot the runtime core with a stub
adapter and evaluate through `core.decisions` or a turn's `ctx.decisions`.

```ts
const core = createRuntimeCore({
  config: { name: 'TestOracle' },
  plugins: [plugin],
  env,
  decisionProviders: [
    {
      id: 'stub',
      adapter: {
        provider: 'stub',
        model: 'stub-model',
        async evaluate() {
          return {
            answers: {
              workRequestedNow: { kind: 'boolean', probabilityTrue: 0.97 },
            },
          };
        },
      },
    },
  ],
});
await core.warm();

await core.decisions.evaluateByName('example.route-message', input);
```

`packages/oracle-runtime-workers/src/core/decisions.test.ts` covers the
wiring (env provider as default, host providers and policy, ambiguity,
provenance, applicability) and `src/core/decision-contract.test.ts` runs the
subject binding and the isolation probe on workerd. The shared module's own
suites are in `packages/common/src/ai/decisions/*.test.ts`.

## Runtime consumers

The capability router is the live consumer on the Workers runtime. It
evaluates ahead of the first generative model call and fails open:

| Consumer                                           | Decision                     | Where                                                                       | What the verdict drives                                                                                                                                               |
| -------------------------------------------------- | ---------------------------- | --------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Capability router (`CAPABILITY_ROUTER=on\|shadow`) | `runtime.route-capabilities` | `packages/oracle-runtime-workers/src/core/capability-router.ts`, every turn | which on-demand plugin's tools to expose for the turn; see the Workers [architecture](../../packages/oracle-runtime-workers/docs/architecture.md) (capability router) |

The router's Decision and its policy (`decideCapabilityRoute`, the 0.7 floor)
are defined in `@ixo/common/ai/decisions/capability-router.ts`. It does not
declare applicability (the message text is always observable), so it is
recorded as fully applicable. A missing provider and an ambiguous provider
configuration both make it preload nothing, with one warning per object.

The deprecated Node runtime's commerce routing Decision
(`oracle-payments.route-message`) has no Workers plugin, so it has no consumer
here.

## Read next

- [Open Decisions trustworthy action profile](../../specs/open-decisions-trustworthy-action.md)
  — normative judgment-to-action invariants and conformance levels.
- [Workers configuration](../../packages/oracle-runtime-workers/docs/configuration.md#decisions)
  — the Decision env variables and `createOracleWorker` options.
- [Workers architecture](../../packages/oracle-runtime-workers/docs/architecture.md)
  — where the capability router runs in the turn build.

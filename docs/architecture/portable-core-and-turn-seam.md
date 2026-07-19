# Portable core (`@ixo/oracle-core`) and the turn seam

## Why the split exists

The sovereignty appraisal rejected shipping a "portable" surface as a
subpath of the Node package: installing `@ixo/oracle-runtime` still resolves
its full Node/Nest/native dependency tree. `@ixo/oracle-core` is a real
package whose dependency set is web-standard by construction: `langchain`,
`@langchain/core`, `zod`, `node-emoji` (pure JS), `@ixo/oracles-events`
(eventemitter2 only). No `node:*` imports, no `@nestjs/*`, no `process.env`
reads.

## What lives in core

| Area                        | Modules                                                                                                                                                              |
| --------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Authority kernel primitives | `kernel/` — audit (records, digests, sinks), permissions schema, turn budgets, ledger port, in-process execution broker                                              |
| Turn seam                   | `turn/` — `TurnFrame`/`TurnStreamSink` contract, stream translator, `handleTurn`                                                                                     |
| Semantic routing            | `routing/` — route config + validation, llm/embedding classifiers, router middleware                                                                                 |
| Model policy                | `llm/` — operator policy (layering, constraints, fallbacks-with-disclosure), credential broker, provider-adapter registry, builtin defaults                          |
| Events                      | `events/` — canonical event names, wire envelope                                                                                                                     |
| Config envelopes            | `config/` — `signedConfigEnvelopeSchema` (content-addressed, controller-authorized, anti-rollback fields), `dataPolicySchema` (+ fail-closed `isPlacementPermitted`) |

`@ixo/oracle-runtime` re-exports every moved module at its old path, so the
public 1.x surface (and error-class identities) is unchanged — the entire
runtime unit-test suite runs through those shims. Node-coupled surfaces stay
in the runtime on purpose: `kernel/context-guard` (needs the full
`RuntimeContext` shape), `llm/llm-provider` (provider SDKs), the scoped
emitter (ambient wiring).

**Deferred next tranche** (tracked, not dropped): moving `graph/`,
`registries/`, `plugin-api/`, `manifest/` into core. Blocked on making
`plugin-api`'s Nest route types structural and auditing the
prompt-composer's `@ixo/common` dependency. The plugin-name decoupling that
blocked this before (memory/editor/flows special cases in the graph) is
already done via `subAgentPassthrough`, `getPromptContribution`, and
`providesRequestGate`.

## The turn seam

`SseStreamRunner` is now a Node/express transport shell (headers, heartbeat,
abort registry, ALS, terminal `done`/`error` frames). The turn itself runs
in `handleTurn`:

- translates LangChain `streamEvents` v2 envelopes into ordered wire events
  (semantics byte-identical to the legacy runner — the existing
  `sse-stream-runner.test.ts` suite is the golden record and passed the
  refactor without a single edit);
- writes versioned `TurnFrame`s (monotonic per-turn `seq`) to an async,
  backpressure-aware `TurnStreamSink` — a saturated transport pauses the
  loop instead of buffering unboundedly;
- on abort, stops without trailing frames; closes the sink exactly once.

`BatchInvoker` deliberately stays on `agent.invoke()`: its contract is the
final graph state, there is no stream to translate and no transport to port.

## Portability gates

- `pnpm --filter @ixo/oracle-core check:neutral-bundle` (also in CI):
  esbuild neutral-platform bundle with bare imports external — any `node:*`
  specifier fails the build. `nodejs_compat` is deliberately not part of any
  gate; compat stubs proving nothing is the failure mode this avoids.
- `apps/oracle-worker` is a **fail-closed compile spike** (every route 503,
  no model adapter registered, no billable call constructible) proving the
  core compiles into a workerd-shaped entry. The deployable adapter is
  Phase 5 (`specs/phase-5-authenticated-config-and-cf-adapter.md`).

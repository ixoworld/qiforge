# Testing overview

The runtime has three test layers. Most plugins land tests in layers 1 and 2; layer 3 is selective.

## Layer 1 — Unit (`*.test.ts`)

Vitest, in-process, no Nest boot. Uses `createTestRuntime` (from `packages/oracle-runtime/src/testing/`) to synthesise a `RuntimeContext` and a populated registry without booting NestJS or talking to Matrix/LLM/MCP services.

Use for:

- Plugin hook behaviour (`getTools` returns the right shape, `manifest` validates, `configSchema` rejects bad input).
- Tool handler logic (with mocks for upstream calls).
- Middleware logic (input/output shapes, error paths).
- Framework module internals (registries, loader, composer, manifest validator).

Lives next to the source: `<file>.test.ts`. Runs in `pnpm test`.

## Layer 2 — Integration (`*.int.test.ts`)

Vitest, real `createOracleApp` boot, real Matrix and LLM. Loads `.env.integration`. File-parallelism off (one Matrix admin user).

Use for:

- Boot validation (the runtime starts, plugins resolve as expected).
- End-to-end tool invocation (a real LLM call returns a real tool call against real upstream services).
- Specific scenarios that need the full Nest DI graph (e.g. controllers, middleware ordering, lifecycle hooks).

Lives next to source: `<file>.int.test.ts`. Or in `test/integration/` for app-level scenarios. Runs in `pnpm test:integration`.

Strict conventions — see [integration-tests.md](integration-tests.md).

## Layer 3 — Eval

Eval suites for LLM-as-judge / deterministic-output comparisons. Currently lightweight — basic regressions only. Heavier eval infrastructure (recorded fixtures, plug-matrix property tests, contract auto-tests, coverage gates, cross-version CI) is explicitly out of scope for v1.

When evals exist they live in `test/eval/` or `__evals__/` and run as a separate job (not gated by PR).

## Which layer for what

| You're changing                                       | Right layer                                           |
| ----------------------------------------------------- | ----------------------------------------------------- |
| The shape of `getTools` output                        | Layer 1                                               |
| Manifest validation logic                             | Layer 1                                               |
| A tool's input parsing                                | Layer 1                                               |
| A middleware's `beforeModel` mutation                 | Layer 1 (or 2 if it interacts with Matrix)            |
| Boot resolves plugins correctly given features        | Layer 1 (it has unit coverage already)                |
| End-to-end "I send a message, the agent calls Memory" | Layer 2                                               |
| New bundled plugin (any plugin)                       | Layer 1 minimum, plus Layer 2 if it talks to upstream |
| Behavioural change in the agent's response quality    | Layer 3 (when we have it)                             |

## What CI runs

Per PR:

- `pnpm lint` — strict; failures block merge.
- `pnpm format:check` — strict; failures block merge.
- `pnpm test` — Layer 1, runs in all packages.
- `pnpm build` — typecheck + emit.

Layer 2 integration tests run on a separate job that requires `.env.integration` secrets — see [ci.md](ci.md).

## Read next

- [Test harness](test-harness.md) — `createTestRuntime` reference.
- [Integration tests](integration-tests.md) — patterns and rules.
- [CI](ci.md) — what gets gated where.

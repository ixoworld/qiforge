# Integration Testing & Evals — QiForge Runtime

**Status:** Draft for review
**Author:** Yousef + Claude
**Last updated:** 2026-05-18
**Related:** `specs/ORA-219-plugin-based-runtime.md`, `specs/agent-evaluations.md` (research), `packages/oracle-runtime/src/testing/`
**Scope:** `@ixo/oracle-runtime` package + `apps/qiforge-example` reference oracle

---

## 1. Three things this test suite must do

Every test in this suite earns its place by answering **yes** to at least one of these:

1. **System bulletproof on each change** — would this test catch a wiring/integration regression that would otherwise hit production?
2. **Agent bulletproof on each deploy** — would this test catch a behavioral drift the model would otherwise cause?
3. **Reference template for oracle developers** — is this test something a future oracle developer should copy when building their own agent? The `qiforge-example` integration tests double as canonical documentation for how to test any QiForge oracle. They must be readable, self-explanatory, and structured for someone reading them for the first time.

If a test would pass when production is broken, or fail when production works fine, we don't write it. No "the tool is registered" boilerplate — that's what unit tests are for.

---

## 2. The three-tier insight (this is the spec's spine)

We split into three tiers because each catches a different class of bug, costs a different amount, and runs on a different cadence.

| Tier | What it answers | Cost | Cadence | Reliability |
|---|---|---|---|---|
| **A. Direct-invoke** | "Does our integration with the upstream service work?" | $0 (no LLM) | Every PR | Deterministic |
| **B. Agent-loop** | "Does the agent pick the right tool for this user input?" | ~$ per run | Every PR (gated) + pre-deploy | Smart-enough cheap model |
| **C1. Trajectory eval** | "Did the agent call the right tools in the right shape?" | $0 (no judge LLM) | Every PR | Deterministic via `agentevals` |
| **C2. Judge eval** | "Has reasoning quality drifted vs. the reference set?" | $$ per run | Pre-deploy + nightly | Production model + LLM-as-judge |

### Why the split matters

The naive approach — only Tier B — is bad. If a Memory Engine endpoint returns 500, a Tier B test fails *because the model couldn't recall a memory*, not *because Memory Engine is down*. You spend the next hour blaming the model.

Tier A invokes the plugin's tool directly (no LLM, no agent, no system prompt) with a real `RuntimeContext` and a real UCAN delegation against the real upstream. If it fails, the integration is broken — period. This catches 80% of what would otherwise be flaky Tier B failures, for ~$0.

Tier B then only needs to answer one question: "given this user input, did the model pick the right tool?" — knowing the tool itself is already verified.

Tier C is qualitative — trajectory match + LLM-as-judge — and runs pre-deploy only.

---

## 3. What's in scope and what isn't

### In scope
- **Bundled plugins**: memory, sandbox, skills, composio, firecrawl, agui, credits, user-preferences, domain-indexer.
- **App-level plugin**: weather (the example oracle's own).
- **Runtime boot**: env validation, plugin loader, auto-detect gates, UCAN auth, route exclusions, SSE streaming, abort.
- **Agent behavior**: tool routing, memory recall, multi-turn coherence, capability gating.
- **Evals**: trajectory match (deterministic) + LLM-as-judge (qualitative).

### Explicitly out of scope
- **Editor plugin**: needs seeded BlockNote + Matrix room state, brittle and heavy. Defer.
- **Portal plugin**: covered transitively by agent scenarios; no dedicated tests.
- **Slack plugin**: needs a live workspace; manual smoke only.
- **NestJS framework correctness**: it works; testing it adds no value.
- **Matrix / blocksync / chain internals**: assume available.
- **Upstream service internals** (Memory Engine internals, Sandbox internals): test our contract with them, not their guts.

---

## 4. How we actually test — the strategy

Three things must hold for us to ship with confidence:

1. **Every plugin's contract with its real upstream service works.** Memory Engine, Sandbox MCP, Skills, Composio, Firecrawl — when our code calls them, they respond the way the plugin expects.
2. **The agent picks the right tool for the right user input.** Manifests, system prompt, and the model all agree on what gets called when.
3. **(1) and (2) keep holding as we change code, swap models, and update prompts.**

We solve these in order, each with a different approach. The point of the three tiers (§2) is that each tier answers exactly one of these questions, so when a test fails we know *why*.

### 4.1 Tier A — testing plugins against real upstreams (no model involved)

**The question:** if I call this tool with these args, does the upstream behave as the plugin expects?

**The approach:** spin up the runtime with **real** ambient services — real LLM provider config, real UCAN signer, real fetch — and build a real `RuntimeContext` for a test user DID with a real UCAN delegation. Then call the plugin's tool **directly**. No model. No agent loop. No HTTP layer. Just: `await runtime.invokeTool('memory-engine__add_memory', { content: '...' })`.

This catches all the failure modes that have nothing to do with the model:
- Wrong UCAN headers reaching the upstream
- Broken `autoDetect` gates excluding the wrong plugins
- Schema drift between the plugin and the upstream
- Upstream API changes
- Env vars not threaded through correctly

**Walked-through example — memory plugin:**

1. Bootstrap a test runtime with `MemoryPlugin` loaded and a real LangChain/UCAN config.
2. Mint a UCAN delegation for the test user, scoped to `memoryCap` only.
3. Call `memory-engine__add_memory` with `{ content: 'user prefers dark mode' }`. **Expect:** upstream returns success.
4. Call `memory-engine__search_memory_engine` with `{ query: 'dark mode' }`. **Expect:** upstream returns a record matching what we just wrote.
5. Repeat step 3 with a delegation **missing** `memoryCap`. **Expect:** clean 401/403, no 500 crash.

If any of those fail, the memory plugin is broken — independent of the model, independent of the system prompt. **This is the cheapest, most reliable signal we have, and it should make up the majority of plugin tests.**

What we test per plugin (Tier A only — Tier B is in §4.2):

| Plugin | Tier A scenarios (plain language) |
|---|---|
| **memory** | Write a fact → upstream returns success. Search for that fact → upstream returns it. Different user can't see it. Missing capability returns a clean auth error. |
| **sandbox** | Run `echo hello` → stdout is `hello`. Write multiline markdown via `sandbox_write_file`, then `cat` it back → byte-identical. Per-user secret seeded via `seedSecrets` is reachable inside the sandbox as an env var. `oracle_*` tools hidden by default. |
| **skills** | `search_skills` for a known fixture capsule → returns at least one result with `cid` + `path`. `list_skills` orders private-first, then public. |
| **firecrawl** | Scrape a stable URL → response body contains a known substring. |
| **composio** | List Composio connections → our test Linear account shows up. Create a Linear issue → it appears in the workspace. Teardown deletes it. Missing capability → clean auth error. |
| **user-preferences** | PUT a preference → GET reads it back. Unknown key → 400. |
| **credits** | Authenticated request increments the Redis ledger. `DISABLE_CREDITS=true` → no writes. |
| **domain-indexer** | Look up a known devnet entity DID → returns non-empty data. |
| **weather** | Direct `get_current_weather` for Berlin → temperature is a number. `WEATHER_DEFAULT_UNITS=fahrenheit` → values are in Fahrenheit. |

### 4.2 Tier B — testing agent behavior against the full oracle

**The question:** given this user message, does the agent pick the right tool and respond sensibly?

**The approach:** boot the full QiForge oracle (`createOracleApp`) on an ephemeral port with all the plugins loaded, then drive it the way a real client does — `POST /messages/:sessionId` with a real UCAN header. The harness exposes `ChatClient.send(...)` and `ChatClient.stream(...)` so tests look like a real frontend would. **Assertions are structural** — "the response message list contains an `AIMessage` with a tool call to `get_current_weather` with `city='Berlin'`." Never on exact text (the model varies output every call).

This catches:
- Manifest drift (the model now picks the wrong tool because we changed a `whenToUse` line)
- Tier-1 prompt regressions
- Broken tool-call argument schemas
- SSE streaming bugs (event order, abort handling)
- Cross-plugin interference (memory eats the tool call that should have gone to weather)
- **On-demand plugin loading**: for plugins with `visibility: 'on-demand'` (composio, firecrawl, agui, portal, editor, weather), the agent's tools are NOT bound at boot. The agent must call `list_capabilities` to discover them, then `load_capability({ name })` to bind them, before any of that plugin's tools are callable. Tier B verifies the agent does this correctly — if the manifest's `whenToUse` is unclear, the agent skips the load and the test fails.

**Walked-through example — weather plugin:**

1. Boot the example oracle on an ephemeral port with the full bundled plugin set.
2. Mint a UCAN with all capabilities.
3. Send `"What's the weather in Berlin?"` via `ChatClient.send()`.
4. **Assert** the returned message list contains an `AIMessage` with `tool_calls[0].name === 'get_current_weather'` and `tool_calls[0].args.city === 'Berlin'`.
5. **Assert** the final `AIMessage` text is non-empty and isn't a refusal.

If this fails, either the manifest no longer tells the model to use this tool, or the tool schema mismatches what the model produces. Both are real regressions worth blocking the PR.

Agent-behavior scenarios we run on top of Tier A (plain language):

| Scenario | What it proves |
|---|---|
| "Weather in Berlin?" → `get_current_weather` called with Berlin | Tool routing for the simplest case |
| "Forecast for Tokyo this week" → `get_weather_forecast` with `days=7` | Multi-arg tool selection |
| "What's my name?" → NO weather tool called | False-positive guard |
| "Remember I prefer dark mode" → `add_memory` called | Memory write routing |
| New session, same user → "What do you remember about my preferences?" → response mentions dark mode | Memory persistence across sessions |
| "Find a skill for X and run it" → `search_skills` then `sandbox_run` | Two-tool composition |
| "Create a Linear issue titled Foo" → `linear_create_issue` called | Composio routing |
| Stream a long query, abort mid-stream, send a follow-up | Streaming + abort hygiene |
| Send a request with a UCAN scoped to memory only, ask for sandbox | Agent declines cleanly, no crash |

Each is one test. None chain six LLM calls. Each fails for a specific, knowable reason.

### 4.3 Tier C — evals as continuous quality monitoring

**The question:** has the agent's behavior drifted vs. a known-good reference set over time?

**The approach:** maintain ~10 reference conversations, each a `(user_input, expected_trajectory)` pair stored as TypeScript modules. Every release re-runs them and compares two ways:

- **Trajectory match** (deterministic, free, runs on PR): does the agent call at least the same tools as the reference, in the right shape? Uses `agentevals` library's `createTrajectoryMatchEvaluator`. Catches *structural* drift.
- **LLM-as-judge** (≈$0.20/run, pre-deploy only): does the agent's reasoning still make sense to a separate "judge" model (gpt-4o-mini) given the user input + reference? Uses `createTrajectoryLLMAsJudge`. Catches *reasoning* drift the structural matcher misses.

Both upload to LangSmith automatically (when env vars are set). Over time we get a dashboard: pass rate per case, cost/latency per release, full history. We notice "the memory-recall case went from passing to failing in release X" the moment it happens.

**Walked-through example — memory-recall eval case:**

The reference trajectory (stored as `golden-trajectories/memory-recall.ts`):
```
User: "remember my name is Sara"
Agent: [tool_call: memory-engine__add_memory with content="user name is Sara"]
Tool:  success
Agent: "Got it, Sara."
[new session]
User: "what's my name?"
Agent: [tool_call: memory-engine__search_memory_engine with query="user name"]
Tool:  [{ content: "user name is Sara" }]
Agent: "Your name is Sara."
```

Eval run:
1. Send the same user inputs through `ChatClient.send()` against the real oracle.
2. Capture the agent's actual message list.
3. Run trajectory-match (`superset` mode): does the actual trajectory contain at least the two tool calls in the reference? Boolean pass/fail.
4. Run the judge (with the reference): is the agent's reasoning consistent with the reference? Boolean pass/fail.
5. Both results upload to LangSmith automatically as a new experiment run linked to this dataset.

If a future code change causes the agent to skip the memory-search call, trajectory match fails. If the agent still calls it but the final message is weird, the judge fails. We catch both.

**Human review (Phase 9E)** sits on top: when 9B fails pre-deploy, a human reviews the failing traces in LangSmith using the rubric we defined (`accuracy` 0-1, `correctness` pass/fail, freeform `notes`). Their notes feed back into the next iteration of golden trajectories. This closes the loop between automated detection and the curated reference set.

### 4.4 State isolation — keep it simple

The user DID is whatever we put in the minted UCAN — so isolation is already controllable, no special infra needed. The rule:

- **Tests that write persistent upstream state clean up after themselves.** Memory writes are bounded by sessionId (one test = one session = one bucket). Linear issues are scoped to one test team and named `IntegrationTest-<timestamp>-<uuid>` so teardown is unambiguous. Sandbox files under `/workspace/data/` get cleaned by an explicit `sandbox_run rm` in afterEach for tests that wrote there.
- **Tests that don't write persistent state need nothing.** They're already isolated by sessionId.

No ephemeral DIDs, no per-test mnemonics, no harness magic. Just: if a test writes, that test cleans.

### 4.5 What each tier doesn't test (so we know when to look elsewhere)

- **Tier A doesn't test the model.** A passing Tier A test tells us the plugin works against the upstream. It says nothing about whether the agent will actually pick the tool.
- **Tier B doesn't test the upstream.** A failing Tier B test could mean the upstream is down, not that the agent is wrong. That's why Tier A runs first — it isolates upstream issues from agent issues.
- **Tier C doesn't catch new behaviors.** Evals only detect drift from the reference set. Genuinely new bugs in code paths the reference doesn't exercise won't show up here. That's what Tier A and Tier B are for.

The three tiers cover what the others miss. The whole stack is the test signal — none of the layers is sufficient alone, and that's the point.

---

## 5. Where the code lives

```
packages/oracle-runtime/
├── src/testing/integration/              ← exported via "@ixo/oracle-runtime/testing"
│   ├── harness.ts                        ← createIntegrationOracle(), createIntegrationRuntime()
│   ├── chat-client.ts                    ← HTTP + SSE client
│   ├── ucan.ts                           ← mintUserDelegation + capability constants
│   ├── setup.ts                          ← vitest setupFile: dotenv/config + expect.extend(langchainMatchers)
│   └── index.ts
├── src/plugins/<plugin>/<plugin>.plugin.int.test.ts        ← Tier A + Tier B per plugin
├── test/integration/runtime-boot.int.test.ts               ← Tier A: boot/env/auth
└── test/integration/llm-baseline.int.test.ts               ← Tier B: model smoke

apps/qiforge-example/
└── test/integration/
    ├── weather.int.test.ts               ← the app's own plugin
    ├── agent-scenarios.int.test.ts       ← cross-plugin Tier B
    └── evals/
        ├── trajectory.eval.ts            ← Tier C: agentevals trajectory match
        └── judge.eval.ts                 ← Tier C: LLM-as-judge
```

**Naming:**
- `*.int.test.ts` — Tier A + B; run via `pnpm test:integration` (vitest `--mode int`).
- `*.eval.ts` — Tier C; run via `pnpm eval` (vitest `--mode eval`).
- Default `pnpm test` ignores both — unit tests stay fast.

**Why plugin tests live in the package, not the app:** plugins are owned by the package, so their tests are too. The package exports the harness so any consuming oracle (qiforge-example today, others later) can use the same APIs to test its own plugins and agent behavior.

---

## 6. Test surface exported from `@ixo/oracle-runtime/testing`

### `createIntegrationRuntime(opts)` — Tier A entry point

Like the existing `createTestRuntime()` but with **real ambient services** (real LLM provider, real UCAN, real Matrix, real upstream fetches). Returns:

```ts
{
  invokeTool(name, args)              // direct tool call with real RuntimeContext
  invokeSubAgent(name, task)          // direct sub-agent call
  invokeMiddleware(name, state)       // direct middleware fire
  ambient                             // real ambient bag for advanced cases
  close()
}
```

Use case: "call `memory-engine__add_memory` directly against the real Memory Engine; assert it returned success." No model, no agent loop, no flakiness.

### `createIntegrationOracle(opts)` — Tier B entry point

Boots `createOracleApp` on an ephemeral port with `.env.integration` loaded. Returns:

```ts
{
  baseUrl                             // http://localhost:<ephemeral>
  app                                 // OracleApp handle
  events                              // log of onPluginStatusChange + onError
  status()                            // shortcut to app.plugins.status()
  close()
}
```

Always installs `MainAgentHooks.resolveModel` that swaps roles to the test model map (§7). Caller can override per test.

**No `skipMatrixInit`, no `skipGracefulShutdown`, no "matrix on/off" mode.** Integration tests boot the real stack the same way production does. If Matrix is unreachable, the test fails — that failure IS the signal.

### `mintUserDelegation({ userMnemonic, oracleDid, capabilities, ttlSec })`

Produces a real Ed25519-signed UCAN delegation string for `x-ucan-delegation`. Capability constants exported:

```ts
import {
  memoryCap, sandboxCap, skillsCap, subscriptionsReadCap, allCaps,
} from '@ixo/oracle-runtime/testing';
```

**Composio uses `sandboxCap`, not a separate cap.** No `composioCap` exists. UCAN failure tests pass a narrower capability set — e.g. `capabilities: [memoryCap]` to a sandbox test → expect a clean auth error.

### `ChatClient(baseUrl, { delegation, timezone? })`

```ts
send(sessionId, message, opts?) → { text, toolCalls, messages, durationMs }
stream(sessionId, message, opts?) → AsyncIterable<SSEEvent> + final summary
list(sessionId)
abort(sessionId)
fetch(path, init?)                    // raw, for plugin HTTP routes
```

### `setup.ts` (the only test infrastructure we ship beyond the three modules above)

A 3-line vitest setupFile, referenced from `vitest.config.ts`:
```ts
import 'dotenv/config';
import { expect } from 'vitest';
import { langchainMatchers } from '@langchain/core/testing';
expect.extend(langchainMatchers);
```

Plus `.env.integration` loaded via dotenv (config calls `dotenv.config({ path: '.env.integration' })` after the default `.env` load).

### Everything else: use vitest as-is

- **Skipping when env missing**: `test.skipIf(!process.env.X)('...', ...)`. No `it.requires()` wrapper.
- **Multi-step tests**: just `await` calls in sequence inside one `test()`. No `runScenario` DSL.
- **Custom matchers**: only when a test actually needs one. Add inline in `setup.ts`. We're not pre-building `toContainPluginToolCall` etc. until a test reaches for it.
- **Failure output**: vitest already prints assertion context. LangSmith auto-syncs the trace when env vars are set — that's our debugging path. No custom dump module.
- **Reference trajectories**: plain TypeScript modules exporting `inputs` + `referenceOutputs`. No `defineGoldenTrajectory` helper needed.

---

## 7. Model strategy — cheap but not stupid

The hard constraint: tests must fail **only** when production is broken, not when the model is too dumb to follow instructions. A model that's so cheap it can't reliably call tools makes our test signal worthless.

### Two model tiers

**PR tier** (Tier B on PRs) — proven smart enough to drive this codebase, cheaper than production:

| Role | Production | PR-tier test |
|---|---|---|
| `main` | `moonshotai/kimi-k2.6` | `moonshotai/kimi-k2.5` (production *subagent* model — already proven to call tools in this codebase) |
| `subagent` | `moonshotai/kimi-k2.5` | `openai/gpt-oss-120b` |
| `routing` | `openai/gpt-oss-20b` | unchanged |
| `guard` / `session-title` | `meta-llama/llama-3.1-8b-instruct` | unchanged |
| `vision` | `gemini-2.5-flash-lite` | unchanged |

Rationale: `gpt-oss-20b` was tempting but is known to drop tool calls on multi-step routing. `kimi-k2.5` is what production uses for sub-agents *today* — it's battle-tested in this codebase. Using it for the test `main` role gives us "cheaper than production but proven smart enough."

**Pre-deploy tier** (Tier B pre-release + Tier C) — production models exactly, so we catch behavior that only shows up with the production model:

| Role | Model |
|---|---|
| `main` | `moonshotai/kimi-k2.6` |
| `subagent` | `moonshotai/kimi-k2.5` |
| Judge (Tier C) | `openai/gpt-4o-mini` (cheap, well-calibrated). Fallback to `openai/o3-mini` if accuracy is insufficient |

### Cost controls (apply everywhere)

- `maxTokens: 512` on test invocations unless the scenario specifically needs more.
- **Structural assertions only** — `toContainToolCall({ name: 'get_current_weather' })`, never `expect(text).toBe('It is 22°C…')`.
- One test = one behavior. No mega-tests chaining six LLM calls when two will do.
- Tier A wherever possible. If a test can answer its question without the LLM, it must.

### Rough budget

- **Tier A (PR)**: $0. No LLM. Should be the majority of plugin tests.
- **Tier B (PR)**: Target < $1 per full run. Maybe 10-15 scenarios × a few hundred tokens.
- **Tier C1 trajectory (PR)**: $0. `agentevals` trajectory match runs deterministic comparisons — no judge LLM call.
- **Tier C2 judge (pre-deploy)**: Target < $0.20 per full run. 10 cases × `gpt-4o-mini` judge × `maxTokens: 512`.

We'll measure the first run and adjust. If a single scenario costs more than ~5 cents, it gets reviewed.

---

## 8. Implementation order — phased TODO list

Each phase ships independently and is mergeable on its own. Don't start phase N+1 until phase N is green in CI. **Order is intentional: foundation first, then easy plugins, then harder, then cross-plugin scenarios, then evals.**

### Phase 0 — Harness foundation (no tests; sets up the surface)

- [ ] **0.1** Scaffold `packages/oracle-runtime/src/testing/integration/` and export it via the existing `./testing` subpath.
- [ ] **0.2** Add `vitest --mode int` and `vitest --mode eval` blocks to both vitest configs; include `**/*.int.test.ts` / `**/*.eval.ts`; raise timeout to 120s; load `.env.integration` via `dotenv/config`.
- [ ] **0.3** Add `pnpm test:integration` and `pnpm eval` scripts in both packages + root turbo pipeline.
- [ ] **0.4** Implement `createIntegrationOracle()` + ephemeral-port `start()`.
- [ ] **0.5** Implement `createIntegrationRuntime()` (Tier A entry; real ambient services).
- [ ] **0.6** Implement `mintUserDelegation()` against `@ixo/ucan` — follows the exact pattern in the user-provided UCAN recipe: `signerFromMnemonic(TEST_USER_MNEMONIC, TEST_USER_DID)` → `createDelegation({ issuer, audience: oracleDid, capabilities, expiration: now+7d })` → `serializeDelegation()`. **Capability constants** exported from the harness as typed records (`can`/`with` shape per `@ixo/ucan` spec):
  - `memoryCap` = `{ can: 'memory/*', with: 'ixo:memory' }`
  - `sandboxCap` = `{ can: 'sandbox/*', with: 'ixo:sandbox' }` — covers Composio too (composio routes through sandbox infra)
  - `skillsCap` = `{ can: 'skills/*', with: 'ixo:skills' }`
  - `subscriptionsReadCap` = `{ can: 'subscriptions/read', with: 'ixo:subscriptions' }`
  - `allCaps` = all of the above
  - Expiration: Unix **seconds**, default `now + 7 days`. Critical: `@ixo/ucan` uses seconds, not ms — recipe explicitly calls this out.
- [ ] **0.7** Implement `ChatClient` (typed thin wrapper: `send`, `stream` with SSE parsing + abort, `list`, `abort`, raw `fetch` for plugin routes).
- [ ] **0.8** Write `setup.ts` (3 lines): `import 'dotenv/config'` → `dotenv.config({ path: '.env.integration' })` → `expect.extend(langchainMatchers)`. Reference it from `vitest.config.ts` `setupFiles`.
- [ ] **0.9** Create `.env.integration.example` with every key the harness reads; gitignore the real file (already covered by repo-root `.env.*`).

**Done when:** a hello-world `.int.test.ts` can boot the real oracle (no skipMatrixInit), mint a delegation, hit `/health`, and tear down — without touching any plugin yet.

---

### Phase 1 — Runtime boot (Tier A; no LLM, no upstream services) — ~5s

File: `packages/oracle-runtime/test/integration/runtime-boot.int.test.ts`

What changes are caught here: env schema regressions, plugin loader bugs, auth-exclusion drift, UCAN validator wiring.

- [ ] **1.1** Boot with full bundled set + valid `.env.integration` → `status().loaded` includes every plugin whose env is present; `status().excluded` lists the rest with the right `autoDetectHint` reason.
- [ ] **1.2** Remove `MEMORY_MCP_URL` → memory plugin excluded, nothing else affected.
- [ ] **1.3** Remove `OPEN_ROUTER_API_KEY` and `NEBIUS_API_KEY` → env validation fails with a message pointing at LLM provider.
- [ ] **1.4** Request with no `x-ucan-delegation` → 401 on `/messages/:id`.
- [ ] **1.5** Delegation issued for a different `oracleDid` → 401 with `audience` mismatch.
- [ ] **1.6** Expired delegation → 401 with expired reason.
- [ ] **1.7** `GET /health`, `GET /docs`, `GET /version`, `GET /weather/now?city=Berlin` reachable without `x-ucan-delegation`.

**Error paths (small, focused — not exhaustive):**
- [ ] **1.8** Upstream returns 5xx mid-tool-call → agent surfaces an error message in its response, no 500 from the runtime, no hung stream.
- [ ] **1.9** Model emits a malformed `tool_calls[].args` (fails Zod parse) → runtime returns a structured tool error, agent gets a chance to retry, no crash.
- [ ] **1.10** Long stream aborted mid-flight via `POST /messages/abort` → SSE connection closes cleanly, next request on the same session works.
- [ ] **1.11** Request times out (server side) → response surfaces a timeout error, not a hung connection.

**Done when:** deliberately breaking an env schema field is caught by 1.1–1.3; deliberately throwing a 503 from one upstream is caught by 1.8 without taking the rest of the app down.

**Capability-loading meta-tools (covered here because they're runtime-level, not plugin-level):**

The runtime ships two unnamespaced meta-tools used to discover and bind on-demand plugins: `list_capabilities` and `load_capability({ name })`. These mediate the entire on-demand-plugin flow, so any regression in them breaks every on-demand plugin silently. We test them once, here, and trust them elsewhere.

- [ ] **1.12** [Tier A] Direct-invoke `list_capabilities({})` → returns a list including every loaded plugin with `loaded: true|false` and the right `visibility` for each. On-demand plugins appear with `loaded: false` until explicitly loaded; `'silent'` plugins are excluded by default.
- [ ] **1.13** [Tier A] Direct-invoke `load_capability({ name: 'firecrawl' })` against a fresh runtime → returns the manifest + bound tools list; `state.loadedPlugins` now contains `firecrawl`.
- [ ] **1.14** [Tier A] `load_capability({ name: 'does-not-exist' })` → throws with a message naming the missing plugin and suggesting `list_capabilities`.
- [ ] **1.15** [Tier A] `load_capability({ name: 'credits' })` (a `silent` plugin) → throws cleanly, doesn't bind.
- [ ] **1.16** [Tier B] Agent-loop test: "What can you do?" → agent calls `list_capabilities`, summary includes at least the always-on plugins. (Catches manifest regressions affecting agent self-description.)

---

### Phase 2 — Example app boots + Weather plugin (Tier A + Tier B; free upstream) — ~20s

Files:
- `apps/qiforge-example/test/integration/boot.int.test.ts` — the one boot smoke
- `apps/qiforge-example/test/integration/weather.int.test.ts` — plugin + agent loop

**Example-app boot test — proves the app itself, as configured, comes up clean:**

- [ ] **2.0** Boot `qiforge-example` via `createIntegrationOracle()` using the app's own plugin list. Assert: server listens, `/health` returns 200, `app.plugins.status().loaded` contains every plugin we expect in this app (memory, sandbox, skills, weather, …), `/version` returns the right name/description. This is the test other oracle developers will copy and rename when they fork the example.

Open-Meteo is free + public, no UCAN, no MCP. Best first agent-loop test — proves the chat → model → tool → response loop works before we add paid services.

**Tier A (no LLM):**
- [ ] **2.1** Direct-invoke `get_current_weather` with `{ city: 'Berlin' }` → returns a temperature number.
- [ ] **2.2** Direct-invoke `get_weather_forecast` with `{ city: 'Tokyo', days: 7 }` → returns 7 daily entries.
- [ ] **2.3** `GET /weather/now?city=Berlin` with `WEATHER_DEFAULT_UNITS=fahrenheit` env → Fahrenheit values in response.

**Tier B (with LLM):**
- [ ] **2.4** "What's the weather in Berlin?" → agent calls `get_current_weather` with `{ city: 'Berlin' }`.
- [ ] **2.5** "Forecast for Tokyo this week" → agent calls `get_weather_forecast` with `days: 7`.
- [ ] **2.6** Multi-turn shared state: ask Berlin weather, then "is it warmer than what I asked last about Tokyo?" → agent reads `lastWeatherQuery` shared state.
- [ ] **2.7** Anti-false-positive: "What's my name?" → agent does NOT call any weather tool.
- [ ] **2.8** Streaming: query Berlin via `stream()` → SSE emits `tool_call` events before final `ai_message`.

**Done when:** a deliberate manifest title swap that would mislead the model is caught by 2.4 or 2.5.

---

### Phase 3 — Memory plugin — ~30s

File: `packages/oracle-runtime/src/plugins/memory/memory.plugin.int.test.ts`

Requires: live Memory Engine on devnet, real test user mnemonic.

**Tier A (no LLM):**
- [ ] **3.1** Direct-invoke `memory-engine__add_memory` with a fact → upstream returns success.
- [ ] **3.2** Direct-invoke `memory-engine__search_memory_engine` for that fact → upstream returns it.
- [ ] **3.3** Direct-invoke with a delegation missing `memoryCap` → upstream returns 401/403; harness surfaces a clean error (not a 500 crash).
- [ ] **3.4** Direct-invoke as a different user DID → cannot see user A's memories.

**Tier B (with LLM):**
- [ ] **3.5** "Remember I prefer dark mode" → calls `memory-engine__add_memory`.
- [ ] **3.6** New session, same user → "what do you remember about my preferences?" → response mentions dark mode.
- [ ] **3.7** First-contact flow: brand new user DID, first message → memory middleware fires the introduction path per the manifest's `whenToUse[0]`.

**Done when:** a regression where Memory Engine returns memories but the middleware fails to inject them into the prompt is caught by 3.6.

---

### Phase 4 — Sandbox + Skills plugins — ~60s

Files: `sandbox.plugin.int.test.ts`, `skills.plugin.int.test.ts`

**Sandbox Tier A:**
- [ ] **4.1** Direct-invoke `sandbox_run` with `echo hello` → stdout is `hello`, `exitCode === 0`.
- [ ] **4.2** Direct-invoke `sandbox_write_file` with multiline markdown → follow-up `sandbox_run` (`cat`) returns byte-identical content.
- [ ] **4.3** Per-user secret seeded via `seedSecrets()` is reachable inside the sandbox as `x-us-*` → `$USER_*` env var (verify via `printenv`).
- [ ] **4.4** `oracle_*` management tools are NOT in the tool list by default; present when `includeOracleManagementTools: true`.

**Skills Tier A:**
- [ ] **4.5** Direct-invoke `search_skills` with a query matching a fixture capsule → returns at least one result with `cid` and `path`.
- [ ] **4.6** Direct-invoke `list_skills` → caller's private skills first, then public.

**Sandbox + Skills Tier B (composition — the high-value test):**
- [ ] **4.7** "Find a skill for X and run it" → agent calls `search_skills`, then `sandbox_run` with the returned cid; `exitCode === 0`.

**Done when:** a regression where Sandbox stops injecting `x-us-*` headers (which would silently break every secret-using skill) is caught by 4.3.

---

### Phase 5 — User-preferences, Firecrawl, Credits, Domain-Indexer — ~60s each

**User-preferences:**
- [ ] **5.1** [Tier A] PUT `/user-preferences` then read back → returns the same data.
- [ ] **5.2** [Tier B] Set preference "always respond in bullet points" → next chat response is bulleted.
- [ ] **5.3** [Tier A] Unknown preference key → 400.

**Firecrawl:**
- [ ] **5.4** [Tier A] Direct-invoke firecrawl scrape on a stable URL → response contains a known substring.
- [ ] **5.5** [Tier B] "Scrape https://docs.langchain.com/llms.txt" → agent calls firecrawl, response mentions a known section.

**Credits** (only if Redis is up):
- [ ] **5.6** [Tier A] Direct-invoke credits middleware on a synthesized request → ledger increments by ≥ 1.
- [ ] **5.7** [Tier A] Claim record created with correct user DID and amount.
- [ ] **5.8** [Tier A] `DISABLE_CREDITS=true` → no ledger writes.

**Domain-Indexer:**
- [ ] **5.9** [Tier A] Direct-invoke indexer tool with a known devnet entity DID → returns non-empty data.
- [ ] **5.10** [Tier B] "What is entity did:ixo:entity:X?" → agent calls indexer.

---

### Phase 6 — Composio behavior (NOT real third-party state) — ~30s

File: `composio.plugin.int.test.ts`

**What we're testing here is different from the other plugins, and that's intentional.** Composio itself is a stable third-party service — we don't need to prove it can create Linear issues; that's their job. What we DO need to prove is that the agent behaves correctly around an unconnected toolkit: it must call the real `COMPOSIO_MANAGE_CONNECTIONS` tool to get a connection URL from Composio, then surface *that exact URL* — not hallucinate one. This is the "does the agent actually use the tool when it needs info, vs. making things up" test.

**Key facts from the plugin's manifest:**
- Composio is `visibility: 'on-demand'` — the agent must call `load_capability('composio')` before any Composio tool is available.
- `COMPOSIO_MANAGE_CONNECTIONS` is a single tool that both **checks auth status** and **returns a redirect URL** if not connected (one tool, not two).
- Returns `{ redirect_url: 'https://...' }` when the user isn't connected to the requested toolkit.
- Plugin uses the `ixo:sandbox` UCAN capability (composio routes through the sandbox infra), NOT a separate `composio` capability.

**Scenarios:**

- [ ] **6.1** [Tier A] Direct-invoke flow against real Composio with a test user that's NOT connected to a chosen toolkit (e.g. `linear`). Call the plugin's `COMPOSIO_MANAGE_CONNECTIONS` tool with `{ toolkit: 'linear' }`. Assert: response shape is `{ redirect_url: <a real https URL pointing at Composio's domain> }`. No exceptions, no hallucination — it's a direct tool call, so this is just verifying the SDK contract.

- [ ] **6.2** [Tier B] The behavior scenario — the one this whole phase exists for. With a fresh session, ask the agent: *"Create a Linear issue titled 'Foo'."*
  Expected trajectory:
    1. Agent calls `list_capabilities` OR knows composio is on-demand and calls `load_capability({ name: 'composio' })` directly.
    2. Agent calls `COMPOSIO_MANAGE_CONNECTIONS({ toolkit: 'linear' })`.
    3. The tool returns `{ redirect_url: <real URL> }`.
    4. Agent's final message contains *that exact URL* — substring-match the URL from the tool response against the final AIMessage text.
  Assertion that proves no hallucination: `expect(finalText).toContain(redirectUrlFromToolMessage)`. The URL in the final message is byte-equal to the URL in the ToolMessage above it.

- [ ] **6.3** [Tier B] Negative: ask the agent to create a Linear issue with a delegation **missing** the `ixo:sandbox` capability. Expected: agent surfaces the auth limitation cleanly; does NOT pretend it succeeded. No `linear_create_issue` call.

- [ ] **6.4** [Tier B] False-positive guard: ask the agent something unrelated to Composio (e.g. "What's the weather?"). Expected: agent does NOT call `load_capability('composio')`.

**No cleanup needed** — we never actually create an issue. The flow stops at the connect-URL step.

**Done when:** the agent's final message contains a URL that was provably returned by `COMPOSIO_MANAGE_CONNECTIONS`, not a URL the model invented.

---

### Phase 7 — AG-UI plugin — ~20s

- [ ] **7.1** [Tier B] Send a chat with declared `agActions: [{ name: 'render_table', ... }]` → SSE stream emits a `RenderComponentEvent` with the table payload.
- [ ] **7.2** [Tier A] Same chat with no `agActions` → AG-UI sub-agent is NOT built (verify via tool list inspection on the running agent).

---

### Phase 8 — Cross-plugin agent scenarios (in qiforge-example) — ~3min

File: `apps/qiforge-example/test/integration/agent-scenarios.int.test.ts`

This is the bulletproof-agent layer. Each scenario exercises real model judgment on the full bundle. **Tier B only — no Tier A here by design.**

- [ ] **8.1** Tool routing sanity matrix (8-12 user inputs × expected tool). Catches manifest drift and Tier-1 prompt regressions.
- [ ] **8.2** Memory recall across sessions (full bundle loaded, catches cross-plugin interference).
- [ ] **8.3** Skill discovery → execution chain end-to-end.
- [ ] **8.4** Capability denied gracefully: narrow UCAN to weather only; ask for memory → agent declines/explains, doesn't crash.
- [ ] **8.5** Streaming + abort: long generation, abort mid-stream, no leaked SSE; next request on same session works.
- [ ] **8.6** System prompt size regression guard: with all bundled plugins loaded, composed system prompt is under N tokens.

---

### Phase 9 — Evals pipeline — split cadence

Install (requires `langsmith>=0.3.1` for the vitest integration):
```
pnpm add -D agentevals openevals langsmith dotenv
```

**Two evaluator packages, complementary roles:**
- `agentevals` — judges *trajectories* (message sequences, tool-call shape/order). Used in 9A for deterministic structural match, and in 9B for trajectory-quality LLM judgment.
- `openevals` — judges *single outputs vs. references*. Comes with prebuilt prompts (`CORRECTNESS_PROMPT`, etc.). Used in 9B for **final-answer correctness** as a separate feedback signal from the trajectory judge. This catches "agent called the right tools but the final message to the user is wrong/confusing" — a class trajectory match alone cannot catch.

#### File layout
```
apps/qiforge-example/
├── ls.vitest.config.ts              ← LangSmith-aware vitest config (separate from main)
└── test/integration/evals/
    ├── trajectory.eval.ts           ← Tier C1 trajectory match (runs on PR)
    ├── judge.eval.ts                ← Tier C2 LLM-as-judge (pre-deploy only)
    ├── golden-trajectories/        ← 10 Claude-authored cases (see §4.3 for the full list)
    │   ├── 01-weather-simple.ts            ← on-demand load → get_current_weather (superset)
    │   ├── 02-weather-forecast.ts          ← get_weather_forecast with days=7 (superset)
    │   ├── 03-off-topic-no-tool.ts         ← empty trajectory ref (subset mode)
    │   ├── 04-memory-write.ts              ← add_memory called for a remember-this prompt (superset)
    │   ├── 05-memory-recall-cross-session.ts ← multi-turn across two sessions (superset)
    │   ├── 06-list-and-load-capability.ts  ← meta-tool flow: list → load → tool callable (strict)
    │   ├── 07-composio-connect-flow.ts     ← load composio → MANAGE_CONNECTIONS → URL surfaced exactly (superset + assertion on URL)
    │   ├── 08-skill-then-sandbox.ts        ← search_skills → sandbox_run (strict order)
    │   ├── 09-capability-denied-graceful.ts ← UCAN missing sandbox cap → no sandbox call (subset)
    │   └── 10-credits-before-paid-tool.ts  ← credits middleware fires before paid action (strict order)
    ├── feedback/                    ← Phase 9E: human feedback configs + annotation queue
    │   └── seed.ts                  ← one-shot script to create configs + queue in LangSmith
    └── dataset/                     ← Phase 9D: deferred standalone path
        └── upload-to-langsmith.ts
```

#### `ls.vitest.config.ts` (verbatim per LangSmith docs)
```ts
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['**/*.eval.?(c|m)[jt]s'],
    reporters: ['langsmith/vitest/reporter'],   // pretty experiment summary in stdout
    setupFiles: ['dotenv/config'],              // loads .env.integration via dotenv
    testTimeout: 120_000,                       // chat + judge can be slow
  },
});
```

Notes:
- **Separate config file, not a mode flag on the main vitest config.** Required by `langsmith/vitest/reporter` — it replaces vitest's default reporter, so we must not collide with `pnpm test`.
- `include` glob matches the docs (`**/*.eval.?(c|m)[jt]s`) so `.eval.ts`, `.eval.mts`, `.eval.cts` all work.
- No `environment` field → defaults to `node` (the docs explicitly warn that JSDOM is not supported).

#### Run commands in `package.json`
```json
{
  "scripts": {
    "eval": "vitest run --config ls.vitest.config.ts",
    "eval:trajectory": "vitest run --config ls.vitest.config.ts test/integration/evals/trajectory.eval.ts",
    "eval:dry": "LANGSMITH_TEST_TRACKING=false vitest run --config ls.vitest.config.ts",
    "eval:feedback:seed": "tsx test/integration/evals/feedback/seed.ts"
  }
}
```
- `pnpm eval` — full eval run; uploads to LangSmith when `LANGSMITH_TRACING=true` + `LANGSMITH_API_KEY` are set.
- `pnpm eval:trajectory` — trajectory match only; free (no judge LLM); the PR-cadence command.
- `pnpm eval:dry` — runs everything locally without syncing to LangSmith (the docs' `LANGSMITH_TEST_TRACKING=false` switch). Use when iterating on a new trajectory.
- `pnpm eval:feedback:seed` — Phase 9E; one-shot create of feedback configs + annotation queue in LangSmith.

#### Runner decision — vitest now, standalone `evaluate()` later (hybrid)
- The codebase is already pnpm + vitest. `langsmith/vitest` (`ls.describe`, `ls.test`, `ls.logOutputs`) keeps eval cases next to test cases, one toolchain. Trajectories live as TypeScript modules — type-checked, refactor-safe.
- `langsmith/vitest` syncs **automatically** when env vars are set: each `ls.describe` becomes a LangSmith dataset; each `ls.test` becomes an example + experiment run; the default `pass` feedback key tracks per-case pass/fail. The reporter prints a link to the LangSmith experiment after each run — that's our drift dashboard, free out of the box.
- With env vars unset (or `LANGSMITH_TEST_TRACKING=false`), evals run locally as plain vitest with zero LangSmith dependency. PR-cadence stays self-contained.
- The standalone `evaluate(runAgent, { data: 'dataset-name', evaluators })` path is better once we hit ~30+ curated cases and want non-engineers adding cases via the LangSmith UI. We graduate to it in **Phase 9D**, not now. Both paths use the same `agentevals` evaluators — switching runners later is a small lift, not a rewrite.

#### 9A — Trajectory match — Tier C-cheap, runs on PR

Deterministic, no judge LLM cost. Catches "did the agent call the right tools" regressions on every PR.

Build five golden trajectories first. Each is a TypeScript module exporting a `referenceOutputs` array. Example shape:

```ts
// golden-trajectories/weather-berlin.ts
import { HumanMessage, AIMessage, ToolMessage } from '@langchain/core/messages';

export const inputs = {
  messages: [new HumanMessage("What's the weather in Berlin?")],
};

export const referenceOutputs = {
  messages: [
    new HumanMessage("What's the weather in Berlin?"),
    new AIMessage({
      content: '',
      tool_calls: [{ id: 'call_1', name: 'get_current_weather', args: { city: 'Berlin' } }],
    }),
    new ToolMessage({ content: '{"temp_c":22,...}', tool_call_id: 'call_1' }),
    new AIMessage('Berlin is currently around 22°C.'),
  ],
};
```

Concrete checklist:

- [ ] **9.1** `superset` mode for the four positive routing archetypes (weather lookup, memory write, memory recall, skill→sandbox). "Agent must call **at least** the reference tools; extras allowed." Catches missed tool calls; tolerates the model adding clarifying calls.

- [ ] **9.2** `subset` mode for the off-topic anti-false-positive case. Reference trajectory has zero tool calls. "Agent must NOT call tools outside the reference set." Catches the agent invoking tools it shouldn't.

- [ ] **9.3** `strict` mode for **credits-before-paid-tool** ordering. Reference fires the credits middleware effect before the paid tool. Catches a regression where middleware ordering breaks billing — direct application of the docs' "policy lookup before authorization" pattern.

- [ ] **9.4** `unordered` mode for the multi-tool case (e.g. "what's the weather AND any events in SF" — `get_weather` + a hypothetical `get_events`). Catches missing tools while tolerating call ordering variance.

- [ ] **9.5** `toolArgsMatchOverrides` for fuzzy args. Cities are case-insensitive; CIDs and DIDs must match exactly. Concrete:
  ```ts
  createTrajectoryMatchEvaluator({
    trajectoryMatchMode: 'superset',
    toolArgsMatchOverrides: {
      get_current_weather: 'ignore',   // city casing/spelling variance is OK
      get_weather_forecast: 'ignore',
      // sandbox_run / skills lookups → default 'exact'
    },
  });
  ```
  Exact accepted values per the `agentevals` repo: `exact` (default), `ignore`, `subset`, `superset`. (Spec confirms; pin once we read the repo at implementation time.)

- [ ] **9.6** Run path: `langsmith/vitest`. Each case is `ls.test(name, { inputs, referenceOutputs }, async ({ inputs, referenceOutputs }) => {...})`. Inside the test body: invoke via `ChatClient.send()` (we test the same HTTP path real users hit, not raw `agent.invoke`), then `ls.logOutputs({ messages: result.messages })`, then call the evaluator. With LangSmith env vars set, `ls.logOutputs` syncs each run to a LangSmith experiment automatically.

- [ ] **9.7** **Parametric cases via `ls.test.each(DATASET)`.** For the off-topic anti-false-positive guard we want to run the same evaluator against ~10 different off-topic inputs (`"what's up"`, `"how are you?"`, `"tell me a joke"`, …) without rewriting the test 10 times. `ls.test.each` is the docs-recommended pattern; each row syncs as its own example in the LangSmith dataset.

- [ ] **9.8** Threshold: trajectory match returns boolean `score`. **Fail any test where score !== true.** Trajectory match is deterministic — there is no "soft fail" tier here. A miss is a real regression.

#### 9B — LLM-as-judge — Tier C-heavy, pre-deploy only

Qualitative scoring of agent reasoning + tool-selection on a curated 10-case set. Catches behavior drift the deterministic matcher misses (e.g. "agent called the right tool but with weird reasoning that would confuse users").

- [ ] **9.9** `createTrajectoryLLMAsJudge` constructed with a `ChatOpenAI` instance pointing at OpenRouter:
  ```ts
  import { ChatOpenAI } from '@langchain/openai';
  const judgeLLM = new ChatOpenAI({
    modelName: 'openai/gpt-4o-mini',
    configuration: { baseURL: 'https://openrouter.ai/api/v1' },
    apiKey: process.env.OPEN_ROUTER_API_KEY,
  });
  const judge = createTrajectoryLLMAsJudge({ judge: judgeLLM, prompt: TRAJECTORY_ACCURACY_PROMPT });
  ```
  Cost reason: `gpt-4o-mini` ≈ 10× cheaper than `openai/o3-mini`. Fallback to `openai/o3-mini` (still via OpenRouter) only if accuracy is insufficient on a 10-case spot-check. **No OpenAI direct calls anywhere.**

- [ ] **9.10** Use `TRAJECTORY_ACCURACY_PROMPT` (no-reference) for **open-ended** cases where the "right" trajectory is fuzzy.

- [ ] **9.11** Use `TRAJECTORY_ACCURACY_PROMPT_WITH_REFERENCE` for the **anchored** cases that also have a golden trajectory. Pairing both signals on the same case is the strongest drift detector — trajectory match catches structural drift; judge catches reasoning drift.

- [ ] **9.11b** **Add `openevals.createLLMAsJudge` with `CORRECTNESS_PROMPT` as a third feedback signal** scoring the final assistant message against the reference final message. Feedback key: `final_answer_correctness`. Catches the regression class where the agent picks the right tools (trajectory ✓) and reasons fine (judge ✓) but the final user-facing text drifts (wrong, confusing, hallucinated). Three feedback chips per case in LangSmith — each catches a different regression class.

- [ ] **9.12** **Wrap the judge with `ls.wrapEvaluator()`.** Per the docs, this traces the judge's LLM call as a separate run linked to a feedback key (e.g. `correctness`) — keeps the main trace clean and gives us a per-case feedback chip in the LangSmith UI. Pattern:
  ```ts
  const judge = createTrajectoryLLMAsJudge({ model: 'openai/gpt-4o-mini (via OpenRouter)', prompt: ... });
  const wrappedJudge = ls.wrapEvaluator(judge);
  await wrappedJudge({ outputs: result.messages, referenceOutputs });
  ```

- [ ] **9.13** **Log cost + latency as feedback via `ls.logFeedback()`.** Every test additionally records:
  ```ts
  ls.logFeedback({ key: 'cost_usd', score: usageToUsd(result.usage) });
  ls.logFeedback({ key: 'latency_ms', score: result.durationMs });
  ```
  Free metrics, shows up as feedback chips in the LangSmith experiment view, lets us spot a regression where the agent still picks the right tools but burns 3× the tokens.

- [ ] **9.13b** **Hard budget assertions per case.** Each golden trajectory file additionally exports `maxCostUsd` and `maxLatencyMs`. The test fails if either is exceeded. Numbers set generously on first run (2× the observed value), tightened later. Catches "the agent still routes correctly but now uses 3× the tokens" — the regression `ls.logFeedback` only *records*.

- [ ] **9.14** Scoring contract:
  - Judge returns `{ score: boolean }` (per `agentevals` docs).
  - Aggregate over 10 cases: pass rate = (true / total).
  - **Pre-deploy gate:** block release if pass rate < 0.8.
  - **Per-case warning** (non-blocking): any case that flipped `true` → `false` since the last release is surfaced in the PR/release notes.

- [ ] **9.15** Cost cap: 10 cases × judge call × `maxTokens: 512`. Target < $0.20 per full judge run.

#### 9C — LangSmith wiring (opt-in from day one)

- [ ] **9.16** `.env.integration` accepts `LANGSMITH_API_KEY`, `LANGSMITH_TRACING=true`, and optionally `LANGSMITH_TEST_TRACKING=false` (forces dry-run regardless of the other two). All optional locally; required in CI.
- [ ] **9.17** What LangSmith does automatically when env vars are set (per docs, no extra code from us):
  - Each `ls.describe(name, ...)` becomes a LangSmith **dataset** with the same name (created if missing).
  - Each `ls.test(name, { inputs, referenceOutputs }, ...)` becomes a dataset **example** (created if missing) + a new **experiment run** per invocation.
  - The default `pass` feedback key tracks per-case pass/fail from assertions.
  - `ls.logOutputs({...})` captures the actual agent output for the run.
  - `ls.logFeedback({ key, score })` adds custom feedback chips per case.
  - `ls.wrapEvaluator(fn)` traces an evaluator (e.g. the judge LLM call) as its own run + auto-creates a feedback entry when the wrapped function returns `{ key, score }`.
- [ ] **9.18** Pre-deploy CI sets both env vars from GitHub secrets. Every release's eval run uploads to LangSmith → drift dashboard automatically populated.
- [ ] **9.19** Two LangSmith projects: `qiforge-evals` (release tier) and `qiforge-evals-pr` (PR tier). Two projects so the noisier PR runs don't pollute release dashboards.

#### 9D — Graduate to standalone `evaluate()` — only if non-engineers want to add cases

**What this is, plainly:** the vitest path (9A–9C) keeps eval cases as TypeScript files in our repo — engineers add cases via PRs. The standalone path moves cases into the LangSmith UI itself — non-engineers (you, a PM, anyone with LangSmith access) add cases by clicking, no code change.

**When to switch:** only when we actually have non-engineers wanting to contribute cases. If we never do, we never need this phase. There is no time-based trigger — it's a "do we have the demand" question.

When that happens:

- [ ] **9.20** One-shot uploader: `pnpm eval:dataset:seed` — reads all `golden-trajectories/*.ts` and creates/updates a LangSmith dataset named `qiforge-trajectories-v1`.
- [ ] **9.21** Runner script: `pnpm eval:dataset` — `evaluate(runAgent, { data: 'qiforge-trajectories-v1', evaluators: [trajectoryEvaluator, judgeEvaluator] })`. `runAgent(inputs)` calls `ChatClient.send()` against a freshly booted ephemeral oracle and returns `result.messages`.
- [ ] **9.22** Dataset schema (per docs):
  ```
  input:  { messages: [...] }
  output: { messages: [...] }   // expected message history; assistant messages only is fine for trajectory eval
  ```
- [ ] **9.23** Alternative: use `client.listExamples({ datasetName })` + `ls.test.each(testExamples)` from inside vitest to run the same cases through the vitest path. Same data, two runners, you pick per use case.
- [ ] **9.24** Vitest path stays — the standalone runner is for curated drift tracking, not a replacement for PR-cadence trajectory checks.

#### 9E — Human feedback loop (LangSmith annotation queues)

**Why we want this.** Trajectory match catches structural regressions; the judge catches reasoning regressions the matcher misses. Neither catches things like "the response is technically correct but rude" or "the tool selection is fine but the final message is misleading." Human review fills that gap. By defining **feedback configs** (org-wide schemas) and an **annotation queue** programmatically, we get a consistent rubric across reviewers + a trail of structured human feedback that:

1. **Auto-flags failing pre-deploy evals for human review** — when 9B fails the gate, the failing traces land in the queue automatically; release lead sees them in LangSmith with our rubric.
2. **Becomes training data for the judge** — a divergence between human and judge scores tells us the judge prompt needs work.
3. **Seeds new eval cases** — anything a human flags as a problem becomes a candidate golden trajectory in the next cycle.

**Three org-wide feedback configs (created once via `pnpm eval:feedback:seed`):**

| Key | Type | Schema | Used for |
|---|---|---|---|
| `accuracy` | `continuous` | `min: 0, max: 1`, `isLowerScoreBetter: false` | How factually correct is the response |
| `correctness` | `categorical` | `[{value: 1, label: "Pass"}, {value: 0, label: "Fail"}]` | Binary did-it-work judgment |
| `notes` | `freeform` | n/a | Open-ended reviewer observations |

**One annotation queue: `qiforge-eval-review`.** Three rubric items pointing at the configs above, with queue-specific descriptions. `accuracy` and `correctness` required; `notes` optional.

Concrete checklist:

- [ ] **9.25** Implement `feedback/seed.ts` — calls `client.createFeedbackConfig()` for each of the three configs (idempotent per docs: duplicate identical config returns existing).
- [ ] **9.26** Implement the queue creation in the same script — `client.createAnnotationQueue({ name: 'qiforge-eval-review', description: '...', rubricInstructions: 'Score the agent trace. Add notes for anything unusual.', rubricItems: [...] })`.
- [ ] **9.27** Run `pnpm eval:feedback:seed` once per LangSmith workspace (release + PR). Safe to re-run; idempotent.
**That's it for the initial scope.** The seeded queue and configs are enough to start reviewing manually — when a pre-deploy eval fails, a human opens the experiment in LangSmith and uses "Add to queue" to send the trace to `qiforge-eval-review` with one click. No code involved.

**Deferred follow-up (not in initial scope, only if manual enqueue gets tedious):** a small post-eval hook that auto-enqueues failing traces from CI. Worth building only after we've actually used the queue manually for a release cycle and confirmed the rubric works.

**Cost: $0** — annotation queues are a LangSmith plan feature, not a per-action charge. Reviewer time is the only cost.

**Done when:** a release fails the judge gate → a human reviews the failing traces in the queue → notes from review inform the next iteration of golden trajectories. The loop closes manually first; we automate later only if it earns its keep.

---

**Phase 9 done when:** a deliberate manifest tweak that mis-routes one of the 10 reference cases shows up as (a) a trajectory-match failure on PR (9A), (b) a judge-score drop pre-deploy (9B), AND (c) ends up in the human review queue (9E).

---

### Phase 10 — CI wiring (deferred; not in initial scope)

Initial scope: tests run locally via `pnpm test:integration` and `pnpm eval`. GitHub Actions wiring is a follow-up — trivial once the commands are stable (one workflow file calling the two scripts, secrets from GH secrets). No spec needed for it.

---

## 9. What the user provides

| Item | Value (provided) | Used by |
|---|---|---|
| `TEST_USER_DID` | `did:ixo:ixo1gz6cly2l94j9lydlx7a4ljsh52m0jtx5cgz8na` | Tier A + B everywhere |
| `TEST_USER_MNEMONIC` (Ed25519) | `feature brown crime aware honey warfare voyage become february orchard now broken` | Used by `mintUserDelegation()` to sign UCANs. Goes in `.env.integration`, gitignored, never committed |
| Oracle DID + entity DID (devnet) | UCAN audience | Already in `.env.example` |
| `OPEN_ROUTER_API_KEY` | All Tier B + C | Already supported |
| `MEMORY_MCP_URL`, `MEMORY_ENGINE_URL` (devnet) | Phase 3 | Already in `.env.example` |
| `SANDBOX_MCP_URL` (devnet) | Phase 4 | Already in `.env.example` |
| `SKILLS_CAPSULES_BASE_URL` (devnet) | Phase 4 | Already in `.env.example` |
| `FIRECRAWL_API_KEY` (or MCP URL) | Phase 5 | Optional — tests skip if absent |
| `COMPOSIO_API_KEY` + Linear connection | Phase 6 | Composio account with Linear OAuth connected to a test workspace |
| Linear test team ID | Phase 6 | Tests scope all writes to this team for clean teardown |
| `REDIS_URL` (devnet) | Phase 5 credits | Optional — credits tests skip if absent |
| Fixture skill capsule (devnet) | Phase 4.5 | One small skill we control, so search has a known result |
| Reference conversations × 10 | Phase 9B | Will draft these together once Phases 1-7 are green |
| `LANGSMITH_API_KEY` + `LANGSMITH_TRACING=true` | Phase 9C | Optional locally; required in CI. Without them, evals run locally; with them, every run syncs to a LangSmith dataset + experiment automatically. Two projects: `qiforge-evals` (release) and `qiforge-evals-pr` (PR cadence) |
| `LANGSMITH_TEST_TRACKING=false` | Phase 9 dry-run | Optional. Forces local-only eval runs even when the other LangSmith env vars are set. Useful for iterating on a new trajectory without polluting the drift dashboard |
| Judge model | Phase 9B | **Routes through OpenRouter, not OpenAI direct.** Constructed as a `ChatOpenAI` instance with `baseURL: 'https://openrouter.ai/api/v1'` and the existing `OPEN_ROUTER_API_KEY`. No separate `OPENAI_API_KEY` needed. Model id: `openai/gpt-4o-mini` (OpenRouter's identifier) |
| Annotation queue + 3 feedback configs in LangSmith | Phase 9E | Created automatically by `pnpm eval:feedback:seed` (one-shot, idempotent). Needs a LangSmith plan that supports annotation queues |
| `langsmith>=0.3.1` SDK | Phase 9 (vitest integration) | Required version for `langsmith/vitest` per the docs. We pin this in `package.json` |

---

## 10. Test file sketches (for review only — not authoritative)

**Tier A — direct invoke:**
```ts
// memory.plugin.int.test.ts
import { it } from 'vitest';
import { createIntegrationRuntime, mintUserDelegation, memoryCap, requires } from '@ixo/oracle-runtime/testing';
import { MemoryPlugin } from '@ixo/oracle-runtime';

requires('MEMORY_MCP_URL', 'TEST_USER_MNEMONIC', 'ORACLE_DID');

it('writes a memory and reads it back', async () => {
  const rt = await createIntegrationRuntime({
    plugins: [new MemoryPlugin()],
    user: { did: process.env.TEST_USER_DID! },
    delegation: await mintUserDelegation({
      userMnemonic: process.env.TEST_USER_MNEMONIC!,
      oracleDid: process.env.ORACLE_DID!,
      capabilities: [memoryCap],
    }),
  });

  await rt.invokeTool('memory-engine__add_memory', { content: 'user prefers dark mode' });
  const out = await rt.invokeTool('memory-engine__search_memory_engine', { query: 'dark mode' });

  expect(out).toMatchObject({ memories: expect.arrayContaining([
    expect.objectContaining({ content: expect.stringMatching(/dark mode/) }),
  ]) });
});
```

**Tier B — agent loop:**
```ts
// agent-scenarios.int.test.ts
import { createIntegrationOracle, ChatClient, mintUserDelegation, runScenario, user, expectToolCall, expectFinal, newSession, allCaps } from '@ixo/oracle-runtime/testing';

it('recalls a fact across sessions', async () => {
  const { baseUrl, close } = await createIntegrationOracle();
  const client = new ChatClient(baseUrl, {
    delegation: await mintUserDelegation({ /* allCaps */ }),
  });

  await runScenario(client, [
    user('remember my name is Sara'),
    expectToolCall('memory-engine__add_memory'),
    newSession(),
    user("what's my name?"),
    expectFinal(/Sara/i),
  ]);

  await close();
});
```

**Tier C — trajectory match eval (vitest path):**
```ts
// trajectory.eval.ts
import * as ls from 'langsmith/vitest';
import { createTrajectoryMatchEvaluator } from 'agentevals';
import { inputs as weatherInputs, referenceOutputs as weatherRef }
  from './golden-trajectories/weather-berlin.js';

const evaluator = createTrajectoryMatchEvaluator({
  trajectoryMatchMode: 'superset',
  toolArgsMatchOverrides: { get_current_weather: 'ignore' },
});

ls.describe('trajectory: weather lookup', () => {
  ls.test(
    'Berlin weather → get_current_weather',
    { inputs: weatherInputs, referenceOutputs: weatherRef },
    async ({ inputs, referenceOutputs }) => {
      const result = await client.send('eval-weather-1', inputs.messages[0].content);
      ls.logOutputs({ messages: result.messages });
      const evaluation = await evaluator({
        outputs: result.messages,
        referenceOutputs: referenceOutputs.messages,
      });
      expect(evaluation.score).toBe(true);
    },
  );
});
```

**Tier C — LLM-as-judge eval (with `wrapEvaluator` + custom feedback):**
```ts
// judge.eval.ts
import * as ls from 'langsmith/vitest';
import { expect } from 'vitest';
import {
  createTrajectoryLLMAsJudge,
  TRAJECTORY_ACCURACY_PROMPT_WITH_REFERENCE,
} from 'agentevals';
import { inputs, referenceOutputs } from './golden-trajectories/memory-recall.js';

const judge = createTrajectoryLLMAsJudge({
  model: 'openai/gpt-4o-mini (via OpenRouter)',
  prompt: TRAJECTORY_ACCURACY_PROMPT_WITH_REFERENCE,
});

ls.describe('judge: memory recall', () => {
  ls.test(
    'recalls name across sessions',
    { inputs, referenceOutputs },
    async ({ inputs, referenceOutputs }) => {
      const result = await client.send('eval-memory-1', inputs.messages[0].content);
      ls.logOutputs({ messages: result.messages });

      // Wrap the judge so its LLM call traces separately + auto-creates a feedback chip
      const wrappedJudge = ls.wrapEvaluator(judge);
      const evaluation = await wrappedJudge({
        outputs: result.messages,
        referenceOutputs: referenceOutputs.messages,
      });

      // Free metrics — show up as feedback chips alongside the trajectory score
      ls.logFeedback({ key: 'cost_usd', score: result.cost ?? 0 });
      ls.logFeedback({ key: 'latency_ms', score: result.durationMs });

      expect(evaluation.score).toBe(true);
    },
  );
});
```

**Tier C — parametric off-topic guard (`ls.test.each`):**
```ts
// trajectory.eval.ts (continued)
const OFF_TOPIC = [
  { inputs: { userQuery: "what's up" },         referenceOutputs: { tools: [] } },
  { inputs: { userQuery: "tell me a joke" },    referenceOutputs: { tools: [] } },
  { inputs: { userQuery: "how are you?" },      referenceOutputs: { tools: [] } },
];

const offTopicEvaluator = createTrajectoryMatchEvaluator({ trajectoryMatchMode: 'subset' });

ls.describe('off-topic anti-false-positive', () => {
  ls.test.each(OFF_TOPIC)(
    'no tool calls for: $inputs.userQuery',
    async ({ inputs, referenceOutputs }) => {
      const result = await client.send(`eval-offtopic-${Date.now()}`, inputs.userQuery);
      ls.logOutputs({ messages: result.messages });
      const evaluation = await offTopicEvaluator({
        outputs: result.messages,
        referenceOutputs: [{ messages: [], tool_calls: [] }],
      });
      expect(evaluation.score).toBe(true);
    },
  );
});
```

**Phase 9E — seed feedback configs + queue:**
```ts
// test/integration/evals/feedback/seed.ts
import { Client } from 'langsmith';

const client = new Client();

await client.createFeedbackConfig({
  feedbackKey: 'accuracy',
  feedbackConfig: { type: 'continuous', min: 0, max: 1 },
  isLowerScoreBetter: false,
});
await client.createFeedbackConfig({
  feedbackKey: 'correctness',
  feedbackConfig: {
    type: 'categorical',
    categories: [{ value: 1, label: 'Pass' }, { value: 0, label: 'Fail' }],
  },
});
await client.createFeedbackConfig({
  feedbackKey: 'notes',
  feedbackConfig: { type: 'freeform' },
});

await client.createAnnotationQueue({
  name: 'qiforge-eval-review',
  description: 'Human review of failing pre-deploy evals',
  rubricInstructions: 'Score the agent trace. Add notes for anything unusual.',
  rubricItems: [
    { feedback_key: 'accuracy',    description: 'How accurate is the response?', is_required: true },
    { feedback_key: 'correctness', description: 'Did the response pass or fail?', is_required: true },
    { feedback_key: 'notes',       description: 'Anything else worth flagging',    is_required: false },
  ],
});
```

---

## 11. Decisions I made (override these if you disagree)

These are calls I'm making so the spec is shippable without a back-and-forth. Override any of them in review and I'll redraft.

1. **Cheap model = `moonshotai/kimi-k2.5` for the test `main` role.** Reason: it's what production already uses for sub-agents — proven to call tools in this codebase. `gpt-oss-120b` is cheaper but unknown for our tool surface; we'd risk failures that look like bugs but are model limitations.
2. **Eval runner = `langsmith/vitest` now; graduate to standalone `evaluate()` only once we hit ~30 curated cases.** Same toolchain as tests, type-checked trajectories, free of LangSmith when env vars are absent. Phase 9D upgrades the runner — not a rewrite, just a flip.
3. **Judge model = `openai/gpt-4o-mini (via OpenRouter)`** (docs default is `o3-mini`; we pick the cheaper one first, upgrade only on accuracy issues).
4. **Pre-deploy gating policy:**
   - Trajectory match (9A): **block the release** on any failure. Deterministic; a fail is a real regression.
   - LLM-as-judge (9B): **block the release** if aggregate pass-rate < 0.8. Per-case flips logged but non-blocking.
5. **LangSmith adoption: opt in from day one** — but env-gated, so local dev doesn't need it. Pre-deploy CI sets the env vars from GitHub secrets, so every release populates the drift dashboard from the first run forward. Cheaper than backfilling later.
6. **Tier-C trajectory match runs on PR**, not just pre-deploy. It's deterministic and free — no reason to delay the signal. Only the judge phase (9B) is pre-deploy-only.
7. **Human feedback loop (Phase 9E): in scope, optional rollout.** Feedback configs + annotation queue created upfront via `pnpm eval:feedback:seed` so the rubric exists from day one. Auto-enqueueing failing eval traces (9.28) is the high-value piece but slips behind 9A–9C if reviewer bandwidth isn't there yet.
8. **Vitest config: separate file (`ls.vitest.config.ts`)**, not a mode flag on the main vitest config. Required by `langsmith/vitest/reporter` per the docs; also keeps `pnpm test` (unit) and `pnpm eval` (eval) totally independent toolchains.
9. **Reference trajectories are Claude-authored, not human-curated.** I read the plugin manifests, system prompt, and tool schemas to write what an ideal agent should do; production model (Kimi) is tested against those references. Updates require PR; default assumption on a failure is "fix the code, not the reference" unless a reviewer explicitly confirms the new behavior is better. Annotation-queue feedback (9E) is the input signal for deciding which.
10. **Upstream flakes fail loud, no retry/tolerance mode.** If Memory Engine or Sandbox is down during a CI run, the test fails — outages on devnet upstreams are rare enough that silently retrying would hide real bugs more often than it would smooth over noise. No `it.toleratesFlake()` escape hatch.
11. **CI wiring is out of scope for this spec.** Local `pnpm test:integration` and `pnpm eval` are the canonical entrypoints. GitHub Actions wiring is a one-page follow-up added after the local commands stabilize.
12. **The example app's tests are the reference template, not just our test suite.** They're written to be read by an oracle developer copying them as a starting point. Every test file in `apps/qiforge-example/test/integration/` gets a top-of-file comment explaining what it tests and what to change when adapting it.
13. **Fully automated evals — no human in the critical path.** Every Tier C trajectory + judge run produces a pass/fail score programmatically. No "human reviews each run before merge." Phase 9E (human annotation queue) exists for *post-failure* review only — its absence never blocks CI. Pre-deploy gating is the judge score, deterministic, no human involved.
14. **Composio capability mapping: composio uses `ixo:sandbox`, not a separate cap.** This is a non-obvious fact from the plugin code — composio routes through the sandbox infrastructure, so the test delegation just needs `sandboxCap`. There is no `composioCap` constant; we documented this in the cap-constants list in Phase 0.

## 12. Open questions for you

1. **Composio Linear scope** — single test team, or also test workspace-level operations like "list teams"?
2. **Editor / Portal / Slack** — confirmed skip for now. Should they be added in a later phase, or stay manual smoke?
3. **Fixture skill capsule** — do you have one on devnet we can target for Phase 4.5, or should we publish a `qiforge-integration-test` capsule?
4. **Reference conversation set (Phase 9B 10-case judge set)** — draft together once Phases 1-7 are green, or do you want to draft them upfront so I can wire 9A and 9B at the same time?

---

## 13. Out of this spec — what we are explicitly not doing

- Latency / P95 metrics — the existing `agent-evaluations.md` discusses this; not part of bulletproofing the agent on each deploy.
- Safety / red-team eval — important but separate; the safety middleware already has its own unit tests.
- Token-cost attribution per plugin — interesting, not blocking.
- Multi-oracle scenarios — qiforge-example is the only target.

These can come later as separate specs once the core integration + eval layer is shipped.

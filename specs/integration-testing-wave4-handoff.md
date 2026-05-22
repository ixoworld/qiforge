# Wave 4 Handoff — Integration Testing

**You're picking up at Wave 4 of the QiForge integration testing roll-out.**
Waves 0–3 are done. Your job is Phase 8 (cross-plugin agent scenarios) and any
follow-on work. Phase 9 (evals) is designed but out of scope until after
Phase 8 lands. Phase 10 (CI) stays deferred per the spec.

---

## Read these first, in order

1. **`specs/integration-testing-spec.md`** — the master spec. Read §1 (goals),
   §4 (testing strategy), §8 Phase 8 (your scope), §11 (locked decisions).
2. **`packages/oracle-runtime/src/testing/integration/`** — the harness. Surface
   in `index.ts`. Heaviest examples of usage:
   - `packages/oracle-runtime/src/plugins/sandbox/sandbox.plugin.int.test.ts`
     — Tier A direct invoke, Tier B agent loop, registry-derived fixtures, full
     write→read→presigned-URL→`fetch` chain.
   - `packages/oracle-runtime/src/plugins/credits/credits.plugin.int.test.ts`
     — Real Redis backed middleware, subscription-cache seeding, balance +
     held-amount assertions through the public `TokenLimiter` API.
   - `packages/oracle-runtime/src/plugins/memory/memory.plugin.int.test.ts`
     — UCAN signing key seeding, runTag-based state isolation, Tier B cross-
     session recall.
3. **`apps/qiforge-example/test/integration/boot.int.test.ts`** — the canonical
   "fork-and-adapt" template for oracle developers building on the runtime.

---

## The end goal (do not lose sight of this)

Two questions every test must answer **yes** to:

1. **System bulletproof on each change** — would this test catch a wiring regression?
2. **Agent bulletproof on each deploy** — would this test catch a behavioral drift the model would cause?

If a test would pass when production is broken or fail when production works
fine, don't write it. No "tool is registered" boilerplate. See spec §1.

---

## Three-tier model (spec §4)

| Tier | Question it answers | Cost | How |
|---|---|---|---|
| **A** | Does our integration with the upstream service work? | $0 (no LLM) | `createIntegrationRuntime()` + `invokeTool()` direct invoke against real upstream |
| **B** | Does the agent pick the right tool for the user input? | small (cheap model) | `createIntegrationOracle()` + `ChatClient.send/stream` — real HTTP, real model |
| **C** | Has the agent's overall behavior drifted? | $$ pre-deploy | Trajectory match + LLM-as-judge (Phase 9; not in Wave 4) |

Default to Tier A; reach for Tier B only when you specifically need to verify
the model's routing decision. Tier C is for pre-deploy evals only.

---

## What's done in Wave 3 (DO NOT REPEAT)

### Plugin integration test files

| Plugin | File | Tests |
|---|---|---|
| sandbox | `packages/oracle-runtime/src/plugins/sandbox/sandbox.plugin.int.test.ts` | A1 `sandbox_run` echo; A2 write→read round-trip; A3 `oracle_*` hidden; A4 `oracle_*` opt-in; A5 `load_skill` against a registry-resolved public cid; A6 `sandbox_write_file` → `artifact_get_presigned_url` → `fetch(downloadUrl)` proves the URL serves the exact bytes; B1 manifest routing |
| skills | `packages/oracle-runtime/src/plugins/skills/skills.plugin.int.test.ts` | A1 `list_skills` shape; A2 `search_skills` shape; B1 discovery routing for a topic-specific ask |
| user-preferences | `packages/oracle-runtime/src/plugins/user-preferences/user-preferences.plugin.int.test.ts` | A1 GET `/user-preferences` HTTP route; B1 routing of behavioral preference asks |
| firecrawl | `packages/oracle-runtime/src/plugins/firecrawl/firecrawl.plugin.int.test.ts` | A1 `firecrawl_scrape` against a stable URL; B1 on-demand discovery + sub-agent dispatch |
| credits | `packages/oracle-runtime/src/plugins/credits/credits.plugin.int.test.ts` | A1/A2 loader contract (`DISABLE_CREDITS` bypass); A3 real-Redis ledger decrement after an LLM call; A4 zero-balance short-circuit (no spend, no ledger change) |
| composio | `packages/oracle-runtime/src/plugins/composio/composio.plugin.int.test.ts` | B1 connect-first flow (discovery → `COMPOSIO_MANAGE_CONNECTIONS` → no `LINEAR_*` action); B2 URL-fidelity (every URL in the assistant message must appear in the tool result) — **behavior only, never creates a real Linear issue** |
| agui | `packages/oracle-runtime/src/plugins/agui/agui.plugin.int.test.ts` | B1 declared `agActions` → SSE emits `action_call` carrying the declared toolName; B2 no `agActions` → no `action_call` for that name |
| memory (Wave 3 retrofit) | `packages/oracle-runtime/src/plugins/memory/memory.plugin.int.test.ts` | Phase 3 tests preserved, retrofitted to throw-on-missing-env |

### Wave 0–2 retrofit

All integration test files now **throw at file-load time** if their declared
required env vars are missing — no more `describe.skipIf(skipReason)` or
`HAS_*_ENV` booleans. Files touched: `hello-world`, `runtime-boot`,
`meta-tools`, `error-paths`, `boot`, `weather`, `memory.plugin`.

### Harness

`createIntegrationOracle`, `createIntegrationRuntime`, `ChatClient`,
`mintUserDelegation`, `waitForMatrixLoaded`, cap constants, typed SSE
parser — all stable. No changes needed for Wave 4.

---

## Your Wave 4 scope — Phase 8

**File:** `apps/qiforge-example/test/integration/agent-scenarios.int.test.ts`

**What it tests:** curated cross-plugin scenarios against the FULL bundled set
exactly as `src/main.ts` configures it. Each scenario is one user prompt that
forces the agent to compose multiple plugins. Unlike per-plugin Tier B tests
(which only check the agent picks the right tool for ONE plugin), this file
checks the agent picks the right SEQUENCE of plugins.

**Suggested scenarios** (spec §8 Phase 8 has the canonical list; adapt
prompts to match the actual capsules in the live registry on devnet):

1. **search-then-load:** "Find me a skill for invoices and load it." → search_skills → load_skill (and stop there; sandbox_run is a separate concern).
2. **scrape-then-summarize:** "Pull the contents of <stable URL> and remember the key points." → call_firecrawl_agent → add_memory.
3. **entity-then-memory:** "Tell me about the IXO Foundation and save the summary." → call_domain_indexer_agent → add_memory.
4. **prefs-then-respect:** "From now on reply in Spanish. Now tell me hi." → set_user_preferences → assistant message in Spanish on the SAME turn or the next.
5. **artifact-then-share:** "Generate a CSV with these rows and give me a download link." → sandbox_run (or sandbox_write_file) → artifact_get_presigned_url.

Pick 3–5 scenarios. Each one earns its keep — see spec §1.

---

## Patterns + idioms — DO follow these

### Imports (per-package paths)

```ts
// Internal to packages/oracle-runtime/**:
import {
  allCaps, ChatClient, createIntegrationOracle, createIntegrationRuntime,
  type IntegrationOracle, type IntegrationRuntime,
  memoryCap, sandboxCap, skillsCap, mintUserDelegation, waitForMatrixLoaded,
  type SSEEvent, type SSEToolCallEventData,
} from '../../testing/integration/index.js';

// From apps/qiforge-example/test/integration/**:
import {
  allCaps, ChatClient, createIntegrationOracle, /* ... */
} from '@ixo/oracle-runtime/testing/integration';
```

### Env gating — throw, never skip

```ts
const REQUIRED_ENV = [
  'MEMORY_MCP_URL', 'ORACLE_DID', 'TEST_USER_MNEMONIC', /* … */
] as const;
const missing = REQUIRED_ENV.filter((k) => !process.env[k]);
if (missing.length > 0) {
  throw new Error(
    `<file>.int.test.ts requires the following env vars (see packages/oracle-runtime/.env.integration): ${missing.join(', ')}`,
  );
}
describe('your plugin — integration', () => { /* … */ });
```

NO `describe.skipIf(skipReason)`. NO `HAS_*_ENV` boolean dance. Missing env is a
test failure, not a silent pass.

### Tier B session reuse

```ts
beforeAll(async () => {
  /* boot oracle, mint delegation, build ChatClient */
  sharedSessionId = await chatClient.createSession();  // ONCE per file
}, 180_000);

test('B1', async () => {
  const stream = chatClient.stream(sharedSessionId, 'prompt…');
  /* … */
});
```

`createSession` is a server-side round-trip. Only mint a fresh session when the
test's whole point IS session isolation (memory B2 cross-session recall is the
canonical example).

### Tier A pattern

```ts
const rt = await createIntegrationRuntime({
  plugins: [new YourPlugin()],
  user: { did: process.env.TEST_USER_DID! },
  delegation,
  capabilities: [{ resource: yourCap.with, action: yourCap.can }],
  ucan: oracle.app.ambient.ucan,  // shares signing key with the booted oracle
});
const result = await rt.invokeTool('upstream__your_tool', { /* … */ });
```

### Critical gotchas (carry forward from Wave 3)

1. **`await waitForMatrixLoaded(oracle)` if Tier B needs the UCAN signing key.**
   The signing mnemonic loads from Matrix asynchronously after boot returns.
   Without waiting, every `/messages/*` call 401s with "UCAN signing key not
   configured."

2. **`await chatClient.createSession()` BEFORE every `send`/`stream`.**
   `MessagesController` returns 404 if the session doesn't exist server-side.
   Don't fabricate sessionIds.

3. **Upstream MCP tools have specific schemas — verify them.** Memory's
   `add_memory` takes `{ name, content }`, NOT just `{ content }`. Sandbox's
   `load_skill` takes `{ cid }`, NOT `{ skill_cid }`. Check the plugin's
   `types.ts` or the upstream MCP server source. **Never guess the schema.**

4. **Memory writes are async on the upstream.** Sleep ~30–60s between a
   write and a search if your test depends on read-your-writes semantics.

5. **Tagged content for state isolation.** Memory, Sandbox, Composio all
   persist state. Tag every write with `${runTag}-${testName}-${randomUUID()}`
   so historical data doesn't satisfy your assertions.

6. **On-demand plugins need `load_capability` BEFORE their tools are callable
   in Tier B.** Firecrawl, agui, composio, editor, portal, weather are all
   `visibility: 'on-demand'`. Verify the agent calls `list_capabilities` or
   `load_capability({ name })` before invoking. Memory, sandbox, skills,
   user-prefs, domain-indexer are `'always'`.

7. **Plugin loader paths.** `plugins:` is the user-explicit opt-in path and
   **bypasses `autoDetect`**. `bundledPlugins:` is the standard path and
   **runs through `autoDetect`**. If a test asserts the bypass contract
   (e.g. `DISABLE_CREDITS=true`), it must use `bundledPlugins`.

8. **`callAgAction` waits for a client round-trip.** If you declare
   `agActions` in a Tier B test, the action_call event fires immediately but
   `callAgAction` blocks until the client responds (or times out at 15s).
   Don't gate on the action's *result* — assert on the SSE `action_call` event
   instead, which arrives before the result-wait.

9. **Redis-dependent tests.** Credits A3/A4 need a real local Redis at
   `REDIS_URL`. The default CI mode (`pnpm test`) excludes `*.int.test.ts`
   entirely, so this isn't a CI problem. Local runs need `redis-server` up.

10. **Composio uses `sandboxCap`, not a separate cap.** No `composioCap`
    constant exists. Tests that exercise composio mint `[sandboxCap]`.

---

## Hard constraints — DO NOT VIOLATE

1. **NO `skipMatrixInit` / `skipGracefulShutdown` / "skip-the-real-thing"
   flags.** Integration tests boot the same stack production does.

2. **NO `describe.skipIf(skipReason)` for env gates.** Throw at file load.
   The only legitimate skips are `test.skip(...)` with a comment naming the
   exact fixture/stub needed (spec §11 #5).

3. **NO reinventing standard tools.** Use `setupFiles: ['dotenv/config']`,
   plain vitest matchers, plain `expect.extend(langchainMatchers)`. No
   `requires()` helpers, no `runScenario` DSLs, no `env-loader` modules.

4. **NO type assertions (`as any`, `as Type`)** to bypass type errors. Find
   the real type. The unit-test fixture `makeRuntimeContext()` exists for
   cases where a plugin handler ignores its rtCtx (firecrawl A1 uses this).

5. **NO commits / pushes** unless explicitly asked by the user.

6. **NO fake-passing tests.** If a test can't be made deterministic without a
   stub upstream, write it as `test.skip(...)` with a comment naming the exact
   fixture/stub it needs. Don't make it pass on illusion.

7. **NO loosening assertions to mask failures.** Broadening a regex /
   accepting more outcomes / raising tolerances to make a failing Tier B test
   pass is the same anti-pattern as editing plugin code to fit a test. The
   tight assertion was written that way deliberately. Litmus test: does the
   new assertion still fail when the bug it was meant to catch is present?
   If no, the change is loosening, not fixing.

8. **NO plugin edits to make tests pass.** Plugin source is presumed-working
   production code. Two retry attempts MAX per failing test (test-side tweaks
   only). After two tries, stop and ask the user. Acceptable test-side fixes:
   wrong event name, wrong loader path, timeout too short for the upstream's
   own timeout. Unacceptable: broadening assertions, weakening tolerances,
   pruning checks.

9. **Structural assertions only in Tier B.** `expect(events).toContainToolCall({ name: 'X' })` ✅. `expect(text).toBe('It is 22°C…')` ❌.

10. **Stop-and-ask if ambiguous.** Sub-agents must clarify, not guess.

11. **NO task/spec metadata in source comments.** No `TASK-XX`, no `Phase N`,
    no `§N.Y` inside `.ts` files — those belong in the PR description and rot
    fast. Comments describe runtime behavior, not project tracking.

---

## Recommended Wave 4 execution

1. **Read the canonical scenarios in spec §8 Phase 8.** Pick 3–5 that
   exercise distinct cross-plugin paths. Skip any scenario whose deterministic
   fixture isn't yet available — better to `test.skip` it with a clear note
   than to write a flaky model-routing assertion.

2. **One file, one describe, shared oracle in `beforeAll`.** All bundled
   plugins on. One shared session reused across scenarios (each scenario is
   a fresh user prompt, not a fresh thread).

3. **Each scenario asserts on the SSE tool_call event sequence**, not on the
   assistant message. Order matters: e.g. `search_skills` must arrive before
   `load_skill`. Use `findIndex` chained checks (`expect(idxLoad).toBeGreaterThan(idxSearch)`).

4. **Verify locally** — `cd packages/oracle-runtime && pnpm test:integration -- <file>`.
   File-level parallelism is off (vitest config); per-file boots take 30–60s
   each plus LLM time. Phase 8 file should finish in 5–10 min solo.

5. **Confirm `pnpm test` (unit tests, default mode) still passes** — the
   integration files are excluded from default mode and shouldn't affect it.

---

## After Wave 4 — what's next

- **Phase 9 (Evals)** — `agentevals` + `openevals` + `langsmith/vitest`. Ten
  Claude-authored golden trajectories. See spec §8 Phase 9 in full —
  designed; LangSmith creds in `.env.integration`. Tackle this AFTER Phase 8
  is in.
- **Phase 10 (CI)** — out of scope per spec §11 #11. Defer indefinitely
  unless the team explicitly opts in. The throw-on-missing-env pattern is
  CI-incompatible by design; CI runs `pnpm test` (default mode) which
  excludes `*.int.test.ts`.

---

## When in doubt

- Read `specs/integration-testing-spec.md`.
- Mirror the patterns from the heaviest reference file
  (`sandbox.plugin.int.test.ts` — covers Tier A direct invoke, Tier B agent
  loop, registry-derived fixtures, and a full write-through-the-pipe-back
  assertion).
- If something is genuinely ambiguous, STOP and ask. Sub-agents that guess
  produce ever-loosening assertions and miss real bugs.

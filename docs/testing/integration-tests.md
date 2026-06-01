# Integration tests

Integration tests boot the real `createOracleApp`, hit real Matrix, and call real LLM services. They live under `test/integration/` and are gated by `.env.integration`.

Use them when you genuinely need end-to-end behaviour. For tool input parsing, manifest validation, middleware logic — write a unit test instead. Integration tests are slower, more fragile, and burn real LLM credits.

## File layout

```
apps/qiforge-example/
└── test/
    └── integration/
        ├── setup.ts                  # dotenv loader + global setup
        ├── boot.int.test.ts          # boot smoke test
        ├── weather.int.test.ts       # weather plugin scenarios
        └── agent-scenarios.int.test.ts
```

Inside the runtime package, integration tests live next to source as `*.int.test.ts`.

## Vitest config

```ts
// vitest.config.ts
export default defineConfig({
  test: {
    testTimeout: 120_000, // real boot + LLM round-trip
    fileParallelism: false, // one Matrix admin user
    setupFiles: ['./test/integration/setup.ts'],
    include: ['test/**/*.int.test.ts'],
  },
});
```

`fileParallelism: false` is non-negotiable — integration tests share a single Matrix admin user, and parallel files would step on each other.

120s timeout matches real-world boot + sync + LLM latency. Don't shrink it.

## setup.ts — fail loud on missing env

```ts
import { config as loadDotenv } from 'dotenv';
import { resolve } from 'node:path';

loadDotenv({ path: resolve(__dirname, '../../.env') });
loadDotenv({
  path: resolve(__dirname, '../../.env.integration'),
  override: true,
});

if (!process.env.TEST_USER_DID) {
  throw new Error(
    'Integration tests require .env.integration. Copy .env.integration.example and fill it in.',
  );
}
```

**Throw at file load on missing env.** Don't use `describe.skipIf(missingEnv)` — silent skips hide broken setups. Loud throws make missing env immediately obvious.

This rule is enforced via code review.

## The session pattern

`createSession()` is a Matrix round-trip. Minting per-test sessions adds seconds × N to suite runtime.

**Share one session per `describe`** unless the test's whole point is session isolation:

```ts
let app: Awaited<ReturnType<typeof createOracleApp>>;
let sessionId: string;

beforeAll(async () => {
  app = await createOracleApp({
    /* ... */
  });
  await app.listen(0);
  sessionId = await createTestSession(app); // once
});

afterAll(async () => {
  await app.getNestApp().close();
});

describe('weather tool', () => {
  it('returns current weather for Berlin', async () => {
    const response = await chat(
      app,
      sessionId,
      "what's the weather in Berlin?",
    );
    expect(response).toMatch(/Berlin/i);
  });

  it('handles a follow-up forecast question', async () => {
    // Same sessionId — tests build on the same thread.
    const response = await chat(app, sessionId, 'and tomorrow?');
    expect(response).toMatch(/tomorrow/i);
  });
});
```

When the test _is_ about session isolation (cross-session recall, first-contact behaviour), mint per-test. Otherwise reuse.

## What NOT to do

Three patterns enforced via code review. All three are documented memory rules.

### Don't loosen assertions to mask failures

Broadening a regex or adding "or X or Y" to make a flaky test pass discards the assertion's value.

**Litmus test:** does the new assertion still fail when the bug it was meant to catch is present?

If a test is genuinely flaky on infrastructure (Matrix sync, LLM cold start), wrap with a retry — don't widen the assertion.

### Don't edit plugin code to make tests pass

Test-side retry attempts max 2 per failure. Then stop and ask.

Plugin source is presumed-working production code; tests describe behaviour, not dictate it. If the plugin's behaviour and the test's expectation disagree, investigate which is right — usually the plugin.

### Don't add skip-real-services flags as speed-ups

`skipMatrixInit: true` / `skipGracefulShutdown: true` exist for unit tests, not integration tests. Integration tests must boot the same way production does — that's their point.

If integration tests are slow, the fix is fewer tests (or shared sessions) — not faking the services they're supposed to integrate against.

## When boot fails in an integration test

The boot logger writes to stderr — Vitest captures it. Read the `[boot-error]` lines first. Most failures are:

- Missing env var in `.env.integration`.
- A plugin's `autoDetect` opting in for a service that isn't running locally.
- Matrix bot credentials expired.

Resolve at the env layer, not by skipping the test.

## A note on Matrix flakiness

Matrix sync has natural latency. A test that posts a message and immediately asserts on a downstream side effect can race. The right fix is to use the runtime's own primitives:

- Wait on the LangGraph turn to complete via the streamed response.
- Use `getEventById` to poll for the expected event.
- Subscribe to plugin status changes for boot-related assertions.

Sleeping for a fixed duration is a smell.

## Read next

- [Test harness](test-harness.md) — Layer 1 unit testing.
- [Overview](overview.md) — when each layer is appropriate.
- [CI](ci.md) — how integration tests run in automation.

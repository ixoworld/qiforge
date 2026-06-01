# Adding an always-on middleware

The runtime installs four always-on middlewares before any plugin middleware runs:

1. `createToolValidationMiddleware` — validates tool args against their Zod schemas.
2. `toolRetryMiddleware` — LangChain built-in. One retry on tool validation failure.
3. `createPageContextMiddleware` — injects active page context for editor flows.
4. `createSafetyGuardrailMiddleware` — blocks output that violates the safety guardrails.

These are hard-coded into `createMainAgent` in the order shown. Adding a fifth is a runtime-level decision.

Don't add an always-on middleware just because something needs to run on every turn. The threshold is high:

- **It must apply to every oracle deployment** regardless of plugin set.
- **It must run unconditionally** — no fork should be able to opt out (otherwise it's a plugin).
- **It must be cheap.** It costs ms on every LLM call.

If the answer is "this is needed when plugin X is loaded", build it into plugin X's `getMiddlewares` instead. The four always-on middlewares are framework contracts; the rest are plugin contributions.

## Checklist

- [ ] Implement the middleware factory (`createMyMiddleware(...) → AgentMiddleware`) in `packages/oracle-runtime/src/graph/middlewares/`.
- [ ] Decide the position carefully. Most middlewares slot in _after_ tool validation and retry; pre-LLM middlewares go between page-context and safety-guardrail; post-LLM middlewares go after safety-guardrail.
- [ ] Wire it into `graph/main-agent.ts`'s middleware array.
- [ ] Document the position and rationale in `architecture/graph-and-state.md`.
- [ ] Export from `graph/index.ts` and re-export from `packages/oracle-runtime/src/index.ts` if hosts might want to reference it.
- [ ] Tests in `graph/middlewares/my-middleware.test.ts`.

## Shape

LangChain's `AgentMiddleware` interface. Use the `createMiddleware` helper:

```ts
import { createMiddleware } from 'langchain';
import type { AgentMiddleware } from 'langchain';

export function createMyMiddleware(options?: MyOptions): AgentMiddleware {
  return createMiddleware({
    name: 'MyMiddleware',
    beforeModel: async (state) => {
      // ...
      return undefined; // or a state update
    },
    afterModel: async (state) => {
      // ...
    },
    onError: async (error, state) => {
      // ...
    },
  });
}
```

Always set `name` — it appears in error messages and traces.

## Ordering

The order matters. The four always-on middlewares fire `beforeModel` in the order they're declared in `createMainAgent`:

1. Tool validation (rejects invalid tool args before LLM sees them).
2. Tool retry (gives the agent one chance to fix args).
3. Page context (injects context the agent needs for editor flows).
4. Safety guardrail (filters unsafe output — last, so it sees what others have done).

Plugin middlewares fire after these four, in topological dependency order across plugins. Your new always-on middleware needs a deliberate slot — append, prepend, or insert mid-list. The decision should be in the PR description.

## House rules

- **Don't bypass the plugin path.** If a plugin already does similar work for its own scope, see whether you can generalise the plugin instead of pulling logic into the framework.
- **Side effects only on success.** A `beforeModel` hook that fails should leave the state untouched.
- **Abort signal awareness.** `state` includes the run's abort signal indirectly via the runtime config. If you do async work, respect cancellation.
- **No `as any` casts.** State is typed; if you need to widen a field, do it via `ReadonlyState` extension or a typed selector — not a cast.

## Read next

- [Graph and state](../architecture/graph-and-state.md) — the four always-on middlewares in order.
- Public docs: `ixo-docs/build-an-oracle/guides/plugin-middlewares.mdx` — the developer-facing version for plugin authors.

# TASK-35: Plugin-declared auth-excluded routes

**Phase:** Framework v2 follow-up
**Effort:** ~½ day
**Depends on:** TASK-11 (createOracleApp), TASK-13 (auth middleware)
**Blocks:** any plugin that needs a public HTTP endpoint (webhooks, OAuth callbacks, public probes)

## Goal

Plugins shipping HTTP routes via `getNestModules()` currently all sit behind `AuthHeaderMiddleware` because the exclusion list is hardcoded in `packages/oracle-runtime/src/bootstrap/runtime-app-module.ts:AUTH_EXCLUDED_ROUTES`. There is no hook for a plugin to opt one of its routes out. Expose one.

## What's wrong today

- Surfaced during the Weather plugin dogfooding (`apps/qiforge-example/src/plugins/weather/weather.module.ts`): the `/weather/now` endpoint is documented as auth-locked because the plugin has no way to register an exclusion.
- Real-world consequences:
  - OAuth callbacks (`/oauth/google/callback`) can't be exposed without a runtime patch.
  - Inbound webhooks (Stripe, Slack events, Matrix client-events) can't be wired.
  - Public health/status pages need to live in the runtime, not in a plugin.

## API

New optional method on `OraclePlugin` (declared in `packages/oracle-runtime/src/plugin-api/oracle-plugin.ts` and the public type in `types.ts`):

```ts
import { RequestMethod } from '@nestjs/common';

interface AuthExcludedRoute {
  /** Path under the plugin's controller, e.g. 'weather/now'. Leading slash optional. */
  path: string;
  /** HTTP method (default ALL). */
  method?: RequestMethod;
}

abstract class OraclePlugin {
  // existing hooks ...

  /**
   * Routes this plugin owns that MUST NOT pass through `AuthHeaderMiddleware`.
   * Use for webhooks, OAuth callbacks, public probes — anything that doesn't
   * authenticate via UCAN. Returning an empty array (or omitting the method)
   * keeps every plugin route auth-locked.
   */
  getAuthExcludedRoutes?(): AuthExcludedRoute[];
}
```

## Implementation

1. **Declare the hook** in `oracle-plugin.ts` (optional method) + `types.ts` (re-export type).
2. **Aggregate at boot** in `create-oracle-app.ts` between plugin resolution and `RuntimeAppModule.register`:
   ```ts
   const pluginAuthExclusions = resolved.loaded.flatMap(
     (p) => p.getAuthExcludedRoutes?.() ?? [],
   );
   ```
   Pass into `RuntimeAppModule.register({ ..., pluginAuthExclusions })`.
3. **Merge in the app module** — extend `RuntimeAppModule.register` to accept `pluginAuthExclusions: AuthExcludedRoute[]` and concatenate them onto `AUTH_EXCLUDED_ROUTES` when `consumer.apply(AuthHeaderMiddleware).exclude(...)` is built.
4. **Update Weather plugin** to opt its route out:
   ```ts
   override getAuthExcludedRoutes(): AuthExcludedRoute[] {
     return [{ path: 'weather/now', method: RequestMethod.GET }];
   }
   ```
   Remove the "auth gotcha" warning from `weather.module.ts` JSDoc and the test guide.

## Tests

Add to `packages/oracle-runtime/src/bootstrap/runtime-app-module.test.ts` (or create it if missing):

- [ ] Plugin returning a route from `getAuthExcludedRoutes` adds it to the exclusion list passed to `AuthHeaderMiddleware`.
- [ ] Plugin returning `[]` (or omitting the method) keeps every plugin route auth-locked.
- [ ] Two plugins returning routes with the same path don't crash — both excluded.
- [ ] The runtime's own `AUTH_EXCLUDED_ROUTES` (e.g. `/health`, `/docs`) still excluded after plugin exclusions merge.

## Acceptance

- [ ] `OraclePlugin.getAuthExcludedRoutes` exists, typed, documented.
- [ ] `create-oracle-app.ts` aggregates and threads through.
- [ ] `RuntimeAppModule.register` merges runtime + plugin exclusions into the `AuthHeaderMiddleware` configurer.
- [ ] Weather plugin uses it; `/weather/now` is reachable via `curl` without a UCAN header.
- [ ] Tests above pass.
- [ ] No regressions in the existing test suite.

## Out of scope

- A plugin hook to add NEW middleware to runtime-owned routes — different problem.
- Per-route auth strategies (e.g. "use API key instead of UCAN here") — different problem.
- Updating other bundled plugins to opt out routes — they don't have any unauth routes to expose today.

# TASK-36: `getNestModules(ctx?)` — pass `PluginContext`

**Phase:** Framework v2 follow-up
**Effort:** ~1 hour
**Depends on:** TASK-11 (createOracleApp)
**Blocks:** clean config access from plugin Nest modules

## Goal

`OraclePlugin.getNestModules()` currently takes no argument. By the time it's called inside `createOracleApp`, the merged env config is already validated and available — but the plugin can't reach it without dropping back to `process.env`. Surface the existing `PluginContext` to this hook so plugins can read validated config the same way the rest of their code does.

## What's wrong today

- Surfaced during the Weather plugin dogfooding (`weather.plugin.ts:getNestModules`): the controller needs `WEATHER_DEFAULT_UNITS`, but the hook has no `ctx`. Workaround: read `process.env.WEATHER_DEFAULT_UNITS` directly, fall back to `'celsius'` manually. Two sources of truth (Zod schema vs raw read) → footgun.
- Other plugins that ship modules (credits / claim-processing / subscription-sink) only got around this by accepting their dependencies through the plugin constructor — fine for live runtime objects (Redis, Matrix client) but wrong for env-derived config.

## API

```ts
import type { DynamicModule, Type } from '@nestjs/common';
import type { PluginContext } from './types.js';

abstract class OraclePlugin {
  // existing hooks ...

  /**
   * NestJS modules contributed by this plugin (controllers, providers,
   * queue workers). `ctx` carries the validated merged config + identity +
   * logger so module-construction code can read env without going through
   * `process.env`.
   *
   * The optional arg keeps existing plugins source-compatible — implementations
   * that ignore it work unchanged.
   */
  getNestModules?(ctx?: PluginContext): Array<Type | DynamicModule>;
}
```

## Implementation

1. **Update signatures** in `packages/oracle-runtime/src/plugin-api/oracle-plugin.ts` and the public type re-export in `types.ts`.
2. **Build a per-plugin context at boot** in `create-oracle-app.ts` around line 248:
   ```ts
   const pluginNestModules = resolved.loaded.flatMap((p) => {
     const ctx = buildPluginContext({
       config: validated.config,
       identity,
       availablePlugins: loadedPluginNames,
       logger,
       pluginName: p.name,
     });
     return p.getNestModules?.(ctx) ?? [];
   });
   ```
   `buildPluginContext` is already imported in this file (already used at line ~353 for registry warm-up); reuse it.
3. **`loadedPluginNames` ordering** — currently computed AFTER the `pluginNestModules.flatMap` call. Either hoist `loadedPluginNames` above the flatMap or compute a temporary set inline for the call. Either is fine.
4. **Update Weather plugin** to drop the `process.env` workaround:
   ```ts
   override getNestModules(ctx: PluginContext): DynamicModule[] {
     const units = configSchema.parse(ctx.config).WEATHER_DEFAULT_UNITS;
     return [WeatherHttpModule.register(units)];
   }
   ```
   Remove the now-stale "module-construction happens before merged config is available" JSDoc.

## Tests

- Existing tests in `packages/oracle-runtime/src/bootstrap/create-oracle-app.test.ts` should still pass.
- One new test (or extension of an existing one):
  - [ ] A plugin's `getNestModules` receives a `PluginContext` with `config.X` populated when env declares `X`.

## Acceptance

- [ ] `OraclePlugin.getNestModules` accepts an optional `PluginContext`.
- [ ] `create-oracle-app.ts` builds + passes a per-plugin context.
- [ ] Backwards compatible: plugins that ignore the arg still work (no signature error).
- [ ] Weather plugin reads `ctx.config.WEATHER_DEFAULT_UNITS` instead of `process.env`.
- [ ] All existing tests still pass.

## Out of scope

- `getMiddlewares(ctx)`, `getSubAgents(ctx)`, etc. — they already receive ctx.
- Any restructuring of when `getNestModules` runs relative to other hooks.

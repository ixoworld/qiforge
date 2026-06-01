# Adding a module

Two patterns to add NestJS modules to the runtime:

1. **Always-on framework module** — lives under `packages/oracle-runtime/src/modules/<name>/` and is imported by `RuntimeAppModule` unconditionally. Reach for this when the capability is part of the framework's core contract (Sessions, Messages, WS, Secrets, UCAN, Auth, Subscription, Throttler, Health).

2. **Plugin-contributed module** — returned from a plugin's `getNestModules(ctx)`. Reach for this when the capability is opt-in or scoped to a specific plugin (Slack socket, BullMQ workers, plugin HTTP endpoints).

Use the always-on path only when you're sure every QiForge oracle needs the module. Otherwise prefer the plugin path — that's the whole point of the plugin model.

## Adding an always-on module

This is rare — the framework's module set is intentionally small. Only add an always-on module when there's no sensible plugin home for it.

### Checklist

- [ ] Create `packages/oracle-runtime/src/modules/<name>/`.
- [ ] Implement the module, controller(s), service(s), DTOs.
- [ ] Add it to `bootstrap/runtime-app-module.ts`'s static `imports` array (or build it via the `register` factory if it needs runtime config).
- [ ] If it needs ambient access (`UcanService`, `MatrixAdapter`, etc.), expose its interface in `AmbientServices` and resolve via `nestApp.get(...)` in `buildAmbientServices`.
- [ ] Update `architecture/modules.md` with the new module.
- [ ] Add tests.

### Things to watch for

- **Public routes** — if the module serves public routes (no UCAN), wire them into the `AuthHeaderMiddleware` exclude list inside `RuntimeAppModule`. Don't put exclusions in `MiddlewareConsumer.exclude(...)` ad-hoc — they need to flow through the same machinery plugin `getAuthExcludedRoutes()` uses.
- **Cycle in module DI** — if your module depends on something that depends on your module, you've drawn the graph wrong. See `architecture/modules.md` for the current dependency graph.
- **OracleRuntimeBundleHolder** — if your module needs ambient services at request time (like `MessagesService` does), read from the holder rather than building a parallel ambient mechanism.

## Adding a plugin-contributed module

This is the common case. The Slack plugin and the Weather plugin's `WeatherHttpModule` are the canonical examples.

### Checklist

- [ ] Implement the module with the standard NestJS shape.
- [ ] If the module needs config from the plugin (e.g. default units, a Redis client), expose a static `register(...)` returning a `DynamicModule`.
- [ ] Implement `getNestModules(ctx)` on the plugin to return `[YourModule]` or `[YourModule.register(value)]`.
- [ ] If the module serves routes that shouldn't require auth, implement `getAuthExcludedRoutes()` listing them.
- [ ] Tests live alongside the plugin (`<name>.plugin.test.ts` or `<name>.plugin.int.test.ts`).

### Example shape

```ts
import {
  Controller,
  type DynamicModule,
  Get,
  Inject,
  Module,
  Query,
} from '@nestjs/common';

export const MY_PLUGIN_OPTIONS = 'MY_PLUGIN_OPTIONS';

@Controller('my-plugin')
class MyPluginController {
  constructor(@Inject(MY_PLUGIN_OPTIONS) private readonly opts: Options) {}

  @Get('public')
  publicEndpoint() {
    return { ok: true };
  }
}

@Module({})
export class MyPluginHttpModule {
  static register(opts: Options): DynamicModule {
    return {
      module: MyPluginHttpModule,
      controllers: [MyPluginController],
      providers: [{ provide: MY_PLUGIN_OPTIONS, useValue: opts }],
    };
  }
}
```

Then on the plugin:

```ts
override getNestModules(ctx: PluginContext): DynamicModule[] {
  const opts = configSchema.parse(ctx.config);
  return [MyPluginHttpModule.register(opts)];
}

override getAuthExcludedRoutes(): AuthExcludedRoute[] {
  return [{ path: 'my-plugin/public', method: RequestMethod.GET }];
}
```

### What the runtime does with it

1. During `createOracleApp` phase 9, `plugin.getNestModules?.(ctx)` is called with a fresh `PluginContext`. The returned modules flatten into `pluginNestModules`.
2. `RuntimeAppModule.register({ pluginNestModules, … })` spreads them into `RuntimeAppModule.imports`.
3. The auth exclusions from `getAuthExcludedRoutes` flow into `MiddlewareConsumer.exclude(...)` alongside plugin and host-declared exclusions.
4. The full DI container builds, your controllers come online, routes are reachable.

### Things to watch for

- **`getNestModules(ctx)` may receive `ctx === undefined`.** The optional argument keeps older plugins source-compatible. If your implementation reads ctx, guard with `ctx?` or just default the value (`const cfg = configSchema.parse(ctx?.config ?? {})`).
- **Module DI scope.** Plugin modules get full DI access to Tier-0 services — inject `SessionsService`, `MessagesService`, `SecretsService`, etc. directly. No special wiring.
- **Lifecycle hooks.** `OnModuleInit` and `OnModuleDestroy` work normally. The Slack plugin uses `OnModuleInit` to connect its socket and `OnModuleDestroy` to disconnect cleanly.
- **Don't bypass plugin contracts.** A Nest module inside a plugin must still respect the plugin's contracts. Don't reach into other plugins' state from your controller — use shared state or the plugin's own service interface.

## Read next

- [Architecture: modules](../architecture/modules.md) — module dependency graph.
- [Adding a bundled plugin](adding-a-bundled-plugin.md) — full plugin contribution.
- Public docs: `ixo-docs/build-an-oracle/guides/plugin-http-endpoints.mdx` — the developer-facing version of adding HTTP endpoints via a plugin.

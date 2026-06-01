import { CacheModule } from '@nestjs/cache-manager';
import {
  type DynamicModule,
  Module,
  type MiddlewareConsumer,
  type NestModule,
  RequestMethod,
  type Type,
} from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { APP_GUARD } from '@nestjs/core';
import { ScheduleModule } from '@nestjs/schedule';
import { ThrottlerGuard } from '@nestjs/throttler';
import type { AuthExcludedRoute } from '../plugin-api/types.js';
import { AuthHeaderMiddleware } from '../modules/auth/auth-header.middleware.js';
import { AuthModule } from '../modules/auth/auth.module.js';
import { BlobStoreModule } from '../modules/blob-store/blob-store.module.js';
import { HealthModule } from '../modules/health/health.module.js';
import { MessagesModule } from '../modules/messages/messages.module.js';
import { SessionsModule } from '../modules/sessions/sessions.module.js';
import { SubscriptionMiddleware } from '../modules/subscription/subscription.middleware.js';
import { SubscriptionModule } from '../modules/subscription/subscription.module.js';
import { ThrottlerModule } from '../modules/throttler/throttler.module.js';
import { UcanModule } from '../modules/ucan/ucan.module.js';
import { WsModule } from '../modules/ws/ws.module.js';

export interface RuntimeAppModuleOptions {
  /** Pre-validated env values, fed straight into `ConfigModule`. */
  validatedEnv: Record<string, unknown>;
  /** Additional modules supplied by the fork at `createOracleApp`. */
  userNestModules?: Array<Type | DynamicModule>;
  /** Plugin-shipped NestJS modules collected from bundled plugins. */
  pluginNestModules?: Array<Type | DynamicModule>;
  /**
   * Plugin-declared routes that must be excluded from `AuthHeaderMiddleware`.
   * Aggregated from each loaded plugin's `getAuthExcludedRoutes()` and
   * concatenated onto the runtime's own exclusion list (`/`, `/health`,
   * `/docs`, `/docs/(.*)`).
   */
  pluginAuthExclusions?: AuthExcludedRoute[];
  /**
   * Whether to wire `SubscriptionMiddleware` ahead of the routes. The credits
   * plugin owns that decision — when credits is disabled, only auth runs.
   */
  enableSubscriptionMiddleware: boolean;
}

const AUTH_EXCLUDED_ROUTES: AuthExcludedRoute[] = [
  { path: '/', method: RequestMethod.ALL },
  { path: '/health', method: RequestMethod.ALL },
  { path: '/docs', method: RequestMethod.ALL },
  { path: '/docs/(.*)', method: RequestMethod.ALL },
];

/**
 * Normalize a plugin-declared route into the shape NestJS's
 * `MiddlewareConsumer.exclude(...)` expects:
 *  - default `method` to `RequestMethod.ALL`
 *  - leave the leading-slash decision to the plugin author — Nest matches both
 */
function normalizeAuthExclusion(route: AuthExcludedRoute): {
  path: string;
  method: RequestMethod;
} {
  return {
    path: route.path,
    method: route.method ?? RequestMethod.ALL,
  };
}

/**
 * The runtime's root NestJS module. Built dynamically per oracle so the
 * fork-supplied `nestModules` and plugin-shipped modules can be folded
 * into a single import list alongside the Tier-0 modules.
 *
 * `ConfigModule` is registered globally with the merged schema's parsed
 * output — the schema itself ran in the boot composer so any failure
 * already surfaced before this module loads.
 */
@Module({})
export class RuntimeAppModule implements NestModule {
  private static enableSubscription = false;

  private static authExcludedRoutes: Array<{
    path: string;
    method: RequestMethod;
  }> = [...AUTH_EXCLUDED_ROUTES.map(normalizeAuthExclusion)];

  static register(opts: RuntimeAppModuleOptions): DynamicModule {
    RuntimeAppModule.enableSubscription = opts.enableSubscriptionMiddleware;

    const mergedExclusions = [
      ...AUTH_EXCLUDED_ROUTES,
      ...(opts.pluginAuthExclusions ?? []),
    ].map(normalizeAuthExclusion);
    RuntimeAppModule.authExcludedRoutes = mergedExclusions;

    const validatedEnv = opts.validatedEnv;

    const imports: DynamicModule['imports'] = [
      ConfigModule.forRoot({
        isGlobal: true,
        ignoreEnvFile: true,
        load: [() => validatedEnv],
      }),
      CacheModule.register({ isGlobal: true }),
      ScheduleModule.forRoot(),
      ThrottlerModule,
      UcanModule,
      BlobStoreModule,
      AuthModule,
      SubscriptionModule,
      SessionsModule,
      MessagesModule,
      WsModule,
      HealthModule,
      ...(opts.pluginNestModules ?? []),
      ...(opts.userNestModules ?? []),
    ];

    return {
      module: RuntimeAppModule,
      imports,
      providers: [
        {
          provide: APP_GUARD,
          useClass: ThrottlerGuard,
        },
      ],
    };
  }

  configure(consumer: MiddlewareConsumer): void {
    const excluded = RuntimeAppModule.authExcludedRoutes;
    if (RuntimeAppModule.enableSubscription) {
      consumer
        .apply(AuthHeaderMiddleware, SubscriptionMiddleware)
        .exclude(...excluded)
        .forRoutes('*');
    } else {
      consumer
        .apply(AuthHeaderMiddleware)
        .exclude(...excluded)
        .forRoutes('*');
    }
  }
}

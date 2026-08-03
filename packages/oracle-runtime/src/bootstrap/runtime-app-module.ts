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
import type { DomainContext } from '../constitution/domain-context.js';
import type { AuthExcludedRoute } from '../plugin-api/types.js';
import { AuthHeaderMiddleware } from '../modules/auth/auth-header.middleware.js';
import { AuthModule } from '../modules/auth/auth.module.js';
import { BlobStoreModule } from '../modules/blob-store/blob-store.module.js';
import { ByoLlmModule } from '../modules/byo-llm/byo-llm.module.js';
import { HealthModule } from '../modules/health/health.module.js';
import { MessagesModule } from '../modules/messages/messages.module.js';
import { ModelsModule } from '../modules/models/models.module.js';
import { SessionsModule } from '../modules/sessions/sessions.module.js';
import { SubscriptionMiddleware } from '../modules/subscription/subscription.middleware.js';
import { SubscriptionModule } from '../modules/subscription/subscription.module.js';
import { DomainContextModule } from '../modules/domain-context/domain-context.module.js';
import { ThrottlerModule } from '../modules/throttler/throttler.module.js';
import { UcanModule } from '../modules/ucan/ucan.module.js';
import { WsModule } from '../modules/ws/ws.module.js';

export interface RuntimeAppModuleOptions {
  /** Pre-validated env values, fed straight into `ConfigModule`. */
  validatedEnv: Record<string, unknown>;
  /**
   * The entity's constitution, already loaded and vetted by `createOracleApp`.
   * Bound into the container so the gate, the prompt composer and the decision
   * recorder read one value rather than each re-reading the document.
   */
  domainContext: DomainContext;
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
  // The model catalog is non-sensitive and must be readable before a user has
  // an active subscription, so the picker can render up front.
  { path: '/models', method: RequestMethod.GET },
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
      DomainContextModule.register(opts.domainContext, {
        // Validated at boot: strict enforcement requires this room, because
        // gating every call while the record of why goes nowhere would make
        // the enforcement real and the accountability imaginary.
        decisionsRoomId:
          typeof validatedEnv.MATRIX_DECISIONS_ROOM_ID === 'string'
            ? validatedEnv.MATRIX_DECISIONS_ROOM_ID
            : null,
      }),
      UcanModule,
      BlobStoreModule,
      ByoLlmModule,
      AuthModule,
      SubscriptionModule,
      SessionsModule,
      MessagesModule,
      ModelsModule,
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

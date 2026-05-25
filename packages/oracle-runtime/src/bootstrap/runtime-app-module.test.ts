/**
 * @fileoverview Tests for `RuntimeAppModule` auth-middleware wiring — in
 * particular the plugin-declared exclusion routes (TASK-35).
 *
 * `RuntimeAppModule` keeps the merged exclusion list in a static field so the
 * NestJS `configure` hook can read it after `register` runs. These tests:
 *  1. Call `register` with a synthetic `pluginAuthExclusions` list.
 *  2. Invoke `configure` on a fresh instance with a mock
 *     `MiddlewareConsumer` that records the args passed to `.exclude(...)`.
 *  3. Assert the recorded args match the runtime defaults + plugin contributions.
 *
 * We don't boot Nest here — these are unit tests on the configurer wiring.
 */

import { RequestMethod, type MiddlewareConsumer } from '@nestjs/common';
import { describe, expect, it } from 'vitest';
import type { AuthExcludedRoute } from '../plugin-api/types.js';
import { RuntimeAppModule } from './runtime-app-module.js';

interface RecordedExclude {
  applyArgsCount: number;
  excludeArgs: unknown[];
  forRoutesArgs: unknown[];
}

/**
 * Build a chainable `MiddlewareConsumer` stub that captures the args passed to
 * each method. NestJS's real consumer threads through several internal classes
 * — we only need the four methods `RuntimeAppModule.configure` calls.
 */
function buildRecordingConsumer(): {
  consumer: MiddlewareConsumer;
  recorded: RecordedExclude;
} {
  const recorded: RecordedExclude = {
    applyArgsCount: 0,
    excludeArgs: [],
    forRoutesArgs: [],
  };
  const chain = {
    apply: (...args: unknown[]) => {
      recorded.applyArgsCount = args.length;
      return chain;
    },
    exclude: (...args: unknown[]) => {
      recorded.excludeArgs = args;
      return chain;
    },
    forRoutes: (...args: unknown[]) => {
      recorded.forRoutesArgs = args;
      return chain;
    },
  };
  return { consumer: chain as unknown as MiddlewareConsumer, recorded };
}

const DEFAULT_EXCLUDED_PATHS = ['/', '/health', '/docs', '/docs/(.*)'];

describe('RuntimeAppModule — auth-excluded routes', () => {
  it('keeps the runtime defaults when no plugin exclusions are supplied', () => {
    RuntimeAppModule.register({
      validatedEnv: {},
      enableSubscriptionMiddleware: false,
    });

    const { consumer, recorded } = buildRecordingConsumer();
    new RuntimeAppModule().configure(consumer);

    expect(recorded.excludeArgs).toEqual(
      DEFAULT_EXCLUDED_PATHS.map((path) => ({
        path,
        method: RequestMethod.ALL,
      })),
    );
    expect(recorded.forRoutesArgs).toEqual(['*']);
  });

  it('treats an empty plugin exclusion list the same as omitting it', () => {
    RuntimeAppModule.register({
      validatedEnv: {},
      pluginAuthExclusions: [],
      enableSubscriptionMiddleware: false,
    });

    const { consumer, recorded } = buildRecordingConsumer();
    new RuntimeAppModule().configure(consumer);

    expect(recorded.excludeArgs).toHaveLength(DEFAULT_EXCLUDED_PATHS.length);
    for (const path of DEFAULT_EXCLUDED_PATHS) {
      expect(recorded.excludeArgs).toContainEqual({
        path,
        method: RequestMethod.ALL,
      });
    }
  });

  it('appends plugin-declared routes to the exclusion list', () => {
    const pluginRoute: AuthExcludedRoute = {
      path: 'weather/now',
      method: RequestMethod.GET,
    };
    RuntimeAppModule.register({
      validatedEnv: {},
      pluginAuthExclusions: [pluginRoute],
      enableSubscriptionMiddleware: false,
    });

    const { consumer, recorded } = buildRecordingConsumer();
    new RuntimeAppModule().configure(consumer);

    expect(recorded.excludeArgs).toContainEqual({
      path: 'weather/now',
      method: RequestMethod.GET,
    });
    // Runtime defaults still present.
    for (const path of DEFAULT_EXCLUDED_PATHS) {
      expect(recorded.excludeArgs).toContainEqual({
        path,
        method: RequestMethod.ALL,
      });
    }
  });

  it('defaults missing `method` to RequestMethod.ALL', () => {
    RuntimeAppModule.register({
      validatedEnv: {},
      pluginAuthExclusions: [{ path: 'public/webhook' }],
      enableSubscriptionMiddleware: false,
    });

    const { consumer, recorded } = buildRecordingConsumer();
    new RuntimeAppModule().configure(consumer);

    expect(recorded.excludeArgs).toContainEqual({
      path: 'public/webhook',
      method: RequestMethod.ALL,
    });
  });

  it('does not crash when two plugins declare the same path — both included', () => {
    RuntimeAppModule.register({
      validatedEnv: {},
      pluginAuthExclusions: [
        { path: 'shared/route', method: RequestMethod.GET },
        { path: 'shared/route', method: RequestMethod.POST },
      ],
      enableSubscriptionMiddleware: false,
    });

    const { consumer, recorded } = buildRecordingConsumer();
    new RuntimeAppModule().configure(consumer);

    const sharedMatches = (
      recorded.excludeArgs as Array<{
        path: string;
        method: RequestMethod;
      }>
    ).filter((r) => r.path === 'shared/route');
    expect(sharedMatches).toHaveLength(2);
    expect(sharedMatches.map((r) => r.method).sort()).toEqual(
      [RequestMethod.GET, RequestMethod.POST].sort(),
    );
  });

  it('threads plugin exclusions through when subscription middleware is enabled', () => {
    RuntimeAppModule.register({
      validatedEnv: {},
      pluginAuthExclusions: [
        { path: 'stripe/webhook', method: RequestMethod.POST },
      ],
      enableSubscriptionMiddleware: true,
    });

    const { consumer, recorded } = buildRecordingConsumer();
    new RuntimeAppModule().configure(consumer);

    // Both AuthHeaderMiddleware + SubscriptionMiddleware applied.
    expect(recorded.applyArgsCount).toBe(2);
    expect(recorded.excludeArgs).toContainEqual({
      path: 'stripe/webhook',
      method: RequestMethod.POST,
    });
    // Runtime defaults preserved.
    for (const path of DEFAULT_EXCLUDED_PATHS) {
      expect(recorded.excludeArgs).toContainEqual({
        path,
        method: RequestMethod.ALL,
      });
    }
  });
});

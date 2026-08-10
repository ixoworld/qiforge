import { ConfigService } from '@nestjs/config';
import { baseEnvSchema, type BaseEnv } from './base-env-schema.js';
import { normalizeDid } from './normalize-did.js';

/**
 * Runtime config view used by Tier-0 services that need an env var
 * before NestJS DI is available (e.g. the Matrix checkpointer initialises
 * its singleton during module factory construction).
 *
 * Mirrors the `get` / `getOrThrow` accessors a `ConfigService<BaseEnv>`
 * would expose so callers don't care which path they took. The plugin
 * config schemas merge on top via the boot composer and remain reachable
 * via the same `ConfigService` once Nest is up — but for the checkpointer
 * we only ever need Tier-0 keys plus the derived `ORACLE_DID`.
 */
export type BaseEnvWithDerived = BaseEnv & {
  ORACLE_DID: string;
};

export interface BaseEnvAccessor {
  get<K extends keyof BaseEnvWithDerived>(
    key: K,
    defaultValue?: BaseEnvWithDerived[K],
  ): BaseEnvWithDerived[K] | undefined;
  getOrThrow<K extends keyof BaseEnvWithDerived>(key: K): BaseEnvWithDerived[K];
}

let _singleton: ConfigService<BaseEnvWithDerived> | undefined;

function singletonConfigService(): ConfigService<BaseEnvWithDerived> {
  if (!_singleton) {
    const parsed = baseEnvSchema.safeParse(process.env);
    const baseVars = parsed.success
      ? parsed.data
      : (process.env as Record<string, unknown>);

    let oracleDid: string | undefined;
    const matrixUserId =
      typeof process.env.MATRIX_ORACLE_ADMIN_USER_ID === 'string'
        ? process.env.MATRIX_ORACLE_ADMIN_USER_ID
        : undefined;
    if (matrixUserId) {
      try {
        oracleDid = normalizeDid(matrixUserId);
      } catch {
        // Leave ORACLE_DID unset; getOrThrow callers will fail loudly.
      }
    }

    const merged: Record<string, unknown> = {
      ...baseVars,
      ...(oracleDid ? { ORACLE_DID: oracleDid } : {}),
    };
    _singleton = new ConfigService<BaseEnvWithDerived>(merged);
  }
  return _singleton;
}

/**
 * Returns a `BaseEnvAccessor` backed by the supplied `ConfigService`
 * (when called from inside a Nest DI scope) or by the lazily-built
 * singleton seeded from `process.env`.
 *
 * Test helpers can call `resetBaseEnvConfigForTesting()` to clear the
 * singleton between cases.
 */
export function getBaseEnvConfig(
  configService?: ConfigService<BaseEnvWithDerived>,
): BaseEnvAccessor {
  const svc = configService ?? singletonConfigService();
  return {
    get<K extends keyof BaseEnvWithDerived>(
      key: K,
      defaultValue?: BaseEnvWithDerived[K],
    ): BaseEnvWithDerived[K] | undefined {
      return svc.get(key, defaultValue);
    },
    getOrThrow<K extends keyof BaseEnvWithDerived>(
      key: K,
    ): BaseEnvWithDerived[K] {
      return svc.getOrThrow(key);
    },
  };
}

export function resetBaseEnvConfigForTesting(): void {
  _singleton = undefined;
}

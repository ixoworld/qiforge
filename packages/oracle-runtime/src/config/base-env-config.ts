import { ConfigService } from '@nestjs/config';
import { baseEnvSchema, type BaseEnv } from './base-env-schema.js';

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

/**
 * Convert hyphen-delimited Matrix usernames (`@did-ixo-ixo1...:host`) to
 * colon DIDs (`did:ixo:ixo1...`). Lifted verbatim from
 * `apps/app/src/utils/header.utils.ts` so the checkpointer can derive
 * `ORACLE_DID` from `MATRIX_ORACLE_ADMIN_USER_ID` without depending on
 * the AuthModule (which lives in a parallel relocation task).
 */
function normalizeDid(input: string): string {
  const username = input.split(':')[0] ?? '';
  const parts = username.split('-');
  if (parts.length < 3 || parts[0] !== '@did') {
    throw new Error(`Invalid DID format: ${input}`);
  }
  const namespace = parts[1];
  const identifier = parts.slice(2).join('-');
  return `did:${namespace}:${identifier}`;
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
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      return svc.get(key as any, defaultValue);
    },
    getOrThrow<K extends keyof BaseEnvWithDerived>(
      key: K,
    ): BaseEnvWithDerived[K] {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      return svc.getOrThrow(key as any);
    },
  };
}

export function resetBaseEnvConfigForTesting(): void {
  _singleton = undefined;
}

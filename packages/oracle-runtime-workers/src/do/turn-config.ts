import { baseEnvSchema, TURN_RECURSION_LIMIT_DEFAULT } from '../core/env';
import type { OracleWorkerEnv } from './contracts';

/**
 * The LangGraph `recursionLimit` every turn runs with (HTTP/SSE turns, room
 * turns and the task runner's background turns all build their config in
 * one place). `TURN_RECURSION_LIMIT` is validated by the base env schema at
 * boot; this re-parses the raw Worker var through the same field so the
 * turn never sees anything but a positive integer, and falls back to the
 * default (with a warning) if the var is somehow malformed.
 */
export function turnRecursionLimit(
  env: Pick<OracleWorkerEnv, 'TURN_RECURSION_LIMIT'>,
  log: Pick<Console, 'warn'> = console,
): number {
  const parsed = baseEnvSchema.shape.TURN_RECURSION_LIMIT.safeParse(
    env.TURN_RECURSION_LIMIT,
  );
  if (parsed.success) return parsed.data;
  log.warn(
    `[turn] TURN_RECURSION_LIMIT=${JSON.stringify(env.TURN_RECURSION_LIMIT)} is not a positive integer; using ${TURN_RECURSION_LIMIT_DEFAULT}`,
  );
  return TURN_RECURSION_LIMIT_DEFAULT;
}

/**
 * Chain REST (the node's LCD gateway) reads: one GET, bounded and parsed,
 * under the shared retry policy.
 */
import type { z } from 'zod';
import {
  exchange,
  unavailable,
  withRetry,
  type ChainCall,
  type Outcome,
} from './http';

export const REST_MAX_BYTES = 512 * 1024;
/** Per-attempt wall bound for one REST read. */
export const REST_ATTEMPT_TIMEOUT_MS = 8_000;

/**
 * `GET ${restUrl}${path}` parsed by `schema`. `label` names the read in the
 * log line (never the path: it carries an address). A body that is not
 * JSON or not the expected shape is `unavailable` and is not retried. A 404
 * is `unavailable` unless `notFoundOn404` (a resource that may be absent).
 */
export function restJson<S extends z.ZodType>(
  call: ChainCall,
  path: string,
  schema: S,
  opts: {
    label: string;
    timeoutMs?: number;
    maxBytes?: number;
    notFoundOn404?: boolean;
  },
): Promise<Outcome<z.infer<S>>> {
  const base = call.restUrl.replace(/\/+$/, '');
  const url = `${base}${path}`;
  return withRetry(call, { label: opts.label, upstream: base }, async () => {
    const answer = await exchange(
      call,
      'chain',
      url,
      { method: 'GET', headers: { accept: 'application/json' } },
      {
        timeoutMs: opts.timeoutMs ?? REST_ATTEMPT_TIMEOUT_MS,
        maxBytes: opts.maxBytes ?? REST_MAX_BYTES,
        notFoundOn404: opts.notFoundOn404 ?? false,
      },
    );
    if (!answer.ok) return answer;
    let body: unknown;
    try {
      body = JSON.parse(answer.value);
    } catch {
      return {
        ok: false,
        failure: unavailable(
          'chain',
          'it answered something that is not JSON',
          false,
        ),
        retry: false,
        note: 'malformed JSON',
      };
    }
    const parsed = schema.safeParse(body);
    if (!parsed.success)
      return {
        ok: false,
        failure: unavailable(
          'chain',
          'it answered in an unexpected shape',
          false,
        ),
        retry: false,
        note: 'unexpected shape',
      };
    return { ok: true, value: parsed.data };
  });
}

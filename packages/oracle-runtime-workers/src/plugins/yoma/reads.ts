/**
 * The Yoma plugin's upstream reads, all under ixo-chain's policy
 * (`../ixo-chain/http.ts`): each attempt bounded in time and bytes, no
 * redirects, one jittered retry on 429/5xx/network, unhealthy upstreams held
 * back for 10 s, and a {@link Failure} instead of a throw.
 *
 *   - the Jambo worker's job list (`job-list`): the entities Yoma admins
 *     chose and the collections they hid;
 *   - documents an entity links to (`document`): profiles and form
 *     templates, https only;
 *   - Blocksync (`../ixo-chain/blocksync.ts`): collections, entities, claims;
 *   - chain REST (`../ixo-chain/rest.ts`): authz grants.
 */
import type { z } from 'zod';
import { blocksyncLookup, type AliasedField } from '../ixo-chain/blocksync';
import {
  exchange,
  unavailable,
  withRetry,
  type ChainCall,
  type Failure,
  type Outcome,
  type Source,
} from '../ixo-chain/http';
import { restJson } from '../ixo-chain/rest';

export const LOG_TAG = '[yoma]';

/** Per-attempt wall bound for the job list and documents. */
export const DOCUMENT_ATTEMPT_TIMEOUT_MS = 8_000;
/** Largest job-list answer read. */
export const JOB_LIST_MAX_BYTES = 256 * 1024;
/** Largest entity profile read. */
export const PROFILE_MAX_BYTES = 64 * 1024;
/** Largest form template read (the biggest Yoma form on mainnet is about 20 KB). */
export const FORM_MAX_BYTES = 512 * 1024;

/**
 * `GET url` as JSON parsed by `schema`, under the shared policy. `what`
 * names the document in a `too_large` answer ("This form is too large to
 * read here.").
 */
export async function getJson<S extends z.ZodType>(
  call: ChainCall,
  source: Extract<Source, 'job-list' | 'document'>,
  url: string,
  schema: S,
  opts: {
    label: string;
    maxBytes: number;
    what: string;
    notFoundOn404?: boolean;
  },
): Promise<Outcome<z.infer<S>>> {
  const read = await getJsonOnce(call, source, url, schema, opts);
  if (read.ok || read.failure.reason !== 'too_large') return read;
  return {
    ok: false,
    failure: {
      reason: 'too_large',
      detail: `${opts.what} is too large to read here; it can still be opened on jambo.yoma.world.`,
      retryable: false,
    },
  };
}

function getJsonOnce<S extends z.ZodType>(
  call: ChainCall,
  source: Extract<Source, 'job-list' | 'document'>,
  url: string,
  schema: S,
  opts: { label: string; maxBytes: number; notFoundOn404?: boolean },
): Promise<Outcome<z.infer<S>>> {
  let upstream: string;
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== 'https:' || parsed.username || parsed.password)
      return Promise.resolve({
        ok: false,
        failure: unavailable(
          source,
          'its address is not a plain https URL',
          false,
        ),
      });
    upstream = parsed.origin;
  } catch {
    return Promise.resolve({
      ok: false,
      failure: unavailable(source, 'its address is not a URL', false),
    });
  }
  return withRetry(
    call,
    { label: opts.label, upstream, tag: LOG_TAG },
    async () => {
      const answer = await exchange(
        call,
        source,
        url,
        { method: 'GET', headers: { accept: 'application/json' } },
        {
          timeoutMs: DOCUMENT_ATTEMPT_TIMEOUT_MS,
          maxBytes: opts.maxBytes,
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
            source,
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
            source,
            'it answered in an unexpected shape',
            false,
          ),
          retry: false,
          note: 'unexpected shape',
        };
      return { ok: true, value: parsed.data };
    },
  );
}

/** One Blocksync document; a field error is the whole read's failure here (Yoma asks few, related fields). */
export async function blocksyncRead(
  call: ChainCall,
  fields: readonly AliasedField[],
): Promise<Outcome<Record<string, unknown>>> {
  if (!call.blocksyncUrl)
    return {
      ok: false,
      failure: unavailable(
        'blocksync',
        'no valid BLOCKSYNC_GRAPHQL_URL is configured',
        false,
      ),
    };
  const read = await blocksyncLookup(call, fields, { tag: LOG_TAG });
  if (!read.ok) return read;
  const { data, errors } = read.value;
  if (errors.length || !data) {
    const timeout = errors.some((e) => /statement timeout/i.test(e.message));
    const failure: Failure = timeout
      ? {
          reason: 'index_timeout',
          detail: 'The index could not answer in time; try again in a moment.',
          retryable: false,
        }
      : unavailable('blocksync', 'it could not answer that question', true);
    return { ok: false, failure };
  }
  return { ok: true, value: data };
}

export function restRead<S extends z.ZodType>(
  call: ChainCall,
  path: string,
  schema: S,
  label: string,
): Promise<Outcome<z.infer<S>>> {
  return restJson(call, path, schema, { label, tag: LOG_TAG });
}

/** A value as a GraphQL string literal (ids are checked against their pattern first). */
export const literal = (value: string) => JSON.stringify(value);

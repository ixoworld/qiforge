/**
 * Blocksync GraphQL reads: one POST of a document whose ids are inlined as
 * literals (never JSON variables: two `messages` fields with variables in
 * one document fail on the server), under the shared retry policy.
 *
 * PostGraphile answers field by field: one alias can be null with an error
 * naming it while the others are fine, so errors are returned beside the
 * data, never thrown. "current transaction is aborted" and "Connection
 * terminated unexpectedly" say nothing about the question: the aliases
 * they name are asked again once, in a document of only those aliases,
 * and the answers merged; a statement timeout is never asked again (it
 * would only time out again).
 */
import { z } from 'zod';
import {
  exchange,
  unavailable,
  withRetry,
  type Attempt,
  type ChainCall,
  type Outcome,
} from './http';

export const BLOCKSYNC_MAX_BYTES = 1024 * 1024;
/**
 * Per-attempt wall bound. Above Blocksync's own 8 s statement timeout, so
 * the server's "statement timeout" answer arrives instead of our abort.
 */
export const BLOCKSYNC_ATTEMPT_TIMEOUT_MS = 11_000;

export const TRANSIENT_ERROR =
  /current transaction is aborted|Connection terminated unexpectedly/;
export const STATEMENT_TIMEOUT = /statement timeout/i;

export interface GraphqlError {
  /** The response path; empty when the error is the whole document's. */
  path: string[];
  message: string;
}

export interface BlocksyncAnswer {
  data: Record<string, unknown> | null;
  errors: GraphqlError[];
}

const responseSchema = z.object({
  data: z.record(z.string(), z.unknown()).nullable().optional(),
  errors: z
    .array(
      z.object({
        message: z.string(),
        path: z.array(z.union([z.string(), z.number()])).optional(),
      }),
    )
    .optional(),
});

/** One aliased root field of a lookup document; `field` begins with `${alias}:`. */
export interface AliasedField {
  alias: string;
  field: string;
}

/** The fields as one GraphQL document. */
export function lookupDocument(fields: readonly AliasedField[]): string {
  return `query ChainLookup { ${fields.map((f) => f.field).join(' ')} }`;
}

/** Whether `error` concerns `alias` (an error without a path concerns every alias). */
const concerns = (error: GraphqlError, alias: string) =>
  error.path.length === 0 || error.path[0] === alias;

/** The fields to ask again: those a transient error names and no statement timeout does. */
function retryFields(
  answer: BlocksyncAnswer,
  fields: readonly AliasedField[],
): AliasedField[] {
  const named = (alias: string, pattern: RegExp) =>
    answer.errors.some(
      (error) => pattern.test(error.message) && concerns(error, alias),
    );
  return fields.filter(
    ({ alias }) =>
      named(alias, TRANSIENT_ERROR) && !named(alias, STATEMENT_TIMEOUT),
  );
}

/**
 * The first answer with the retried aliases replaced by the second's. An
 * error without a path is pinned to the aliases its answer covered, so a
 * whole-document error of one answer never fails an alias the other
 * answered.
 */
function merge(
  first: BlocksyncAnswer,
  second: BlocksyncAnswer,
  fields: readonly AliasedField[],
  retried: readonly AliasedField[],
): BlocksyncAnswer {
  const again = new Set(retried.map((f) => f.alias));
  const data: Record<string, unknown> = { ...first.data };
  for (const alias of again)
    if (second.data && alias in second.data) data[alias] = second.data[alias];
    else delete data[alias];
  const pin = (error: GraphqlError, aliases: readonly string[]) =>
    error.path.length
      ? [error]
      : aliases.map((alias) => ({ path: [alias], message: error.message }));
  const kept = fields.map((f) => f.alias).filter((alias) => !again.has(alias));
  return {
    data,
    errors: [
      ...first.errors
        .filter(
          (error) => !error.path.length || !again.has(error.path[0] ?? ''),
        )
        .flatMap((error) => pin(error, kept)),
      ...second.errors.flatMap((error) => pin(error, [...again])),
    ],
  };
}

/** One POST of `document`, parsed. */
async function post(
  call: ChainCall,
  document: string,
  opts: { timeoutMs?: number; maxBytes?: number },
): Promise<Attempt<BlocksyncAnswer>> {
  const answer = await exchange(
    call,
    'blocksync',
    call.blocksyncUrl,
    {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json',
      },
      body: JSON.stringify({ query: document }),
    },
    {
      timeoutMs: opts.timeoutMs ?? BLOCKSYNC_ATTEMPT_TIMEOUT_MS,
      maxBytes: opts.maxBytes ?? BLOCKSYNC_MAX_BYTES,
    },
  );
  if (!answer.ok) return answer;
  let json: unknown;
  try {
    json = JSON.parse(answer.value);
  } catch {
    return {
      ok: false,
      failure: unavailable(
        'blocksync',
        'it answered something that is not JSON',
        false,
      ),
      retry: false,
      note: 'malformed JSON',
    };
  }
  const parsed = responseSchema.safeParse(json);
  if (!parsed.success || (!parsed.data.data && !parsed.data.errors?.length))
    return {
      ok: false,
      failure: unavailable(
        'blocksync',
        'it answered in an unexpected shape',
        false,
      ),
      retry: false,
      note: 'unexpected shape',
    };
  const errors = (parsed.data.errors ?? []).map((error) => ({
    path: (error.path ?? []).map(String),
    message: error.message,
  }));
  return { ok: true, value: { data: parsed.data.data ?? null, errors } };
}

/**
 * POST the fields as one document to the configured Blocksync GraphQL
 * endpoint. After a transient error, only the aliases it named are asked
 * again and merged into the first answer; if that retry fails, the first
 * answer stands.
 */
export function blocksyncLookup(
  call: ChainCall,
  fields: readonly AliasedField[],
  opts: { timeoutMs?: number; maxBytes?: number } = {},
): Promise<Outcome<BlocksyncAnswer>> {
  let first: BlocksyncAnswer | null = null;
  let retried: AliasedField[] = [];
  return withRetry(
    call,
    { label: 'blocksync', upstream: call.blocksyncUrl },
    async () => {
      const asked = first ? retried : fields;
      const read = await post(call, lookupDocument(asked), opts);
      if (!read.ok) return read;
      const again = retryFields(read.value, asked);
      const value = first
        ? merge(first, read.value, fields, asked)
        : read.value;
      if (!first && again.length) {
        first = read.value;
        retried = again;
      }
      return again.length
        ? { ok: true, value, retry: true, note: 'transient GraphQL error' }
        : { ok: true, value };
    },
  );
}

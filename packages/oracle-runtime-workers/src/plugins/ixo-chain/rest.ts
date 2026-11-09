/**
 * Chain REST (the node's LCD gateway) reads: one GET, bounded and parsed,
 * under the shared retry policy.
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
import { clip } from './summaries';

export const REST_MAX_BYTES = 512 * 1024;
/** Per-attempt wall bound for one REST read. */
export const REST_ATTEMPT_TIMEOUT_MS = 8_000;

/** How one REST read is bounded, and which answers mean "none". */
export interface RestOptions {
  /** Names the read in log lines (never the path: it carries an address). */
  label: string;
  /** The log line's tag (`[ixo-chain]` by default). */
  tag?: string;
  timeoutMs?: number;
  maxBytes?: number;
  /** A 404 is a quiet `not_found` failure instead of `unavailable`. */
  notFoundOn404?: boolean;
  /**
   * HTTP statuses that mean "there is none" for this resource (e.g.
   * `[400, 404]` for a vote never cast): such an answer is `Absent`, an
   * `ok` result, neither retried nor logged. Meant for 4xx statuses; it
   * takes precedence over `notFoundOn404`. A 400 counts only when its body
   * is a gRPC-gateway error with code 3 (InvalidArgument) or 5 (NotFound);
   * any other 400 is a failure.
   */
  noneOn?: readonly number[];
  /**
   * A CosmWasm read (a smart query, or a contract's info): a contract's
   * refusal of the query (the gateway's HTTP 500 whose body says `query
   * wasm contract failed`, e.g. no such proposal, or a query that contract
   * does not know) and an address with no contract at all (`no such
   * contract`) are a quiet `invalid_input` failure with the chain's words,
   * not retried; asking again cannot change it. Any other 500 stays
   * `unavailable`.
   */
  contractQuery?: boolean;
}

/** gRPC InvalidArgument and NotFound: the codes of a gateway 400 that says "there is none". */
const NONE_GRPC_CODES: readonly number[] = [3, 5];
const grpcError = z.object({ code: z.number() });

/** Whether `answer` is one of the `noneOn` statuses, a 400 only with a "none" gRPC code. */
function isNone(
  answer: Extract<Attempt<string>, { ok: false }>,
  noneOn: readonly number[] | undefined,
): boolean {
  if (answer.status === undefined || !noneOn?.includes(answer.status))
    return false;
  if (answer.status !== 400) return true;
  if (answer.errorBody === undefined) return false;
  let body: unknown;
  try {
    body = JSON.parse(answer.errorBody);
  } catch {
    return false;
  }
  const parsed = grpcError.safeParse(body);
  return parsed.success && NONE_GRPC_CODES.includes(parsed.data.code);
}

/** The most of a contract's refusal kept in the failure's detail. */
const CONTRACT_REFUSAL_CHARS = 300;
const gatewayError = z.object({ message: z.string() });
const WASM_QUERY_FAILED = /query wasm contract failed: ([\s\S]*)$/;
const WASM_NO_SUCH_CONTRACT = /\bno such contract: ([\s\S]*)$/;

/**
 * The chain's words when `answer` is a CosmWasm read it refused: a smart
 * query the contract refused (the gateway wraps it as `codespace wasm code
 * 9: query wasm contract failed: <reason>`), or an address without a
 * contract (`codespace wasm code 22: no such contract: <address>`), one line
 * and at most {@link CONTRACT_REFUSAL_CHARS}; undefined for any other answer.
 */
function contractRefusal(
  answer: Extract<Attempt<string>, { ok: false }>,
): string | undefined {
  if (answer.status !== 500 || answer.errorBody === undefined) return undefined;
  let body: unknown;
  try {
    body = JSON.parse(answer.errorBody);
  } catch {
    return undefined;
  }
  const parsed = gatewayError.safeParse(body);
  if (!parsed.success) return undefined;
  const { message } = parsed.data;
  const line = (words: string) =>
    clip(words.replace(/\s+/g, ' ').trim(), CONTRACT_REFUSAL_CHARS);
  const refused = WASM_QUERY_FAILED.exec(message)?.[1];
  if (refused !== undefined)
    return `The contract refused the query: ${line(refused)}`;
  const missing = WASM_NO_SUCH_CONTRACT.exec(message)?.[1];
  if (missing !== undefined)
    return `There is no contract at that address: ${line(missing)}`;
  return undefined;
}

/** The answer of a read whose upstream answered one of its `noneOn` statuses. */
export type Absent = { ok: true; absent: true };

/** What one attempt found: the parsed body, or a "none" status. */
type Found<T> = { absent: false; value: T } | { absent: true };

/**
 * `GET ${restUrl}${path}` parsed by `schema`. A body that is not JSON or
 * not the expected shape is `unavailable` and is not retried. A 404 is
 * `unavailable` unless `notFoundOn404` (a resource that may be absent); a
 * status in `noneOn` is {@link Absent} (a 400 only with a gRPC code 3 or
 * 5, read from at most 8 KiB of its body).
 */
export function restJson<S extends z.ZodType>(
  call: ChainCall,
  path: string,
  schema: S,
  opts: RestOptions & { noneOn?: undefined },
): Promise<Outcome<z.infer<S>>>;
export function restJson<S extends z.ZodType>(
  call: ChainCall,
  path: string,
  schema: S,
  opts: RestOptions & { noneOn: readonly number[] },
): Promise<Outcome<z.infer<S>> | Absent>;
export function restJson<S extends z.ZodType>(
  call: ChainCall,
  path: string,
  schema: S,
  opts: RestOptions,
): Promise<Outcome<z.infer<S>> | Absent>;
export async function restJson<S extends z.ZodType>(
  call: ChainCall,
  path: string,
  schema: S,
  opts: RestOptions,
): Promise<Outcome<z.infer<S>> | Absent> {
  const base = call.restUrl.replace(/\/+$/, '');
  const url = `${base}${path}`;
  const errorBodyOn = [
    ...(opts.noneOn?.includes(400) ? [400] : []),
    ...(opts.contractQuery ? [500] : []),
  ];
  const read = await withRetry<Found<z.infer<S>>>(
    call,
    {
      label: opts.label,
      upstream: base,
      ...(opts.tag ? { tag: opts.tag } : {}),
    },
    async () => {
      const answer = await exchange(
        call,
        'chain',
        url,
        { method: 'GET', headers: { accept: 'application/json' } },
        {
          timeoutMs: opts.timeoutMs ?? REST_ATTEMPT_TIMEOUT_MS,
          maxBytes: opts.maxBytes ?? REST_MAX_BYTES,
          notFoundOn404: opts.notFoundOn404 ?? false,
          ...(errorBodyOn.length > 0 ? { errorBodyOn } : {}),
        },
      );
      if (!answer.ok) {
        if (isNone(answer, opts.noneOn))
          return { ok: true, value: { absent: true } };
        const refusal = opts.contractQuery
          ? contractRefusal(answer)
          : undefined;
        return refusal === undefined
          ? answer
          : {
              ok: false,
              failure: {
                reason: 'invalid_input',
                detail: refusal,
                retryable: false,
              },
              retry: false,
              quiet: true,
              status: 500,
              note: 'contract refused the query',
            };
      }
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
      return { ok: true, value: { absent: false, value: parsed.data } };
    },
  );
  if (!read.ok) return read;
  return read.value.absent
    ? { ok: true, absent: true }
    : { ok: true, value: read.value.value };
}

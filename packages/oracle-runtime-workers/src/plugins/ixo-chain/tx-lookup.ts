/**
 * A broadcast transaction read back by its hash from chain REST
 * (`/cosmos/tx/v1beta1/txs/{hash}`), for the write tools whose wallet
 * answers with the hash, code and height only (no events): the POD
 * Creator's POD and group confirmations, and `create_dao_group`.
 *
 * The read is bounded by its call's deadline and goes through `restJson`
 * (time, size and retry bounds, the user's chain read permits). A
 * transaction not indexed yet (404) or a node briefly unavailable is read
 * again after a wait while the deadline leaves room for one more read.
 */
import { z } from 'zod';
import { MIN_ATTEMPT_MS, sleep, type ChainCall, type Failure } from './http';
import { restJson } from './rest';

/** The wait between two reads of a transaction not on chain (or not readable) yet. */
export const TX_LOOKUP_POLL_MS = 2_000;

/** A Cosmos SDK transaction hash: 32 bytes, hex. */
export const TX_HASH_PATTERN = /^[0-9a-fA-F]{64}$/;

/** A transaction as chain REST answers it: the fields the readers check. */
export const txSchema = z.object({
  tx: z.object({
    body: z.object({
      messages: z.array(z.looseObject({ '@type': z.string() })).default([]),
    }),
  }),
  tx_response: z.object({
    txhash: z.string(),
    height: z.string(),
    code: z.number().int(),
    codespace: z.string().default(''),
    raw_log: z.string().default(''),
    data: z.string().default(''),
    events: z
      .array(
        z.object({
          type: z.string(),
          attributes: z
            .array(z.object({ key: z.string(), value: z.string().default('') }))
            .default([]),
        }),
      )
      .default([]),
  }),
});

export type Tx = z.infer<typeof txSchema>;
export type TxEvent = Tx['tx_response']['events'][number];

/** What looking a transaction up found, within the lookup's time. */
export type TxLookup =
  | { status: 'found'; tx: Tx }
  | {
      status: 'pending' | 'unavailable';
      message: string;
      retryable: boolean;
    };

/** How one lookup reads and waits. */
export interface TxLookupOptions {
  /** Names the read in log lines. */
  label: string;
  /** The log line's tag, e.g. `[pod-creator]`. */
  tag: string;
  /** How the model asks again later, appended to a pending or unavailable answer (none when absent). */
  again?: string;
  /** The wait between two reads; default {@link TX_LOOKUP_POLL_MS}. */
  pollMs?: number;
  /** Every wait between reads; default the abortable `sleep` (tests inject a clock). */
  wait?: (ms: number, signal: AbortSignal) => Promise<void>;
}

/**
 * Look `txHash` up on chain REST, again while it is not indexed yet or the
 * node is briefly unavailable, while `call`'s budget leaves room for a wait
 * and one more read. A hash that is not 64 hex characters is refused
 * without any request: it would otherwise become part of the URL. Only the
 * turn's abort throws.
 */
export async function lookupTransaction(
  call: ChainCall,
  txHash: string,
  options: TxLookupOptions,
): Promise<TxLookup> {
  if (!TX_HASH_PATTERN.test(txHash))
    return {
      status: 'unavailable',
      retryable: false,
      message:
        'That is not a transaction hash (64 hex characters), so nothing was read from the chain.',
    };
  const pollMs = options.pollMs ?? TX_LOOKUP_POLL_MS;
  const wait = options.wait ?? sleep;
  const started = Date.now();
  let lastFailure: Failure | null = null;
  while (true) {
    const read = await restJson(
      call,
      `/cosmos/tx/v1beta1/txs/${txHash}`,
      txSchema,
      { label: options.label, tag: options.tag, noneOn: [404] },
    );
    if (read.ok && !('absent' in read)) {
      if (read.value.tx_response.txhash.toUpperCase() !== txHash.toUpperCase())
        return {
          status: 'unavailable',
          retryable: false,
          message:
            'The chain answered with a different transaction than the one asked for.',
        };
      return { status: 'found', tx: read.value };
    }
    if (!read.ok && !read.failure.retryable)
      return {
        status: 'unavailable',
        retryable: false,
        message: `Could not read the transaction from the chain: ${read.failure.detail}`,
      };
    // Not indexed yet, or the node is briefly unavailable: ask again
    // while the budget leaves room for a wait and one more read.
    lastFailure = read.ok ? null : read.failure;
    if (call.deadline - Date.now() < pollMs + MIN_ATTEMPT_MS) break;
    await wait(pollMs, call.signal);
  }
  const seconds = Math.round((Date.now() - started) / 1000);
  const again = options.again === undefined ? '' : ` ${options.again}`;
  return lastFailure === null
    ? {
        status: 'pending',
        retryable: true,
        message: `The chain has no transaction ${txHash} after ${seconds} s: it may not be in a block yet.${again}`,
      }
    : {
        status: 'unavailable',
        retryable: true,
        message: `The chain could not be read for ${seconds} s (${lastFailure.detail}).${again}`,
      };
}

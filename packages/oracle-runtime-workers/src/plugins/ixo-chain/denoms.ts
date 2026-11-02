/**
 * How a bank denom is shown. DenomMetadata is trusted for any denom: on
 * the IXO chain it is written only by chain code (liquidstake pools, which
 * governance creates; the IBC transfer module; genesis and upgrades), never
 * by a token's issuer (the chain has no tokenfactory module). This is
 * broader than the Auth Hub's rule (ixo-auth-worker
 * `src/lib/actions/denom-display.ts`), which reads metadata only for
 * `ibc/…`, so the Hub may still show a native token such as `upay` as
 * unverified.
 *
 * - `uixo`: always IXO with 6 decimals, verified, no lookup.
 * - an `ibc/…` denom in the IBC table (the built-in entries for the
 *   oracle's network, with `IXO_CHAIN_IBC_DENOMS` merged over them):
 *   verified, the entry's symbol, decimals and `origin`, no lookup.
 * - any other denom with metadata whose `display` unit is listed in
 *   `denom_units` with an exponent of 0–18: verified, those decimals, the
 *   metadata `symbol` (or, when that is empty, the display unit
 *   upper-cased: `uatom` → `ATOM`) if it is plain ASCII.
 * - an `ibc/…` denom whose metadata does not verify it (the shape IBC
 *   transfers register: a display unit not listed) but whose denom trace
 *   reads: unverified, base units, the full denom as its symbol, with a
 *   `trace`: the base denom, the chain id the IXO side's first channel's
 *   light client claims (null when that could not be read) and the path.
 *   Anyone can open a client claiming any chain id and send any base
 *   denom over it, so a trace describes, it never identifies.
 * - anything else (no metadata, no trace, or a malformed denom, which is
 *   never looked up): unverified, base units (0 decimals), the full denom
 *   as its symbol.
 *
 * A denom whose metadata could not be read (a transport failure, or no
 * budget left to ask) or was not asked (a `chain_lookup` request past its
 * denom lookups) is shown the same way with `metadataUnavailable`: it may
 * still be verified. Its trace is not read then.
 */
import { z } from 'zod';
import {
  ReadsInFlight,
  hasBudget,
  throwIfAborted,
  untilDeadline,
  type ChainCall,
} from './http';
import { restJson } from './rest';

export type DenomMetadataView = { symbol: string; decimals: number } | null;
export type TokenDisplay = {
  symbol: string;
  decimals: number;
  verified: boolean;
  /** The chain id a verified IBC token came from (from the IBC table only). */
  origin?: string;
  /** What an unverified IBC token's trace claims: self-reported by the sending chain, never proof. */
  trace?: IbcTrace;
  metadataUnavailable?: true;
};

/** An unverified IBC token's denom trace, as the sending side reported it. */
export type IbcTrace = {
  baseDenom: string;
  /** The chain id the IXO side's first channel's light client claims; null when unread. */
  claimedChain: string | null;
  path: string;
};

/** An IBC voucher denom: `ibc/` and the upper-case hex SHA-256 of its trace. */
const IBC_DENOM = /^ibc\/[A-F0-9]{64}$/;
/** A Cosmos chain id (`noble-1`, `injective-1`). */
const CHAIN_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,49}$/;

/** A verified IBC token: its symbol, decimals and, when known, the chain id it came from. */
export type IbcDenomEntry = {
  symbol: string;
  decimals: number;
  origin?: string;
};
export type IbcDenomTable = ReadonlyMap<string, IbcDenomEntry>;

/**
 * IBC tokens shown verified without a lookup, per network. The IXO
 * chain's own metadata for them lists only the base unit, so it cannot
 * verify them. Each entry was checked on mainnet on Oct 29 2026:
 *
 * - `ibc/6BBE…F97B`: denom trace `transfer/channel-26` / `uusdc`;
 *   channel-26's client is for chain `noble-1`; Noble's `uusdc` metadata
 *   lists a `usdc` unit with exponent 6.
 * - `ibc/77C1…55E6`: denom trace `transfer/channel-31` /
 *   `erc20:0xa00C59fF5a080D2b954d0c75e46E22a0c371235a`; channel-31's client
 *   is for chain `injective-1`; on Injective that token is USDC with 6
 *   decimals (the Auth Hub's USDC sweep lands it).
 *
 * Testnet has only `uosmo` and `uaxl` traces and devnet none; neither has
 * an entry.
 */
export const KNOWN_IBC_DENOMS: Record<
  ChainCall['network'],
  Readonly<Record<string, IbcDenomEntry>>
> = {
  mainnet: {
    'ibc/6BBE9BD4246F8E04948D5A4EEE7164B2630263B9EBB5E7DC5F0A46C62A2FF97B': {
      symbol: 'USDC',
      decimals: 6,
      origin: 'noble-1',
    },
    'ibc/77C12480BD8C29BF0ACEC2143736C15BAF8CD232CA27BAE09336677B828955E6': {
      symbol: 'USDC',
      decimals: 6,
      origin: 'injective-1',
    },
  },
  testnet: {},
  devnet: {},
};

/** The shape of `IXO_CHAIN_IBC_DENOMS` once parsed: `{ "ibc/<HASH>": { symbol, decimals, origin? } }`. */
export const ibcDenomsSchema = z
  .record(
    z.string(),
    z.strictObject({
      symbol: z
        .string()
        .regex(
          /^[A-Za-z0-9.-]{1,20}$/,
          '1–20 characters of A–Z, a–z, 0–9, . or -',
        ),
      decimals: z.number().int().min(0).max(18),
      origin: z
        .string()
        .regex(CHAIN_ID, 'a chain id such as noble-1')
        .optional(),
    }),
  )
  // Checked here rather than as the record's key schema, so the error
  // names the key and the rule instead of "Invalid key in record".
  .superRefine((entries, ctx) => {
    for (const key of Object.keys(entries))
      if (!IBC_DENOM.test(key))
        ctx.addIssue({
          code: 'custom',
          path: [key],
          message: 'keys must be ibc/ and 64 upper-case hex digits',
        });
  });

/**
 * `IXO_CHAIN_IBC_DENOMS` parsed: a JSON string (a secret or a string
 * `vars` entry) or the object itself (an object `vars` entry); not ok,
 * with the reason, when it is not valid JSON or not the expected shape.
 */
export function parseIbcDenoms(
  value: unknown,
):
  | { ok: true; entries: Record<string, IbcDenomEntry> }
  | { ok: false; error: string } {
  let raw = value;
  if (typeof value === 'string')
    try {
      raw = JSON.parse(value);
    } catch {
      return { ok: false, error: 'must be a JSON object' };
    }
  const parsed = ibcDenomsSchema.safeParse(raw);
  if (parsed.success) return { ok: true, entries: parsed.data };
  const issue = parsed.error.issues[0];
  const where = issue?.path.length ? `${issue.path.join('.')}: ` : '';
  return { ok: false, error: `${where}${issue?.message ?? 'invalid'}` };
}

/**
 * The IBC table of a call: the network's built-in entries with the
 * operator's `IXO_CHAIN_IBC_DENOMS` merged over them. Boot validation
 * rejects an invalid override, so one that does not parse here (a config
 * that skipped it) leaves the built-in entries alone.
 */
export function ibcDenomTable(
  network: ChainCall['network'],
  override: unknown,
): IbcDenomTable {
  const extra = override === undefined ? null : parseIbcDenoms(override);
  return new Map(
    Object.entries({
      ...KNOWN_IBC_DENOMS[network],
      ...(extra?.ok ? extra.entries : {}),
    }),
  );
}

/** Symbols an unverified denom may never use (compared case-insensitively). */
const RESERVED_SYMBOLS = ['IXO', 'USDC', 'USDT', 'ATOM', 'OSMO'] as const;
/** The Cosmos SDK bank denom pattern: only such a denom is looked up. */
const DENOM = /^[a-zA-Z][a-zA-Z0-9/:._-]{2,127}$/;
// Plain ASCII only: no spaces or look-alike Unicode letters ("UЅDC").
const SAFE_SYMBOL = /^[A-Za-z0-9._-]{1,32}$/;

export function trustedDenomDisplay(
  denom: string,
  metadata: DenomMetadataView,
): TokenDisplay {
  if (denom === 'uixo') return { symbol: 'IXO', decimals: 6, verified: true };
  const symbol =
    metadata && SAFE_SYMBOL.test(metadata.symbol) ? metadata.symbol : null;
  if (
    metadata &&
    symbol &&
    DENOM.test(denom) &&
    Number.isInteger(metadata.decimals) &&
    metadata.decimals >= 0 &&
    metadata.decimals <= 18
  )
    return { symbol, decimals: metadata.decimals, verified: true };
  const reserved =
    symbol !== null &&
    (RESERVED_SYMBOLS as readonly string[]).includes(symbol.toUpperCase());
  return {
    symbol: symbol && !reserved ? symbol : denom,
    decimals: 0,
    verified: false,
  };
}

/** Base units as a decimal string: `("9000000", 6)` → `"9"`, `("1234567", 6)` → `"1.234567"`. */
export function formatUnits(amount: string, decimals: number): string {
  if (decimals === 0) return amount;
  const padded = amount.padStart(decimals + 1, '0');
  const whole = padded.slice(0, -decimals);
  const fraction = padded.slice(-decimals).replace(/0+$/, '');
  return fraction ? `${whole}.${fraction}` : whole;
}

/**
 * Per isolate: found metadata is reused for 10 min, a definite miss (404,
 * or no display unit) for 60 s, a failed read for 10 s — a failure is
 * never kept as a miss, so it cannot leave a real token unverified.
 */
export const METADATA_TTL_MS = 600_000;
export const METADATA_NOT_FOUND_TTL_MS = 60_000;
export const METADATA_FAILED_TTL_MS = 10_000;
/** A denom trace or a channel's chain id never changes: found ones are reused for 1 h (misses and failures as for metadata). */
export const IBC_TRACE_TTL_MS = 3_600_000;
/** Answers kept per cache; past it the oldest written is dropped. */
export const DENOM_CACHE_LIMIT = 256;

/**
 * One read's answer: the value (null for a miss), or why there is none:
 * `failed` (the upstream failed), `timeout` (it did not answer in time, or
 * the launching call's budget ran out), `aborted` (the launching turn was
 * aborted).
 */
type Lookup<T> = { value: T | null } | 'failed' | 'timeout' | 'aborted';

/**
 * Answers per `${restUrl}|${key}`, kept per isolate: a found value for
 * `foundTtlMs`, a miss for 60 s, a failure for 10 s, a timeout or an abort
 * never; at most {@link DENOM_CACHE_LIMIT}, the oldest dropped first. A
 * read in flight is shared by every call of the isolate that needs the
 * same key; none is started with less than 1 s of the budget left. A call
 * that joined a read which then timed out or was aborted by its launching
 * turn reads again itself while its own budget allows; it waits until its
 * own deadline at most (`timeout` then), on its own turn's abort, never
 * another's. A read that died with its actor is replaced by the next
 * caller past its age limit ({@link ReadsInFlight}).
 */
class ReadCache<T> {
  private readonly answers = new Map<
    string,
    { lookup: Lookup<T>; expiresAt: number }
  >();
  private readonly inflight = new ReadsInFlight<Lookup<T>>();

  constructor(private readonly foundTtlMs: number) {}

  async get(
    call: ChainCall,
    key: string,
    read: () => Promise<Lookup<T>>,
  ): Promise<Lookup<T>> {
    const id = `${call.restUrl}|${key}`;
    const hit = this.answers.get(id);
    if (hit && hit.expiresAt > Date.now()) return hit.lookup;
    const running = this.inflight.joinable(id);
    if (running) {
      const lookup = (await untilDeadline(running, call)) ?? 'timeout';
      return (lookup === 'timeout' || lookup === 'aborted') && hasBudget(call)
        ? this.get(call, key, read)
        : lookup;
    }
    if (!hasBudget(call)) return 'timeout';
    return this.inflight.track(
      id,
      call,
      read().then((lookup) => {
        this.remember(id, lookup);
        return lookup;
      }),
    );
  }

  clear(): void {
    this.answers.clear();
    this.inflight.clear();
  }

  private remember(id: string, lookup: Lookup<T>): void {
    if (lookup === 'aborted' || lookup === 'timeout') return;
    const ttl =
      lookup === 'failed'
        ? METADATA_FAILED_TTL_MS
        : lookup.value
          ? this.foundTtlMs
          : METADATA_NOT_FOUND_TTL_MS;
    this.answers.delete(id);
    if (this.answers.size >= DENOM_CACHE_LIMIT) {
      const oldest = this.answers.keys().next();
      if (!oldest.done) this.answers.delete(oldest.value);
    }
    this.answers.set(id, { lookup, expiresAt: Date.now() + ttl });
  }
}

type DenomTrace = { baseDenom: string; path: string; channel: string };

const metadataCache = new ReadCache<{ symbol: string; decimals: number }>(
  METADATA_TTL_MS,
);
const traceCache = new ReadCache<DenomTrace>(IBC_TRACE_TTL_MS);
const chainIdCache = new ReadCache<string>(IBC_TRACE_TTL_MS);

/** Tests only: forget every cached metadata, trace and channel answer. */
export function resetDenomMetadataCache(): void {
  metadataCache.clear();
  traceCache.clear();
  chainIdCache.clear();
}

/**
 * One bounded REST read of a resource that may be absent: a 404 is a
 * miss, a timeout `timeout`, any other failure `failed`, the launching
 * turn's abort `aborted` (so a call sharing the read is not failed by
 * another turn's abort).
 */
async function readRest<S extends z.ZodType, T>(
  call: ChainCall,
  path: string,
  schema: S,
  label: string,
  pick: (value: z.infer<S>) => T | null,
): Promise<Lookup<T>> {
  let read;
  try {
    read = await restJson(call, path, schema, {
      label,
      maxBytes: 64 * 1024,
      notFoundOn404: true,
    });
  } catch (error) {
    if (call.signal.aborted) return 'aborted';
    throw error;
  }
  if (!read.ok)
    return read.failure.reason === 'not_found'
      ? { value: null }
      : read.failure.reason === 'timeout'
        ? 'timeout'
        : 'failed';
  return { value: pick(read.value) };
}

const metadataResponse = z.object({
  metadata: z.object({
    denom_units: z.array(
      z.object({ denom: z.string(), exponent: z.number().int() }),
    ),
    display: z.string(),
    symbol: z.string(),
  }),
});

/**
 * One DenomMetadata read. The by-query-string route is used because the
 * path route cannot carry the slash in `ibc/…` (the gateway answers 501).
 * Metadata whose display unit is not listed with an exponent of 0–18 is a
 * miss.
 */
function readMetadata(
  call: ChainCall,
  denom: string,
): Promise<Lookup<{ symbol: string; decimals: number }>> {
  return readRest(
    call,
    `/cosmos/bank/v1beta1/denoms_metadata_by_query_string?denom=${encodeURIComponent(denom)}`,
    metadataResponse,
    'denom metadata',
    ({ metadata }) => {
      const unit = metadata.denom_units.find(
        (u) => u.denom === metadata.display,
      );
      return unit && unit.exponent >= 0 && unit.exponent <= 18
        ? {
            symbol: metadata.symbol || metadata.display.toUpperCase(),
            decimals: unit.exponent,
          }
        : null;
    },
  );
}

const traceResponse = z.object({
  denom_trace: z.object({ path: z.string(), base_denom: z.string() }),
});

/**
 * An ICS-20 trace path as the IXO chain records it: hops of
 * `port/channel-N`, the first one the IXO side's own `transfer` channel.
 */
const TRACE_PATH =
  /^transfer\/(channel-\d{1,6})(?:\/[A-Za-z0-9._-]{1,64}\/channel-\d{1,6}){0,15}$/;

/**
 * One denom trace read (`/ibc/apps/transfer/v1/denom_traces/{hash}`; the
 * newer `denoms/{hash}` route answers 501 on the IXO chain). A trace
 * whose path or base denom does not have the expected shape is a miss.
 */
function readTrace(call: ChainCall, hash: string): Promise<Lookup<DenomTrace>> {
  return readRest(
    call,
    `/ibc/apps/transfer/v1/denom_traces/${hash}`,
    traceResponse,
    'denom trace',
    ({ denom_trace: { path, base_denom: baseDenom } }) => {
      const channel = TRACE_PATH.exec(path)?.[1];
      return channel && DENOM.test(baseDenom)
        ? { baseDenom, path, channel }
        : null;
    },
  );
}

/** Light clients without a chain id (not Tendermint) answer without `chain_id`. */
const clientStateResponse = z.object({
  identified_client_state: z.object({
    client_state: z.object({ chain_id: z.string().optional() }),
  }),
});

/** The chain id of the client behind the IXO chain's `transfer` port on `channel`. */
function readChainId(
  call: ChainCall,
  channel: string,
): Promise<Lookup<string>> {
  return readRest(
    call,
    `/ibc/core/channel/v1/channels/${channel}/ports/transfer/client_state`,
    clientStateResponse,
    'channel client state',
    ({ identified_client_state: { client_state } }) =>
      client_state.chain_id && CHAIN_ID.test(client_state.chain_id)
        ? client_state.chain_id
        : null,
  );
}

/**
 * `fallback` with the denom trace of `denom` (an `ibc/…` denom the
 * metadata did not verify) beside it: the base denom, the path and the
 * chain id its first channel's client claims (null when that read
 * failed). The symbol stays the full denom: a trace is self-reported.
 * `fallback` itself when the trace cannot be read.
 */
async function tracedDisplay(
  call: ChainCall,
  denom: string,
  fallback: TokenDisplay,
): Promise<TokenDisplay> {
  const hash = denom.slice('ibc/'.length);
  const trace = await traceCache.get(call, hash, () => readTrace(call, hash));
  throwIfAborted(call.signal);
  if (typeof trace !== 'object' || !trace.value) return fallback;
  const { baseDenom, path, channel } = trace.value;
  const chainId = await chainIdCache.get(call, channel, () =>
    readChainId(call, channel),
  );
  throwIfAborted(call.signal);
  return {
    ...fallback,
    trace: {
      baseDenom,
      claimedChain: typeof chainId === 'object' ? chainId.value : null,
      path,
    },
  };
}

/**
 * The display of `denom` when it takes no lookup: `uixo`, a denom that is
 * not a bank denom (never looked up) and an `ibc/…` denom in `ibcDenoms`.
 * Null for any other denom: its display needs its DenomMetadata.
 */
export function knownDisplay(
  denom: string,
  ibcDenoms: IbcDenomTable,
): TokenDisplay | null {
  if (denom === 'uixo' || !DENOM.test(denom))
    return trustedDenomDisplay(denom, null);
  const known = IBC_DENOM.test(denom) ? ibcDenoms.get(denom) : undefined;
  return known
    ? {
        symbol: known.symbol,
        decimals: known.decimals,
        verified: true,
        ...(known.origin ? { origin: known.origin } : {}),
      }
    : null;
}

/**
 * A denom shown without its metadata (the read failed, or was not made):
 * unverified, in base units, under its full denom, `metadataUnavailable`
 * because it may still be verified.
 */
export function unreadDisplay(denom: string): TokenDisplay {
  return { ...trustedDenomDisplay(denom, null), metadataUnavailable: true };
}

/**
 * The display of `denom`: `uixo` and an `ibc/…` denom in `ibcDenoms`
 * without a lookup; any other denom through its DenomMetadata, then (an
 * `ibc/…` denom it does not verify) its denom trace.
 */
export async function denomDisplay(
  call: ChainCall,
  denom: string,
  ibcDenoms: IbcDenomTable,
): Promise<TokenDisplay> {
  const known = knownDisplay(denom, ibcDenoms);
  if (known) return known;
  const lookup = await metadataCache.get(call, denom, () =>
    readMetadata(call, denom),
  );
  throwIfAborted(call.signal);
  if (typeof lookup !== 'object') return unreadDisplay(denom);
  const display = trustedDenomDisplay(denom, lookup.value);
  return display.verified || !IBC_DENOM.test(denom)
    ? display
    : tracedDisplay(call, denom, display);
}

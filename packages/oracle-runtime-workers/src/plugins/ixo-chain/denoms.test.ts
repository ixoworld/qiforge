import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  DENOM_CACHE_LIMIT,
  IBC_TRACE_TTL_MS,
  KNOWN_IBC_DENOMS,
  METADATA_FAILED_TTL_MS,
  METADATA_NOT_FOUND_TTL_MS,
  METADATA_TTL_MS,
  denomDisplay,
  formatUnits,
  ibcDenomTable,
  ibcDenomsSchema,
  parseIbcDenoms,
  resetDenomMetadataCache,
  trustedDenomDisplay,
  type IbcDenomTable,
} from './denoms';
import {
  READ_GRACE_MS,
  TOOL_BUDGET_MS,
  resetUpstreamHealth,
  type ChainCall,
} from './http';

const USDC =
  'ibc/6BBE9BD4246F8E04948D5A4EEE7164B2630263B9EBB5E7DC5F0A46C62A2FF97B';
const INJECTIVE_USDC =
  'ibc/77C12480BD8C29BF0ACEC2143736C15BAF8CD232CA27BAE09336677B828955E6';
/** An IBC denom no table names. */
const OSMO = `ibc/${'A'.repeat(64)}`;
const NONE: IbcDenomTable = new Map();

/** The requests `fetcher` made whose URL contains `fragment`. */
const readsOf = (fetcher: { mock: { calls: unknown[][] } }, fragment: string) =>
  fetcher.mock.calls.filter(([input]) => String(input).includes(fragment))
    .length;

function callWith(
  fetcher: typeof fetch,
  overrides: Partial<ChainCall> = {},
): ChainCall {
  return {
    network: 'mainnet',
    restUrl: 'https://rest.test/rest',
    blocksyncUrl: 'https://blocksync.test/graphql',
    user: 'did:ixo:ixo1test',
    deadline: Date.now() + TOOL_BUDGET_MS,
    signal: new AbortController().signal,
    fetch: fetcher,
    ...overrides,
  };
}

/** USDC's metadata with a 6-decimal `usdc` display unit. */
const usdcMetadata = () =>
  metadata(
    'usdc',
    [
      { denom: 'uusdc', exponent: 0 },
      { denom: 'usdc', exponent: 6 },
    ],
    'USDC',
  );
const USDC_VERIFIED = { symbol: 'USDC', decimals: 6, verified: true };

const UNVERIFIED_UNAVAILABLE = {
  symbol: USDC,
  decimals: 0,
  verified: false,
  metadataUnavailable: true,
};

const metadata = (
  display: string,
  units: { denom: string; exponent: number }[],
  symbol: string,
) =>
  new Response(
    JSON.stringify({
      metadata: {
        description: '',
        denom_units: units.map((unit) => ({ ...unit, aliases: [] })),
        base: USDC,
        display,
        name: '',
        symbol,
        uri: '',
        uri_hash: '',
      },
    }),
  );

let warn: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  resetDenomMetadataCache();
  resetUpstreamHealth();
  warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('trustedDenomDisplay', () => {
  it('always shows uixo as verified IXO with 6 decimals', () => {
    expect(trustedDenomDisplay('uixo', null)).toEqual({
      symbol: 'IXO',
      decimals: 6,
      verified: true,
    });
    expect(
      trustedDenomDisplay('uixo', { symbol: 'FAKE', decimals: 0 }),
    ).toEqual({
      symbol: 'IXO',
      decimals: 6,
      verified: true,
    });
  });

  it('verifies an ibc denom only with sane metadata', () => {
    expect(trustedDenomDisplay(USDC, { symbol: 'USDC', decimals: 6 })).toEqual({
      symbol: 'USDC',
      decimals: 6,
      verified: true,
    });
    expect(trustedDenomDisplay(USDC, { symbol: 'USDC', decimals: 30 })).toEqual(
      {
        symbol: USDC,
        decimals: 0,
        verified: false,
      },
    );
    expect(trustedDenomDisplay(USDC, null)).toEqual({
      symbol: USDC,
      decimals: 0,
      verified: false,
    });
  });

  it('verifies a native denom with sane metadata', () => {
    expect(trustedDenomDisplay('upay', { symbol: 'PAY', decimals: 6 })).toEqual(
      { symbol: 'PAY', decimals: 6, verified: true },
    );
  });

  it('never verifies a malformed denom, whatever its metadata says', () => {
    expect(
      trustedDenomDisplay('u pay', { symbol: 'PAY', decimals: 6 }),
    ).toEqual({ symbol: 'PAY', decimals: 0, verified: false });
  });

  it('keeps an unverified denom in base units and off reserved symbols', () => {
    expect(
      trustedDenomDisplay('factory/ixo1abc/usdc', {
        symbol: 'USDC',
        decimals: 30,
      }),
    ).toEqual({ symbol: 'factory/ixo1abc/usdc', decimals: 0, verified: false });
    expect(
      trustedDenomDisplay('ufake', { symbol: 'UЅDC', decimals: 6 }),
    ).toEqual({ symbol: 'ufake', decimals: 0, verified: false });
    expect(trustedDenomDisplay('upay', null)).toEqual({
      symbol: 'upay',
      decimals: 0,
      verified: false,
    });
  });
});

describe('formatUnits', () => {
  it('shifts base units by the decimals and trims trailing zeros', () => {
    expect(formatUnits('9000000', 6)).toBe('9');
    expect(formatUnits('500000', 6)).toBe('0.5');
    expect(formatUnits('1234567', 6)).toBe('1.234567');
    expect(formatUnits('1', 6)).toBe('0.000001');
    expect(formatUnits('0', 6)).toBe('0');
    expect(formatUnits('25069999', 0)).toBe('25069999');
  });
});

describe('denomDisplay', () => {
  it('never looks up uixo or a malformed denom', async () => {
    const fetcher = vi.fn<typeof fetch>();
    expect(await denomDisplay(callWith(fetcher), 'uixo', NONE)).toEqual({
      symbol: 'IXO',
      decimals: 6,
      verified: true,
    });
    expect(await denomDisplay(callWith(fetcher), 'u&x=1', NONE)).toEqual({
      symbol: 'u&x=1',
      decimals: 0,
      verified: false,
    });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("reads a native denom's metadata and caches the hit", async () => {
    // upay's metadata as mainnet serves it (read Oct 29 2026).
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async () =>
      metadata(
        'pay',
        [
          { denom: 'upay', exponent: 0 },
          { denom: 'pay', exponent: 6 },
        ],
        'PAY',
      ),
    );
    const display = await denomDisplay(callWith(fetcher), 'upay', NONE);
    expect(display).toEqual({ symbol: 'PAY', decimals: 6, verified: true });
    expect(formatUnits('5740000', display.decimals)).toBe('5.74');
    expect(fetcher).toHaveBeenCalledWith(
      'https://rest.test/rest/cosmos/bank/v1beta1/denoms_metadata_by_query_string?denom=upay',
      expect.objectContaining({ method: 'GET' }),
    );
    expect(await denomDisplay(callWith(fetcher), 'upay', NONE)).toEqual(
      display,
    );
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it('names a token by its display unit upper-cased when the symbol is empty', async () => {
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async () =>
      metadata(
        'atom',
        [
          { denom: 'uatom', exponent: 0 },
          { denom: 'matom', exponent: 3 },
          { denom: 'atom', exponent: 6 },
        ],
        '',
      ),
    );
    expect(await denomDisplay(callWith(fetcher), 'uatom', NONE)).toEqual({
      symbol: 'ATOM',
      decimals: 6,
      verified: true,
    });
  });

  it('reads ibc metadata by query string and caches a hit for 10 min', async () => {
    vi.useFakeTimers();
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async () =>
      metadata(
        'usdc',
        [
          { denom: 'uusdc', exponent: 0 },
          { denom: 'usdc', exponent: 6 },
        ],
        'USDC',
      ),
    );
    const call = () => callWith(fetcher);
    expect(await denomDisplay(call(), USDC, NONE)).toEqual({
      symbol: 'USDC',
      decimals: 6,
      verified: true,
    });
    expect(fetcher).toHaveBeenCalledWith(
      `https://rest.test/rest/cosmos/bank/v1beta1/denoms_metadata_by_query_string?denom=${encodeURIComponent(USDC)}`,
      expect.objectContaining({ method: 'GET' }),
    );
    await vi.advanceTimersByTimeAsync(METADATA_TTL_MS - 1);
    await denomDisplay(call(), USDC, NONE);
    expect(fetcher).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    await denomDisplay(call(), USDC, NONE);
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it('treats an ibc denom whose display unit is not listed as unverified, kept for 60 s', async () => {
    vi.useFakeTimers();
    // The shape IBC transfers register on mainnet: display is the trace
    // path and only the base unit is listed.
    // No trace here (404), so the denom keeps today's name.
    const fetcher = vi
      .fn<typeof fetch>()
      .mockImplementation(async (input) =>
        String(input).includes('/denom_traces/')
          ? new Response('', { status: 404 })
          : metadata(
              'transfer/channel-26/uusdc',
              [{ denom: 'uusdc', exponent: 0 }],
              'UUSDC',
            ),
      );
    expect(await denomDisplay(callWith(fetcher), USDC, NONE)).toEqual({
      symbol: USDC,
      decimals: 0,
      verified: false,
    });
    await vi.advanceTimersByTimeAsync(METADATA_NOT_FOUND_TTL_MS - 1);
    await denomDisplay(callWith(fetcher), USDC, NONE);
    expect(readsOf(fetcher, '/denoms_metadata')).toBe(1);
    await vi.advanceTimersByTimeAsync(1);
    await denomDisplay(callWith(fetcher), USDC, NONE);
    expect(readsOf(fetcher, '/denoms_metadata')).toBe(2);
  });

  it('caches a 404 miss (metadata and trace) for 60 s without a warning', async () => {
    const missing = vi.fn(
      async (_input: RequestInfo | URL) =>
        new Response('{"code":5,"message":"not found"}', { status: 404 }),
    );
    expect(await denomDisplay(callWith(missing), USDC, NONE)).toEqual({
      symbol: USDC,
      decimals: 0,
      verified: false,
    });
    await denomDisplay(callWith(missing), USDC, NONE);
    expect(readsOf(missing, '/denoms_metadata')).toBe(1);
    expect(readsOf(missing, '/denom_traces/')).toBe(1);
    expect(missing).toHaveBeenCalledTimes(2);
    expect(warn).not.toHaveBeenCalled();
  });

  it('keeps a failed read for 10 s, never as a miss, and says the metadata was unavailable', async () => {
    vi.useFakeTimers();
    const broken = vi.fn(async () => new Response('', { status: 500 }));
    expect(await denomDisplay(callWith(broken), USDC, NONE)).toEqual(
      UNVERIFIED_UNAVAILABLE,
    );
    await vi.advanceTimersByTimeAsync(METADATA_FAILED_TTL_MS - 1);
    expect(await denomDisplay(callWith(broken), USDC, NONE)).toEqual(
      UNVERIFIED_UNAVAILABLE,
    );
    expect(broken).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    await denomDisplay(callWith(broken), USDC, NONE);
    expect(broken).toHaveBeenCalledTimes(2);
  });

  it('shares one read between calls that need the same denom at once', async () => {
    let answer: (response: Response) => void = () => undefined;
    const fetcher = vi.fn(
      () =>
        new Promise<Response>((resolve) => {
          answer = resolve;
        }),
    );
    const both = Promise.all([
      denomDisplay(callWith(fetcher), USDC, NONE),
      denomDisplay(callWith(fetcher), USDC, NONE),
    ]);
    await vi.waitFor(() => expect(fetcher).toHaveBeenCalledTimes(1));
    answer(
      metadata(
        'usdc',
        [
          { denom: 'uusdc', exponent: 0 },
          { denom: 'usdc', exponent: 6 },
        ],
        'USDC',
      ),
    );
    const verified = { symbol: 'USDC', decimals: 6, verified: true };
    await expect(both).resolves.toEqual([verified, verified]);
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("reads again itself when the read it shared ends in another turn's abort", async () => {
    const launcher = new AbortController();
    const fetcher = vi
      .fn<typeof fetch>()
      .mockImplementationOnce(
        (_input, init) =>
          new Promise<Response>((_resolve, reject) => {
            init?.signal?.addEventListener('abort', () =>
              reject(new DOMException('aborted', 'AbortError')),
            );
          }),
      )
      .mockImplementation(async () => usdcMetadata());
    const aborted = denomDisplay(
      callWith(fetcher, { signal: launcher.signal }),
      USDC,
      NONE,
    );
    const sharing = denomDisplay(callWith(fetcher), USDC, NONE);
    await vi.waitFor(() => expect(fetcher).toHaveBeenCalledTimes(1));
    launcher.abort(new Error('turn cancelled'));
    await expect(aborted).rejects.toThrow('turn cancelled');
    await expect(sharing).resolves.toEqual(USDC_VERIFIED);
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it("reads again itself when the read it shared ran out of the launching call's budget, and keeps no timeout", async () => {
    vi.useFakeTimers();
    const fetcher = vi
      .fn<typeof fetch>()
      .mockImplementationOnce(
        (_input, init) =>
          new Promise<Response>((_resolve, reject) => {
            init?.signal?.addEventListener('abort', () =>
              reject(new DOMException('aborted', 'AbortError')),
            );
          }),
      )
      .mockImplementation(async () => usdcMetadata());
    const short = denomDisplay(
      callWith(fetcher, { deadline: Date.now() + 2_000 }),
      USDC,
      NONE,
    );
    const sharing = denomDisplay(callWith(fetcher), USDC, NONE);
    await vi.advanceTimersByTimeAsync(2_000);
    await expect(short).resolves.toEqual(UNVERIFIED_UNAVAILABLE);
    await expect(sharing).resolves.toEqual(USDC_VERIFIED);
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it("throws its own turn's abort while it waits on a shared read, leaving the read to its launcher", async () => {
    let answer: (response: Response) => void = () => undefined;
    const fetcher = vi.fn(
      () =>
        new Promise<Response>((resolve) => {
          answer = resolve;
        }),
    );
    const launching = denomDisplay(callWith(fetcher), USDC, NONE);
    const joiner = new AbortController();
    const joining = denomDisplay(
      callWith(fetcher, { signal: joiner.signal }),
      USDC,
      NONE,
    );
    await vi.waitFor(() => expect(fetcher).toHaveBeenCalledTimes(1));
    const reason = new Error('joiner cancelled');
    joiner.abort(reason);
    await expect(joining).rejects.toBe(reason);
    answer(usdcMetadata());
    await expect(launching).resolves.toEqual(USDC_VERIFIED);
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it('ends a joiner at its own deadline when the shared read died with its actor, and the next call past the age limit reads itself', async () => {
    vi.useFakeTimers();
    const fetcher = vi
      .fn<typeof fetch>()
      .mockImplementationOnce(() => new Promise<Response>(() => undefined))
      .mockImplementation(async () => usdcMetadata());
    void denomDisplay(callWith(fetcher), USDC, NONE);
    await vi.advanceTimersByTimeAsync(0);
    const joining = denomDisplay(
      callWith(fetcher, { deadline: Date.now() + 3_000 }),
      USDC,
      NONE,
    );
    await vi.advanceTimersByTimeAsync(3_000);
    await expect(joining).resolves.toEqual(UNVERIFIED_UNAVAILABLE);
    expect(fetcher).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(TOOL_BUDGET_MS + READ_GRACE_MS - 3_000);
    await expect(denomDisplay(callWith(fetcher), USDC, NONE)).resolves.toEqual(
      USDC_VERIFIED,
    );
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it(`keeps at most ${DENOM_CACHE_LIMIT} answers, dropping the oldest first`, async () => {
    const fetcher = vi.fn(async () => new Response('', { status: 404 }));
    const denoms = Array.from(
      { length: DENOM_CACHE_LIMIT + 1 },
      (_, n) => `utok${n}`,
    );
    for (const denom of denoms)
      await denomDisplay(callWith(fetcher), denom, NONE);
    expect(fetcher).toHaveBeenCalledTimes(DENOM_CACHE_LIMIT + 1);
    // The second is still kept; the first, the oldest, was dropped.
    await denomDisplay(callWith(fetcher), 'utok1', NONE);
    expect(fetcher).toHaveBeenCalledTimes(DENOM_CACHE_LIMIT + 1);
    await denomDisplay(callWith(fetcher), 'utok0', NONE);
    expect(fetcher).toHaveBeenCalledTimes(DENOM_CACHE_LIMIT + 2);
  });

  it('starts no read once the budget is spent, and logs nothing for it', async () => {
    const fetcher = vi.fn<typeof fetch>();
    expect(
      await denomDisplay(
        callWith(fetcher, { deadline: Date.now() + 500 }),
        USDC,
        NONE,
      ),
    ).toEqual(UNVERIFIED_UNAVAILABLE);
    expect(fetcher).not.toHaveBeenCalled();
    expect(warn).not.toHaveBeenCalled();
  });
});

describe('the IBC table', () => {
  const mainnet = ibcDenomTable('mainnet', undefined);

  it('shows both mainnet USDCs verified with their origin, without a request', async () => {
    const fetcher = vi.fn<typeof fetch>();
    const noble = await denomDisplay(callWith(fetcher), USDC, mainnet);
    const injective = await denomDisplay(
      callWith(fetcher),
      INJECTIVE_USDC,
      mainnet,
    );
    expect(noble).toEqual({
      symbol: 'USDC',
      decimals: 6,
      verified: true,
      origin: 'noble-1',
    });
    expect(injective).toEqual({
      symbol: 'USDC',
      decimals: 6,
      verified: true,
      origin: 'injective-1',
    });
    expect(formatUnits('25069999', noble.decimals)).toBe('25.069999');
    expect(formatUnits('2199004', injective.decimals)).toBe('2.199004');
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('has no entries on testnet or devnet, and every built-in entry is a valid override', () => {
    expect(ibcDenomTable('testnet', undefined).size).toBe(0);
    expect(ibcDenomTable('devnet', undefined).size).toBe(0);
    expect(mainnet.size).toBe(2);
    for (const network of ['mainnet', 'testnet', 'devnet'] as const)
      expect(ibcDenomsSchema.safeParse(KNOWN_IBC_DENOMS[network]).success).toBe(
        true,
      );
  });

  it('merges the override over the built-in entries, as JSON or an object', () => {
    const override = {
      [USDC]: { symbol: 'USDC.noble', decimals: 6 },
      [OSMO]: { symbol: 'OSMO', decimals: 6, origin: 'osmosis-1' },
    };
    for (const value of [JSON.stringify(override), override]) {
      const table = ibcDenomTable('mainnet', value);
      expect(table.get(USDC)).toEqual({ symbol: 'USDC.noble', decimals: 6 });
      expect(table.get(OSMO)).toEqual(override[OSMO]);
      expect(table.get(INJECTIVE_USDC)).toEqual(
        KNOWN_IBC_DENOMS.mainnet[INJECTIVE_USDC],
      );
    }
    // The override applies on the network the oracle runs on.
    expect(ibcDenomTable('testnet', JSON.stringify(override)).size).toBe(2);
  });

  it('shows an override entry without origin verified, with no origin', async () => {
    const table = ibcDenomTable(
      'mainnet',
      JSON.stringify({ [USDC]: { symbol: 'nUSDC', decimals: 6 } }),
    );
    expect(await denomDisplay(callWith(vi.fn()), USDC, table)).toEqual({
      symbol: 'nUSDC',
      decimals: 6,
      verified: true,
    });
  });

  it('rejects an invalid override and leaves the built-in entries alone', () => {
    const entry = { symbol: 'USDC', decimals: 6 };
    const bad: [unknown, string][] = [
      ['{not json', 'must be a JSON object'],
      ['[]', 'expected record'],
      [JSON.stringify({ [USDC.toLowerCase()]: entry }), 'upper-case hex'],
      [JSON.stringify({ 'ibc/ABC': entry }), 'upper-case hex'],
      [JSON.stringify({ [USDC]: { ...entry, symbol: 'US DC' } }), 'symbol'],
      [
        JSON.stringify({ [USDC]: { ...entry, symbol: 'X'.repeat(21) } }),
        'symbol',
      ],
      [JSON.stringify({ [USDC]: { ...entry, symbol: 'UЅDC' } }), 'symbol'],
      [JSON.stringify({ [USDC]: { ...entry, decimals: 19 } }), 'decimals'],
      [JSON.stringify({ [USDC]: { ...entry, decimals: 1.5 } }), 'decimals'],
      [JSON.stringify({ [USDC]: { ...entry, decimals: '6' } }), 'decimals'],
      [JSON.stringify({ [USDC]: { symbol: 'USDC' } }), 'decimals'],
      [JSON.stringify({ [USDC]: { ...entry, origin: 'noble 1' } }), 'origin'],
      [JSON.stringify({ [USDC]: { ...entry, extra: true } }), 'extra'],
    ];
    for (const [value, says] of bad) {
      expect(parseIbcDenoms(value)).toEqual({
        ok: false,
        error: expect.stringContaining(says),
      });
      expect(ibcDenomTable('mainnet', value)).toEqual(mainnet);
    }
  });
});

describe('IBC denom traces', () => {
  /** The IXO chain's metadata shape for an IBC voucher: only the base unit. */
  const voucherMetadata = () =>
    metadata('transfer/channel-4/uosmo', [{ denom: 'uosmo', exponent: 0 }], '');
  const trace = (path: string, baseDenom: string) =>
    new Response(
      JSON.stringify({ denom_trace: { path, base_denom: baseDenom } }),
    );
  const clientState = (chainId?: string) =>
    new Response(
      JSON.stringify({
        identified_client_state: {
          client_id: '07-tendermint-4',
          client_state: {
            '@type': '/ibc.lightclients.tendermint.v1.ClientState',
            ...(chainId === undefined ? {} : { chain_id: chainId }),
          },
        },
        proof: null,
        proof_height: { revision_number: '0', revision_height: '1' },
      }),
    );
  const router = (answers: {
    trace?: () => Response;
    client?: () => Response;
  }) =>
    vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes('/denoms_metadata')) return voucherMetadata();
      if (url.includes('/denom_traces/'))
        return answers.trace?.() ?? new Response('', { status: 404 });
      if (url.includes('/client_state'))
        return answers.client?.() ?? new Response('', { status: 404 });
      throw new Error(`unexpected ${url}`);
    });

  it('keeps an unknown ibc denom named by its hash, with its trace beside it as a claim', async () => {
    const fetcher = router({
      trace: () => trace('transfer/channel-4', 'uosmo'),
      client: () => clientState('osmosis-1'),
    });
    expect(await denomDisplay(callWith(fetcher), OSMO, NONE)).toEqual({
      symbol: OSMO,
      decimals: 0,
      verified: false,
      trace: {
        baseDenom: 'uosmo',
        claimedChain: 'osmosis-1',
        path: 'transfer/channel-4',
      },
    });
    expect(fetcher).toHaveBeenCalledWith(
      `https://rest.test/rest/ibc/apps/transfer/v1/denom_traces/${'A'.repeat(64)}`,
      expect.objectContaining({ method: 'GET' }),
    );
    expect(fetcher).toHaveBeenCalledWith(
      'https://rest.test/rest/ibc/core/channel/v1/channels/channel-4/ports/transfer/client_state',
      expect.objectContaining({ method: 'GET' }),
    );
    expect(fetcher).toHaveBeenCalledTimes(3);
  });

  it('takes the claimed chain from the first channel of a multi-hop path', async () => {
    const path = 'transfer/channel-4/transfer/channel-0/transfer/channel-204';
    const fetcher = router({
      trace: () => trace(path, 'uatom'),
      client: () => clientState('osmosis-1'),
    });
    expect(await denomDisplay(callWith(fetcher), OSMO, NONE)).toEqual({
      symbol: OSMO,
      decimals: 0,
      verified: false,
      trace: { baseDenom: 'uatom', claimedChain: 'osmosis-1', path },
    });
    expect(readsOf(fetcher, '/channels/channel-4/ports/transfer/')).toBe(1);
    expect(readsOf(fetcher, '/client_state')).toBe(1);
  });

  it('keeps the trace with claimedChain null when the client state cannot be read', async () => {
    for (const client of [
      () => new Response('', { status: 500 }),
      () => new Response('', { status: 404 }),
      () => clientState(),
      () => clientState('not a chain id'),
    ]) {
      resetDenomMetadataCache();
      const fetcher = router({
        trace: () => trace('transfer/channel-4', 'uosmo'),
        client,
      });
      expect(await denomDisplay(callWith(fetcher), OSMO, NONE)).toEqual({
        symbol: OSMO,
        decimals: 0,
        verified: false,
        trace: {
          baseDenom: 'uosmo',
          claimedChain: null,
          path: 'transfer/channel-4',
        },
      });
    }
  });

  it('falls back to the unverified hash when the trace answers 404 or 501', async () => {
    for (const status of [404, 501]) {
      resetDenomMetadataCache();
      const fetcher = router({
        trace: () => new Response('', { status }),
      });
      expect(await denomDisplay(callWith(fetcher), OSMO, NONE)).toEqual({
        symbol: OSMO,
        decimals: 0,
        verified: false,
      });
      expect(readsOf(fetcher, '/client_state')).toBe(0);
    }
  });

  it('caches a trace and a channel chain id for 1 h, shared by denoms on that channel', async () => {
    vi.useFakeTimers();
    const other = `ibc/${'B'.repeat(64)}`;
    const fetcher = router({
      trace: () => trace('transfer/channel-4', 'uosmo'),
      client: () => clientState('osmosis-1'),
    });
    await denomDisplay(callWith(fetcher), OSMO, NONE);
    await denomDisplay(callWith(fetcher), other, NONE);
    await denomDisplay(callWith(fetcher), OSMO, NONE);
    expect(readsOf(fetcher, '/denom_traces/')).toBe(2);
    expect(readsOf(fetcher, '/client_state')).toBe(1);
    await vi.advanceTimersByTimeAsync(IBC_TRACE_TTL_MS - 1);
    expect(await denomDisplay(callWith(fetcher), OSMO, NONE)).toMatchObject({
      symbol: OSMO,
      trace: { baseDenom: 'uosmo', claimedChain: 'osmosis-1' },
    });
    expect(readsOf(fetcher, '/denom_traces/')).toBe(2);
    expect(readsOf(fetcher, '/client_state')).toBe(1);
    await vi.advanceTimersByTimeAsync(1);
    await denomDisplay(callWith(fetcher), OSMO, NONE);
    expect(readsOf(fetcher, '/denom_traces/')).toBe(3);
    expect(readsOf(fetcher, '/client_state')).toBe(2);
  });

  it('shares a trace read in flight between calls', async () => {
    let answer: (response: Response) => void = () => undefined;
    const fetcher = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes('/denoms_metadata')) return voucherMetadata();
      if (url.includes('/client_state')) return clientState('osmosis-1');
      return new Promise<Response>((resolve) => {
        answer = resolve;
      });
    });
    const both = Promise.all([
      denomDisplay(callWith(fetcher), OSMO, NONE),
      denomDisplay(callWith(fetcher), OSMO, NONE),
    ]);
    await vi.waitFor(() => expect(readsOf(fetcher, '/denom_traces/')).toBe(1));
    answer(trace('transfer/channel-4', 'uosmo'));
    const [first, second] = await both;
    expect(first).toEqual(second);
    expect(first).toMatchObject({
      symbol: OSMO,
      trace: { baseDenom: 'uosmo', claimedChain: 'osmosis-1' },
    });
    expect(readsOf(fetcher, '/denom_traces/')).toBe(1);
  });

  it('reads no trace for a denom that is not ibc/ and 64 upper-case hex digits', async () => {
    for (const denom of [
      'ibc/abc',
      `ibc/${'a'.repeat(64)}`,
      `ibc/${'A'.repeat(63)}`,
      'upay',
    ]) {
      const fetcher = router({});
      await denomDisplay(callWith(fetcher), denom, NONE);
      expect(readsOf(fetcher, '/denom_traces/')).toBe(0);
    }
  });

  it('reads no client state for a trace path or base denom of an unexpected shape', async () => {
    for (const [path, base] of [
      ['transfer/channel-1234567', 'uosmo'],
      ['transfer/channel-4/../x', 'uosmo'],
      ['wasm.osmo1abc/channel-4', 'uosmo'],
      ['', 'uosmo'],
      ['transfer/channel-4', 'u osmo'],
    ] as const) {
      resetDenomMetadataCache();
      const fetcher = router({ trace: () => trace(path, base) });
      expect(await denomDisplay(callWith(fetcher), OSMO, NONE)).toEqual({
        symbol: OSMO,
        decimals: 0,
        verified: false,
      });
      expect(readsOf(fetcher, '/client_state')).toBe(0);
    }
  });

  it('never lets a trace name a token or give it an origin: a client may claim any chain id', async () => {
    const fetcher = router({
      trace: () => trace('transfer/channel-4', 'uusdc'),
      client: () => clientState('noble-1'),
    });
    const display = await denomDisplay(callWith(fetcher), OSMO, NONE);
    expect(display).toEqual({
      symbol: OSMO,
      decimals: 0,
      verified: false,
      trace: {
        baseDenom: 'uusdc',
        claimedChain: 'noble-1',
        path: 'transfer/channel-4',
      },
    });
    expect(display).not.toHaveProperty('origin');
  });

  it('keeps a denom verified by its own metadata, without a trace read', async () => {
    const fetcher = vi.fn(async (_input: RequestInfo | URL) =>
      metadata(
        'osmo',
        [
          { denom: 'uosmo', exponent: 0 },
          { denom: 'osmo', exponent: 6 },
        ],
        'OSMO',
      ),
    );
    expect(await denomDisplay(callWith(fetcher), OSMO, NONE)).toEqual({
      symbol: 'OSMO',
      decimals: 6,
      verified: true,
    });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it('reads no trace when the metadata read failed', async () => {
    const fetcher = vi.fn(
      async (_input: RequestInfo | URL) => new Response('', { status: 500 }),
    );
    expect(await denomDisplay(callWith(fetcher), OSMO, NONE)).toEqual({
      symbol: OSMO,
      decimals: 0,
      verified: false,
      metadataUnavailable: true,
    });
    expect(readsOf(fetcher, '/denom_traces/')).toBe(0);
  });
});

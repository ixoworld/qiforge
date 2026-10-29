import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  METADATA_FAILED_TTL_MS,
  METADATA_NOT_FOUND_TTL_MS,
  METADATA_TTL_MS,
  denomDisplay,
  formatUnits,
  resetDenomMetadataCache,
  trustedDenomDisplay,
} from './denoms';
import { TOOL_BUDGET_MS, resetUpstreamHealth, type ChainCall } from './http';

const USDC =
  'ibc/6BBE9BD4246F8E04948D5A4EEE7164B2630263B9EBB5E7DC5F0A46C62A2FF97B';

function callWith(
  fetcher: typeof fetch,
  overrides: Partial<ChainCall> = {},
): ChainCall {
  return {
    network: 'mainnet',
    restUrl: 'https://rest.test/rest',
    blocksyncUrl: 'https://blocksync.test/graphql',
    deadline: Date.now() + TOOL_BUDGET_MS,
    signal: new AbortController().signal,
    fetch: fetcher,
    ...overrides,
  };
}

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
    expect(await denomDisplay(callWith(fetcher), 'uixo')).toEqual({
      symbol: 'IXO',
      decimals: 6,
      verified: true,
    });
    expect(await denomDisplay(callWith(fetcher), 'u&x=1')).toEqual({
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
    const display = await denomDisplay(callWith(fetcher), 'upay');
    expect(display).toEqual({ symbol: 'PAY', decimals: 6, verified: true });
    expect(formatUnits('5740000', display.decimals)).toBe('5.74');
    expect(fetcher).toHaveBeenCalledWith(
      'https://rest.test/rest/cosmos/bank/v1beta1/denoms_metadata_by_query_string?denom=upay',
      expect.objectContaining({ method: 'GET' }),
    );
    expect(await denomDisplay(callWith(fetcher), 'upay')).toEqual(display);
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
    expect(await denomDisplay(callWith(fetcher), 'uatom')).toEqual({
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
    expect(await denomDisplay(call(), USDC)).toEqual({
      symbol: 'USDC',
      decimals: 6,
      verified: true,
    });
    expect(fetcher).toHaveBeenCalledWith(
      `https://rest.test/rest/cosmos/bank/v1beta1/denoms_metadata_by_query_string?denom=${encodeURIComponent(USDC)}`,
      expect.objectContaining({ method: 'GET' }),
    );
    await vi.advanceTimersByTimeAsync(METADATA_TTL_MS - 1);
    await denomDisplay(call(), USDC);
    expect(fetcher).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    await denomDisplay(call(), USDC);
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it('treats an ibc denom whose display unit is not listed as unverified, kept for 60 s', async () => {
    vi.useFakeTimers();
    // The shape IBC transfers register on mainnet: display is the trace
    // path and only the base unit is listed.
    const fetcher = vi
      .fn<typeof fetch>()
      .mockImplementation(async () =>
        metadata(
          'transfer/channel-26/uusdc',
          [{ denom: 'uusdc', exponent: 0 }],
          'UUSDC',
        ),
      );
    expect(await denomDisplay(callWith(fetcher), USDC)).toEqual({
      symbol: USDC,
      decimals: 0,
      verified: false,
    });
    await vi.advanceTimersByTimeAsync(METADATA_NOT_FOUND_TTL_MS - 1);
    await denomDisplay(callWith(fetcher), USDC);
    expect(fetcher).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    await denomDisplay(callWith(fetcher), USDC);
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it('caches a 404 miss for 60 s without a warning', async () => {
    const missing = vi.fn(
      async () =>
        new Response('{"code":5,"message":"not found"}', { status: 404 }),
    );
    expect(await denomDisplay(callWith(missing), USDC)).toEqual({
      symbol: USDC,
      decimals: 0,
      verified: false,
    });
    await denomDisplay(callWith(missing), USDC);
    expect(missing).toHaveBeenCalledTimes(1);
    expect(warn).not.toHaveBeenCalled();
  });

  it('keeps a failed read for 10 s, never as a miss, and says the metadata was unavailable', async () => {
    vi.useFakeTimers();
    const broken = vi.fn(async () => new Response('', { status: 500 }));
    expect(await denomDisplay(callWith(broken), USDC)).toEqual(
      UNVERIFIED_UNAVAILABLE,
    );
    await vi.advanceTimersByTimeAsync(METADATA_FAILED_TTL_MS - 1);
    expect(await denomDisplay(callWith(broken), USDC)).toEqual(
      UNVERIFIED_UNAVAILABLE,
    );
    expect(broken).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    await denomDisplay(callWith(broken), USDC);
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
      denomDisplay(callWith(fetcher), USDC),
      denomDisplay(callWith(fetcher), USDC),
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

  it("does not fail a call sharing a read with another turn's abort", async () => {
    const launcher = new AbortController();
    const fetcher = vi.fn(
      (_input: RequestInfo | URL, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () =>
            reject(new DOMException('aborted', 'AbortError')),
          );
        }),
    );
    const aborted = denomDisplay(
      callWith(fetcher, { signal: launcher.signal }),
      USDC,
    );
    const sharing = denomDisplay(callWith(fetcher), USDC);
    await vi.waitFor(() => expect(fetcher).toHaveBeenCalledTimes(1));
    launcher.abort(new Error('turn cancelled'));
    await expect(aborted).rejects.toThrow('turn cancelled');
    await expect(sharing).resolves.toEqual(UNVERIFIED_UNAVAILABLE);
    // An aborted read is not remembered: the next call asks again.
    const next = vi.fn(async () => new Response('', { status: 404 }));
    await denomDisplay(callWith(next), USDC);
    expect(next).toHaveBeenCalledTimes(1);
  });

  it('starts no read once the budget is spent, and logs nothing for it', async () => {
    const fetcher = vi.fn<typeof fetch>();
    expect(
      await denomDisplay(
        callWith(fetcher, { deadline: Date.now() + 500 }),
        USDC,
      ),
    ).toEqual(UNVERIFIED_UNAVAILABLE);
    expect(fetcher).not.toHaveBeenCalled();
    expect(warn).not.toHaveBeenCalled();
  });
});

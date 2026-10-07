// @vitest-environment jsdom
import { act, renderHook } from '@testing-library/react';
import { type PropsWithChildren } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { OraclesProvider, useOraclesContext } from './oracles-context.js';
import type {
  CreateDelegationFn,
  CreateInvocationFn,
  DelegationResult,
  IOraclesProviderProps,
} from './types.js';

const ORACLE = 'did:ixo:oracle';
const wallet = {
  did: 'did:ixo:user-a',
  address: 'ixo1usera',
  matrix: { accessToken: 'mx', homeServer: 'hs' },
};

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function render(
  createDelegation: CreateDelegationFn,
  createInvocation?: CreateInvocationFn,
  onDelegationRenewed?: IOraclesProviderProps['onDelegationRenewed'],
) {
  const wrapper = ({ children }: PropsWithChildren) => (
    <OraclesProvider
      initialWallet={wallet}
      transactSignX={vi.fn()}
      createDelegation={createDelegation}
      createInvocation={createInvocation}
      onDelegationRenewed={onDelegationRenewed}
    >
      {children}
    </OraclesProvider>
  );
  return renderHook(() => useOraclesContext(), { wrapper });
}

const inAnHour = () => Date.now() + 60 * 60 * 1000;

describe('OraclesProvider credential minting', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it('concurrent callers on a cold cache share one delegation mint', async () => {
    const mint = deferred<DelegationResult>();
    const createDelegation = vi.fn(() => mint.promise);
    const { result } = render(createDelegation);

    let all!: Promise<(string | null)[]>;
    act(() => {
      all = Promise.all([
        result.current.getDelegation(ORACLE),
        result.current.getDelegation(ORACLE),
        result.current.getDelegation(ORACLE),
      ]);
    });
    mint.resolve({ serialized: 'del-1', expiresAt: inAnHour() });

    expect(await all).toEqual(['del-1', 'del-1', 'del-1']);
    expect(createDelegation).toHaveBeenCalledTimes(1);
  });

  it('a failed delegation mint is not remembered: the next call mints again', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const createDelegation = vi
      .fn<CreateDelegationFn>()
      .mockRejectedValueOnce(new Error('wallet closed'))
      .mockResolvedValueOnce({ serialized: 'del-2', expiresAt: inAnHour() });
    const { result } = render(createDelegation);

    try {
      expect(await result.current.getDelegation(ORACLE)).toBeNull();
      expect(await result.current.getDelegation(ORACLE)).toBe('del-2');
      expect(createDelegation).toHaveBeenCalledTimes(2);
    } finally {
      warn.mockRestore();
    }
  });

  it('concurrent callers share one invocation mint; a failed one can be retried', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const first = deferred<DelegationResult>();
    const createInvocation = vi
      .fn<CreateInvocationFn>()
      .mockReturnValueOnce(first.promise)
      .mockResolvedValueOnce({ serialized: 'inv-2', expiresAt: inAnHour() });
    const { result } = render(vi.fn(), createInvocation);

    try {
      let both!: Promise<(string | null)[]>;
      act(() => {
        both = Promise.all([
          result.current.getInvocation(ORACLE),
          result.current.getInvocation(ORACLE),
        ]);
      });
      first.reject(new Error('signer unavailable'));
      expect(await both).toEqual([null, null]);
      expect(createInvocation).toHaveBeenCalledTimes(1);

      expect(await result.current.getInvocation(ORACLE)).toBe('inv-2');
      expect(createInvocation).toHaveBeenCalledTimes(2);
    } finally {
      warn.mockRestore();
    }
  });

  it('`fresh` mints a new invocation even while the cached one is valid', async () => {
    const createInvocation = vi
      .fn<CreateInvocationFn>()
      .mockResolvedValueOnce({ serialized: 'inv-1', expiresAt: inAnHour() })
      .mockResolvedValueOnce({ serialized: 'inv-2', expiresAt: inAnHour() });
    const { result } = render(vi.fn(), createInvocation);

    expect(await result.current.getInvocation(ORACLE)).toBe('inv-1');
    expect(await result.current.getInvocation(ORACLE)).toBe('inv-1'); // cached
    expect(await result.current.getInvocation(ORACLE, { fresh: true })).toBe(
      'inv-2',
    );
    // The renewed invocation replaces the cached one.
    expect(await result.current.getInvocation(ORACLE)).toBe('inv-2');
    expect(createInvocation).toHaveBeenCalledTimes(2);
  });

  it('`fresh` replaces the cached delegation; fresh callers and readers meanwhile share one mint', async () => {
    const second = deferred<DelegationResult>();
    const createDelegation = vi
      .fn<CreateDelegationFn>()
      .mockResolvedValueOnce({ serialized: 'del-1', expiresAt: inAnHour() })
      .mockReturnValueOnce(second.promise);
    const { result } = render(createDelegation);

    expect(await result.current.getDelegation(ORACLE)).toBe('del-1');
    let all!: Promise<(string | null)[]>;
    act(() => {
      all = Promise.all([
        result.current.getDelegation(ORACLE, { fresh: true }),
        result.current.getDelegation(ORACLE, { fresh: true }),
        // A reader arriving mid-mint must not get the replaced delegation.
        result.current.getDelegation(ORACLE),
      ]);
    });
    second.resolve({ serialized: 'del-2', expiresAt: inAnHour() });

    expect(await all).toEqual(['del-2', 'del-2', 'del-2']);
    expect(await result.current.getDelegation(ORACLE)).toBe('del-2');
    expect(createDelegation).toHaveBeenCalledTimes(2);
  });
});

describe('OraclesProvider credential renewal', () => {
  /** Mints `<prefix>-1`, `<prefix>-2`, … */
  const counter = (prefix: string) => {
    let n = 0;
    return vi.fn(async () => {
      n += 1;
      return { serialized: `${prefix}-${n}`, expiresAt: inAnHour() };
    });
  };

  let requests: { authorization: string | null; delegation: string | null }[];
  /** The oracle accepts only these invocations. */
  let accepted: Set<string>;

  beforeEach(() => {
    localStorage.clear();
    requests = [];
    accepted = new Set();
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url: string, init: RequestInit = {}) => {
        const headers = new Headers(init.headers);
        const authorization = headers.get('authorization');
        requests.push({
          authorization,
          delegation: headers.get('x-ucan-delegation'),
        });
        if (authorization && accepted.has(authorization.slice(7)))
          return Response.json({ ok: true });
        return Response.json(
          { statusCode: 401, message: 'Invalid UCAN invocation' },
          { status: 401 },
        );
      }),
    );
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('a refused request is repeated after a fresh invocation; no delegation is minted', async () => {
    const createDelegation = counter('del');
    const createInvocation = counter('inv');
    const onDelegationRenewed = vi.fn();
    const { result } = render(
      createDelegation,
      createInvocation,
      onDelegationRenewed,
    );
    accepted.add('inv-2');

    await expect(
      result.current.authedRequest('https://o/x', 'GET', {}, ORACLE),
    ).resolves.toEqual({ ok: true });

    expect(requests.map((r) => r.authorization)).toEqual([
      'Bearer inv-1',
      'Bearer inv-2',
    ]);
    expect(createDelegation).toHaveBeenCalledTimes(1);
    expect(onDelegationRenewed).not.toHaveBeenCalled();
  });

  it('refused again after stage 1, the request is repeated with a fresh delegation and invocation, and the host hears of the delegation', async () => {
    const createDelegation = counter('del');
    const createInvocation = counter('inv');
    const onDelegationRenewed = vi.fn();
    const { result } = render(
      createDelegation,
      createInvocation,
      onDelegationRenewed,
    );
    accepted.add('inv-3');

    await expect(
      result.current.authedRequest('https://o/x', 'GET', {}, ORACLE),
    ).resolves.toEqual({ ok: true });

    expect(requests).toEqual([
      { authorization: 'Bearer inv-1', delegation: 'del-1' },
      { authorization: 'Bearer inv-2', delegation: 'del-1' },
      { authorization: 'Bearer inv-3', delegation: 'del-2' },
    ]);
    await vi.waitFor(() =>
      expect(onDelegationRenewed).toHaveBeenCalledWith(ORACLE, 'del-2'),
    );
    expect(onDelegationRenewed).toHaveBeenCalledTimes(1);
  });

  it('refused after both stages, the refusal is thrown and nothing more is minted', async () => {
    const createDelegation = counter('del');
    const createInvocation = counter('inv');
    const { result } = render(createDelegation, createInvocation);

    await expect(
      result.current.authedRequest('https://o/x', 'GET', {}, ORACLE),
    ).rejects.toMatchObject({ status: 401 });

    expect(requests).toHaveLength(3);
    expect(createDelegation).toHaveBeenCalledTimes(2);
    expect(createInvocation).toHaveBeenCalledTimes(3);
  });

  it('requests refused at the same moment share one renewal', async () => {
    const createInvocation = counter('inv');
    const { result } = render(counter('del'), createInvocation);
    accepted.add('inv-2');

    const results = await Promise.all(
      [1, 2, 3].map(() =>
        result.current.authedRequest('https://o/x', 'GET', {}, ORACLE),
      ),
    );

    expect(results).toEqual([{ ok: true }, { ok: true }, { ok: true }]);
    // One mint on the cold cache, one renewal for all three refusals.
    expect(createInvocation).toHaveBeenCalledTimes(2);
  });

  it('a renewal asked with credentials another caller already replaced mints nothing', async () => {
    const createDelegation = counter('del');
    const createInvocation = counter('inv');
    const { result } = render(createDelegation, createInvocation);
    await result.current.getDelegation(ORACLE);
    await result.current.getInvocation(ORACLE);
    expect(await result.current.renewOracleAuth(ORACLE, 1)).toBe(true);
    expect(createInvocation).toHaveBeenCalledTimes(2);

    expect(
      await result.current.renewOracleAuth(ORACLE, 1, {
        delegation: 'del-1',
        invocation: 'inv-1',
      }),
    ).toBe(true);
    expect(createInvocation).toHaveBeenCalledTimes(2);
  });

  it('stage 2 does not ask for another delegation while the one it just minted is refused', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const createDelegation = counter('del');
    const { result } = render(createDelegation, counter('inv'));
    try {
      await result.current.getDelegation(ORACLE);
      expect(
        await result.current.renewOracleAuth(ORACLE, 2, {
          delegation: 'del-1',
        }),
      ).toBe(true);
      expect(createDelegation).toHaveBeenCalledTimes(2);

      expect(
        await result.current.renewOracleAuth(ORACLE, 2, {
          delegation: 'del-2',
        }),
      ).toBe(false);
      expect(createDelegation).toHaveBeenCalledTimes(2);
    } finally {
      warn.mockRestore();
    }
  });

  it('a 403 that new credentials cannot fix is thrown without renewing', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        Response.json(
          { statusCode: 403, code: 'VFS_AUTH_FAILED', message: 'no' },
          { status: 403 },
        ),
      ),
    );
    const createInvocation = counter('inv');
    const { result } = render(counter('del'), createInvocation);

    await expect(
      result.current.authedRequest('https://o/x', 'GET', {}, ORACLE),
    ).rejects.toMatchObject({ status: 403, code: 'VFS_AUTH_FAILED' });
    expect(createInvocation).toHaveBeenCalledTimes(1);
  });
});

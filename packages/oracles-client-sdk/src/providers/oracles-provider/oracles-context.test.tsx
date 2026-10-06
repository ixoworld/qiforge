// @vitest-environment jsdom
import { act, renderHook } from '@testing-library/react';
import { type PropsWithChildren } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { OraclesProvider, useOraclesContext } from './oracles-context.js';
import type {
  CreateDelegationFn,
  CreateInvocationFn,
  DelegationResult,
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
) {
  const wrapper = ({ children }: PropsWithChildren) => (
    <OraclesProvider
      initialWallet={wallet}
      transactSignX={vi.fn()}
      createDelegation={createDelegation}
      createInvocation={createInvocation}
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
});

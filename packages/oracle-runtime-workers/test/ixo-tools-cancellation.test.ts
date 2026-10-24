import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  runIxoOperation,
  lifetimeFetch,
  IXO_TOOLS_TIMEOUT_MS,
} from '../src/ixo-tools/lifetime';
import { makeRuntimeContext } from '../src/core/test-fixtures';
import { IxoToolsPlugin } from '../src/plugins/ixo-tools';
import { loopFixture } from './ixo-tools-fixtures';

afterEach(() => {
  vi.useRealTimers();
});
function deferred<T>() {
  let resolve: (value: T) => void = () => undefined;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
describe('IXO native lifetime and source cancellation', () => {
  it('rejects before calling an already cancelled operation', async () => {
    const controller = new AbortController();
    controller.abort('private cancel reason');
    const work = vi.fn(async () => 1);
    await expect(runIxoOperation(controller.signal, work)).rejects.toThrow(
      'IXO request cancelled',
    );
    expect(work).not.toHaveBeenCalled();
  });
  it('bounds a non-cooperative authority promise and ignores its late result', async () => {
    vi.useFakeTimers();
    const held = deferred<string>();
    const result = runIxoOperation(undefined, () => held.promise);
    const outcome = result.then(
      (value) => ({ value }),
      (error) => ({ error }),
    );
    await vi.advanceTimersByTimeAsync(IXO_TOOLS_TIMEOUT_MS);
    expect(await outcome).toMatchObject({ error: { name: 'TimeoutError' } });
    held.resolve('late-private-value');
    await expect(result).rejects.toMatchObject({ name: 'TimeoutError' });
    expect(vi.getTimerCount()).toBe(0);
  });
  it('cleans its deadline and listener when work finishes', async () => {
    vi.useFakeTimers();
    const controller = new AbortController();
    expect(await runIxoOperation(controller.signal, async () => 7)).toBe(7);
    expect(vi.getTimerCount()).toBe(0);
    controller.abort();
  });
  it('composes source Request signals without replacing existing timeouts', async () => {
    const turn = new AbortController();
    const source = new AbortController();
    const fetcher = vi.fn<typeof fetch>(async (_input, init) => {
      expect(init?.signal?.aborted).toBe(false);
      source.abort();
      expect(init?.signal?.aborted).toBe(true);
      return new Response('must not escape');
    });
    const bound = lifetimeFetch(fetcher, turn.signal);
    await expect(
      bound(new Request('https://source.test', { signal: source.signal })),
    ).rejects.toThrow();
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(turn.signal.aborted).toBe(false);
  });
  it('propagates a cancelled native turn into the actual source fetch', async () => {
    const controller = new AbortController();
    const started = deferred<AbortSignal>();
    const f = loopFixture({
      lifetimeSignal: controller.signal,
      onFetch: async (url, init) => {
        if (!url.includes('/api/v1/subscriptions?')) return undefined;
        const signal = init?.signal;
        if (!signal) throw new Error('source lifetime missing');
        started.resolve(signal);
        return new Promise<Response>((_resolve, reject) =>
          signal.addEventListener(
            'abort',
            () => reject(new DOMException('source cancelled', 'AbortError')),
            { once: true },
          ),
        );
      },
    });
    const base = makeRuntimeContext();
    const ctx = makeRuntimeContext({
      ixoTools: f.binding.tools,
      abortSignal: controller.signal,
      user: {
        ...base.user,
        did: f.context.userDid,
        timezone: f.context.timezone,
      },
      session: {
        ...base.session,
        id: f.context.sessionId,
        roomId: f.context.roomId,
      },
    });
    const tools = await new IxoToolsPlugin().getRequestTools(ctx);
    const credit = tools.find((tool) => tool.name === 'ixo_credits_get');
    if (!credit) throw new Error('credit tool missing');
    const result = credit.handler({}, ctx);
    const source = await started.promise;
    controller.abort();
    await expect(result).rejects.toMatchObject({ name: 'AbortError' });
    expect(source.aborted).toBe(true);
    const count = f.requests.length;
    await Promise.resolve();
    expect(f.requests).toHaveLength(count);
  });
  it('does not reuse a cancelled turn lifetime for another owner binding', async () => {
    const first = new AbortController();
    first.abort();
    const a = loopFixture({ lifetimeSignal: first.signal });
    const b = loopFixture();
    await expect(
      a.binding.tools.invoke('ixo_account_get', {}),
    ).rejects.toMatchObject({ name: 'AbortError' });
    expect(await b.binding.tools.invoke('ixo_account_get', {})).toMatchObject({
      status: 'available',
    });
    expect(a.requests).toEqual([]);
  });
});

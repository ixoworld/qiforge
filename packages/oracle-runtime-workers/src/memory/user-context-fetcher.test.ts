import { createServer } from 'node:http';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  UserContextFetcher,
  USER_CONTEXT_MAX_JSON_CHARS,
  USER_CONTEXT_SLOTS,
  buildUserContextQueries,
} from './user-context-fetcher';
import { retainedMemory, type MemoryStamp } from './retained-context';
import { NOOP_LOGGER } from '../core/utils';
const params = { roomId: '!room:x', userDid: 'did:ixo:user', sessionId: 'one' };
const scope = {
  userDid: params.userDid,
  oracleDid: 'did:ixo:oracle',
  knowledgeScope: 'personal',
};
const stamp: MemoryStamp = {
  userDid: params.userDid,
  oracleDid: scope.oracleDid,
  roomId: params.roomId,
  sessionId: params.sessionId,
  network: 'devnet',
  sourceOrigin: 'https://memory.test',
  grantRevision: 'grant1',
  generation: 0,
};
function envelope(text = 'Personal fact') {
  return {
    representation: 1,
    scope,
    observedAt: new Date().toISOString(),
    facts: text
      ? [
          {
            scope,
            text,
            reference: 'memory:fact:space:one',
            revision: `sha256:${'1'.repeat(64)}`,
          },
        ]
      : [],
  };
}
function harness(
  options: ConstructorParameters<typeof UserContextFetcher>[1] = {},
) {
  let currentStamp: MemoryStamp | undefined = { ...stamp };
  let serviceDid = 'did:web:memory.test';
  let response: unknown = {
    representation: 1,
    results: USER_CONTEXT_SLOTS.map(() => envelope()),
  };
  let status = 200;
  let hold: Promise<void> | undefined;
  let didHold: Promise<void> | undefined;
  const calls: Request[] = [];
  const mint = vi.fn(async () => `invocation-${crypto.randomUUID()}`);
  const fetcher = new UserContextFetcher(
    {
      memoryEngineUrl: 'https://memory.test',
      oracleDid: scope.oracleDid,
      logger: NOOP_LOGGER,
      stamp: async () => currentStamp,
      ucan: {
        hasSigningKey: () => true,
        resolveServiceDid: async () => {
          await didHold;
          return serviceDid;
        },
        mintInvocation: mint,
      },
      fetchImpl: async (input, init) => {
        const request = new Request(input, init);
        calls.push(request);
        await hold;
        return Response.json(response, { status });
      },
    },
    options,
  );
  return {
    fetcher,
    calls,
    mint,
    serviceDid: (value: string) => {
      serviceDid = value;
    },
    holdDid: () => {
      let release = () => {};
      didHold = new Promise<void>((resolve) => {
        release = resolve;
      });
      return release;
    },
    answer: (value: unknown) => {
      response = value;
    },
    deny: () => {
      currentStamp = undefined;
    },
    advance: () => {
      currentStamp = { ...stamp, generation: 1 };
      fetcher.invalidateAll();
    },
    fail: () => {
      status = 503;
    },
    hold: () => {
      let release = () => {};
      hold = new Promise<void>((resolve) => {
        release = resolve;
      });
      return release;
    },
  };
}
afterEach(() => vi.useRealTimers());
describe('cited personal profile prefetch', () => {
  it.each([
    ['search-batch', 307, false],
    ['search-batch', 308, true],
    ['references/check', 307, false],
    ['references/check', 308, true],
  ])(
    'rejects %s redirect %i (cross origin %s) without contacting its destination',
    async (route, status, crossOrigin) => {
      let destinationCalls = 0;
      let origin = '';
      const paths: string[] = [];
      const server = createServer((request, response) => {
        const path = request.url ?? '';
        paths.push(path);
        if (path === '/redirected') {
          destinationCalls += 1;
          response.writeHead(200, { 'content-type': 'application/json' });
          response.end(
            JSON.stringify({
              representation: 1,
              scope,
              observedAt: new Date().toISOString(),
              valid: true,
            }),
          );
        } else if (path === `/agent/${route}`) {
          response.writeHead(status, {
            location: `${crossOrigin ? origin.replace('127.0.0.1', 'localhost') : origin}/redirected`,
          });
          response.end();
        } else {
          response.writeHead(200, { 'content-type': 'application/json' });
          response.end(
            JSON.stringify({
              representation: 1,
              results: USER_CONTEXT_SLOTS.map(() => envelope()),
            }),
          );
        }
      });
      await new Promise<void>((resolve) =>
        server.listen(0, '0.0.0.0', resolve),
      );
      try {
        const address = server.address();
        if (!address || typeof address === 'string')
          throw new Error('no HTTP port');
        origin = `http://127.0.0.1:${address.port}`;
        const redirectOrigin = crossOrigin
          ? origin.replace('127.0.0.1', 'localhost')
          : origin;
        expect((await fetch(`${redirectOrigin}/probe`)).ok).toBe(true);
        const fetcher = new UserContextFetcher({
          memoryEngineUrl: origin,
          oracleDid: scope.oracleDid,
          logger: NOOP_LOGGER,
          stamp: async () => ({ ...stamp, sourceOrigin: origin }),
          ucan: {
            hasSigningKey: () => true,
            resolveServiceDid: async () =>
              `did:web:127.0.0.1%3A${address.port}`,
            mintInvocation: async () => 'redirect-test-invocation',
          },
        });
        const result = await fetcher.fetch(params);
        let outcome: unknown = result.kind;
        if (route === 'references/check') {
          if (result.kind !== 'fresh') throw new Error('no authorized profile');
          outcome = await fetcher.current(result.context, params);
        }
        expect(outcome).toEqual(route === 'references/check' ? {} : 'failed');
        expect(paths).toContain(`/agent/${route}`);
        expect(destinationCalls).toBe(0);
      } finally {
        server.closeAllConnections();
        await new Promise<void>((resolve, reject) =>
          server.close((error) => (error ? reject(error) : resolve())),
        );
      }
    },
  );
  it.each(['search-batch', 'references/check'])(
    'rejects a mismatched source DID before dispatching %s',
    async (route) => {
      const h = harness();
      let context: unknown;
      if (route === 'references/check') {
        const profile = await h.fetcher.fetch(params);
        if (profile.kind !== 'fresh') throw new Error('no authorized profile');
        context = profile.context;
      }
      const before = h.calls.length;
      h.serviceDid('did:web:different-source.test');
      const outcome =
        route === 'references/check'
          ? await h.fetcher.current(context, params)
          : (await h.fetcher.fetch(params)).kind;
      expect(outcome).toEqual(route === 'references/check' ? {} : 'failed');
      expect(h.calls).toHaveLength(before);
      expect(h.mint).toHaveBeenCalledTimes(before);
    },
  );
  it('sends exactly six personal queries in one fresh narrow invocation', async () => {
    const h = harness();
    const result = await h.fetcher.fetch(params);
    expect(result.kind).toBe('fresh');
    expect(h.calls).toHaveLength(1);
    const request = h.calls[0];
    expect(request?.url).toBe('https://memory.test/agent/search-batch');
    expect(await request?.json()).toEqual({
      queries: buildUserContextQueries(),
    });
    expect(h.mint).toHaveBeenCalledWith(
      { did: 'did:web:memory.test', capability: 'ixo:memory' },
      { can: 'memory/search', skipCache: true },
    );
    if (result.kind !== 'fresh') throw new Error('no profile');
    expect(retainedMemory(result.context)?.facts).toHaveLength(6);
    expect(JSON.stringify(result.context).length).toBeLessThanOrEqual(
      USER_CONTEXT_MAX_JSON_CHARS,
    );
  });
  it('rechecks exact retained refs and suppresses an unavailable current check', async () => {
    const h = harness();
    const result = await h.fetcher.fetch(params);
    if (result.kind !== 'fresh') throw new Error('no profile');
    h.answer({
      representation: 1,
      scope,
      observedAt: new Date().toISOString(),
      valid: true,
    });
    expect(await h.fetcher.current(result.context, params)).toEqual(
      result.context,
    );
    expect(await h.calls[1]?.json()).toEqual({
      scope: 'personal',
      references: [
        {
          reference: 'memory:fact:space:one',
          revision: `sha256:${'1'.repeat(64)}`,
        },
      ],
    });
    h.fail();
    expect(await h.fetcher.current(result.context, params)).toEqual({});
  });
  it.each(['deleted', 'refined', 'revoked'])(
    'suppresses retained text when %s',
    async () => {
      const h = harness();
      const result = await h.fetcher.fetch(params);
      if (result.kind !== 'fresh') throw new Error('no profile');
      h.answer({
        representation: 1,
        scope,
        observedAt: new Date().toISOString(),
        valid: false,
      });
      expect(await h.fetcher.current(result.context, params)).toEqual({});
      h.deny();
      expect(await h.fetcher.current(result.context, params)).toEqual({});
    },
  );
  it('suppresses conflicting revisions of the same fact across batch slots', async () => {
    const h = harness();
    const result = await h.fetcher.fetch(params);
    if (result.kind !== 'fresh') throw new Error('no profile');
    const memory = retainedMemory(result.context);
    if (!memory) throw new Error('no citations');
    const first = memory.facts[0];
    if (!first) throw new Error('no fact');
    memory.facts.push({
      ...first,
      revision: `sha256:${'2'.repeat(64)}`,
      text: 'conflicting revision',
    });
    h.answer({
      representation: 1,
      scope,
      observedAt: new Date().toISOString(),
      valid: true,
    });
    expect(await h.fetcher.current({ _memory: memory }, params)).toEqual({});
    expect(h.calls).toHaveLength(1);
  });

  it('rejects a late current-check response after the local grant changes', async () => {
    const h = harness();
    const result = await h.fetcher.fetch(params);
    if (result.kind !== 'fresh') throw new Error('no profile');
    h.answer({
      representation: 1,
      scope,
      observedAt: new Date().toISOString(),
      valid: true,
    });
    const release = h.hold();
    const check = h.fetcher.current(result.context, params);
    await Promise.resolve();
    h.deny();
    release();
    expect(await check).toEqual({});
  });

  it('caps the whole prompt validation while service DID resolution is pending', async () => {
    vi.useFakeTimers();
    const h = harness({ blockingCapMs: 25 });
    const result = await h.fetcher.fetch(params);
    if (result.kind !== 'fresh') throw new Error('no profile');
    h.answer({
      representation: 1,
      scope,
      observedAt: new Date().toISOString(),
      valid: true,
    });
    const release = h.holdDid();
    const current = h.fetcher.current(result.context, params);
    await vi.advanceTimersByTimeAsync(25);
    expect(await current).toEqual({});
    expect(h.calls).toHaveLength(1);
    release();
    await vi.advanceTimersByTimeAsync(1);
    expect(await current).toEqual({});
  });

  it('rejects legacy uncited checkpoint text', async () => {
    const h = harness();
    expect(
      await h.fetcher.current(
        { identity: { facts: [{ fact: 'old secret' }] } },
        params,
      ),
    ).toEqual({});
    expect(h.calls).toHaveLength(0);
  });
  it('keeps successful positional slots after partial failure', async () => {
    const h = harness();
    h.answer({
      representation: 1,
      results: [
        envelope(),
        ...Array.from({ length: 5 }, () => ({
          error: { code: 'unavailable' },
        })),
      ],
    });
    const result = await h.fetcher.fetch(params);
    expect(result.kind).toBe('fresh');
    if (result.kind !== 'fresh') throw new Error('no profile');
    expect(retainedMemory(result.context)?.facts).toHaveLength(1);
    expect(result.slots.work).toBe('missing');
  });
  it('rejects foreign identity or oracle evidence', async () => {
    const h = harness();
    h.answer({
      representation: 1,
      results: USER_CONTEXT_SLOTS.map(() => ({
        ...envelope(),
        scope: { ...scope, userDid: 'did:ixo:other' },
      })),
    });
    expect((await h.fetcher.fetch(params)).kind).toBe('failed');
  });
  it('bounds context including citations instead of truncating source bytes', async () => {
    const h = harness();
    h.answer({
      representation: 1,
      results: USER_CONTEXT_SLOTS.map(() => envelope('x'.repeat(12000))),
    });
    const result = await h.fetcher.fetch(params);
    if (result.kind !== 'fresh') throw new Error('no profile');
    expect(JSON.stringify(result.context).length).toBeLessThanOrEqual(
      USER_CONTEXT_MAX_JSON_CHARS,
    );
    for (const fact of retainedMemory(result.context)?.facts ?? [])
      expect(fact.text.length).toBe(12000);
  });
  it('keeps one gather and returns at the blocking cap; late success warms cache', async () => {
    vi.useFakeTimers();
    const h = harness({ blockingCapMs: 25 });
    const release = h.hold();
    const pending = h.fetcher.fetch(params);
    const refresh = h.fetcher.refresh(params);
    await vi.advanceTimersByTimeAsync(25);
    expect(await pending).toEqual({ kind: 'timeout', capMs: 25 });
    expect(h.calls).toHaveLength(1);
    release();
    await refresh;
    expect((await h.fetcher.fetch(params)).kind).toBe('cached');
  });
  it('drops a late gather after generation change from both caller and cache', async () => {
    const h = harness();
    const release = h.hold();
    const pending = h.fetcher.fetch(params);
    await Promise.resolve();
    h.advance();
    release();
    expect((await pending).kind).toBe('failed');
    expect(h.fetcher.status(params.roomId).cached).toBe(false);
  });
  it('uses bounded LRU positive and negative caches', async () => {
    const h = harness({ maxCachedRooms: 2 });
    for (const roomId of ['a', 'b', 'c'])
      await h.fetcher.fetch({ ...params, roomId });
    expect(h.fetcher.status('a').cached).toBe(false);
    expect(h.fetcher.status('c').cached).toBe(true);
    h.fail();
    await h.fetcher.fetch({ ...params, roomId: 'd' });
    const count = h.calls.length;
    expect((await h.fetcher.fetch({ ...params, roomId: 'd' })).kind).toBe(
      'skipped',
    );
    expect(h.calls).toHaveLength(count);
  });
});

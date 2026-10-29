import { describe, expect, it, vi } from 'vitest';
import {
  createUnsignedUcanAdapter,
  type UcanAdapter,
} from '../../core/runtime-context';
import { makeRuntimeContext } from '../../core/test-fixtures';
import type { RuntimeContext } from '../../plugin-api/types';
import {
  createMemoryEngineClient,
  entityDidOrWarn,
  MemoryEngineError,
  resetMemoryEngineWarningsForTests,
} from './memory-engine-client';

const ENTITY = `did:ixo:entity:${'ab12'.repeat(8)}`;
const OTHER_ENTITY = `did:ixo:entity:${'cd34'.repeat(8)}`;

interface Recorded {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: unknown;
}

function makeCtx(opts: {
  config?: Record<string, unknown>;
  ucan?: Partial<UcanAdapter>;
  roomId?: string;
}): RuntimeContext {
  const ucan: UcanAdapter = {
    ...createUnsignedUcanAdapter(),
    hasSigningKey: () => true,
    resolveServiceDid: async () => 'did:web:engine.example',
    mintInvocation: async () => 'secret-invocation',
    ...opts.ucan,
  };
  return makeRuntimeContext(
    {},
    {
      ambient: {
        ucan,
        config: {
          MEMORY_ENGINE_URL: 'https://engine.example/',
          ORACLE_ENTITY_DID: ENTITY,
          ORACLE_DID: 'did:ixo:ixo1abc',
          ...opts.config,
        },
      },
      runConfig: {
        context: {
          user: {
            did: 'did:ixo:user1',
            matrixUserId: '@u:ixo.world',
            ucanDelegation: { raw: 'delegation' },
          },
          session: {
            id: 's1',
            client: 'matrix',
            requestId: 'r1',
            ...(opts.roomId === undefined ? {} : { roomId: opts.roomId }),
          },
        },
      },
    },
  );
}

function recordingFetch(
  respond: (call: Recorded) => Response | Promise<Response>,
): { fetchImpl: typeof fetch; calls: Recorded[] } {
  const calls: Recorded[] = [];
  const fetchImpl: typeof fetch = async (input, init) => {
    const headers = new Headers(init?.headers);
    const call: Recorded = {
      url: String(input),
      method: init?.method ?? 'GET',
      headers: Object.fromEntries(headers.entries()),
      body: typeof init?.body === 'string' ? JSON.parse(init.body) : undefined,
    };
    calls.push(call);
    return respond(call);
  };
  return { fetchImpl, calls };
}

const json = (body: unknown, status = 200, headers: HeadersInit = {}) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', ...headers },
  });

describe('createMemoryEngineClient', () => {
  it('sends the UCAN headers plus the oracle entity DID and the room', async () => {
    const { fetchImpl, calls } = recordingFetch(() => json({ documents: [] }));
    const client = await createMemoryEngineClient(
      makeCtx({ roomId: '!room:x' }),
      { fetchImpl },
    );
    await client?.listDocuments('private');

    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe(
      'https://engine.example/knowledge/documents?knowledge_space_type=private',
    );
    expect(calls[0]?.method).toBe('GET');
    expect(calls[0]?.headers).toMatchObject({
      authorization: 'Bearer secret-invocation',
      'x-auth-type': 'ucan',
      'x-oracle-entity-did': ENTITY,
      'x-room-id': '!room:x',
    });
  });

  it('never sends a non-entity DID: an account DID or a malformed entity DID gives no client', async () => {
    const { fetchImpl, calls } = recordingFetch(() => json({ documents: [] }));
    for (const config of [
      { ORACLE_ENTITY_DID: undefined, ORACLE_DID: 'did:ixo:ixo1abc' },
      // ORACLE_DID is never a fallback, even with the entity shape.
      { ORACLE_ENTITY_DID: undefined, ORACLE_DID: OTHER_ENTITY },
      { ORACLE_ENTITY_DID: '', ORACLE_DID: OTHER_ENTITY },
      { ORACLE_ENTITY_DID: 'did:ixo:entity:1', ORACLE_DID: OTHER_ENTITY },
      { ORACLE_ENTITY_DID: 'did:ixo:entity:' + 'AB12'.repeat(8) },
      { ORACLE_ENTITY_DID: `${ENTITY}x` },
    ]) {
      expect(
        await createMemoryEngineClient(makeCtx({ config }), { fetchImpl }),
      ).toBeNull();
    }
    expect(calls).toHaveLength(0);
  });

  it('warns once per isolate when the entity DID is missing', () => {
    resetMemoryEngineWarningsForTests();
    const warn = vi.fn();
    const ctx = makeCtx({ config: { ORACLE_ENTITY_DID: undefined } });
    const withLogger = { ...ctx, logger: { ...ctx.logger, warn } };
    expect(entityDidOrWarn(withLogger)).toBeUndefined();
    expect(entityDidOrWarn(withLogger)).toBeUndefined();
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0]?.[0])).toContain('set ORACLE_ENTITY_DID');
    resetMemoryEngineWarningsForTests();
  });

  it('carries the parts the engine had queued on a PARTIAL_QUEUE answer', async () => {
    const { fetchImpl } = recordingFetch(() =>
      json({ code: 'PARTIAL_QUEUE', queued: 3, detail: 'queue stopped' }, 503),
    );
    const client = await createMemoryEngineClient(makeCtx({}), { fetchImpl });
    await expect(
      client?.addDocument({
        knowledge_space_type: 'public',
        confirmed_insertion_from_user: true,
        chunks: [{ content: 'x' }],
      }),
    ).rejects.toMatchObject({ code: 'PARTIAL_QUEUE', queued: 3, status: 503 });
  });

  it('mints once for the whole client', async () => {
    const mintInvocation = vi.fn(async () => 'tok');
    const { fetchImpl } = recordingFetch(() => json({ documents: [] }));
    const client = await createMemoryEngineClient(
      makeCtx({ ucan: { mintInvocation } }),
      { fetchImpl },
    );
    await client?.listDocuments('public');
    await client?.listDocuments('private');
    expect(mintInvocation).toHaveBeenCalledTimes(1);
    expect(mintInvocation).toHaveBeenCalledWith(
      'did:ixo:user1',
      { did: 'did:web:engine.example', capability: 'ixo:memory' },
      { can: 'memory/*' },
    );
  });

  it('posts, reads and deletes with the documented routes and bodies', async () => {
    const { fetchImpl, calls } = recordingFetch((call) => {
      if (call.method === 'POST') {
        return json(
          {
            success: true,
            document: {
              id: 'd1',
              generation: 2,
              chunk_count: 1,
              status: 'ingesting',
              replaced: true,
            },
            queued: 1,
          },
          202,
        );
      }
      if (call.method === 'DELETE') {
        return json(
          {
            success: true,
            document: { id: 'd1', status: 'deleting', chunks: 3 },
          },
          202,
        );
      }
      return json({
        id: 'd 1',
        title: 'T',
        generation: 1,
        chunk_count: 1,
        chunks_indexed: 1,
        status: 'ready',
        chunks: [],
      });
    });
    const client = await createMemoryEngineClient(makeCtx({}), { fetchImpl });
    const body = {
      knowledge_space_type: 'public' as const,
      confirmed_insertion_from_user: true as const,
      document: { id: 'd1', title: 'T' },
      chunks: [{ label: 'part 1 of 1', content: 'hello' }],
    };
    const added = await client?.addDocument(body);
    expect(added?.document?.replaced).toBe(true);
    expect(calls[0]?.url).toBe('https://engine.example/knowledge/documents');
    expect(calls[0]?.headers['content-type']).toBe('application/json');
    expect(calls[0]?.body).toEqual(body);

    await client?.getDocument('d 1', 'public');
    expect(calls[1]?.url).toBe(
      'https://engine.example/knowledge/documents/d%201?knowledge_space_type=public',
    );

    expect(await client?.deleteDocument('d1', 'private')).toEqual({
      id: 'd1',
      status: 'deleting',
      chunks: 3,
    });
    expect(calls[2]?.method).toBe('DELETE');
    expect(calls[2]?.url).toContain('/knowledge/documents/d1?');
  });

  it('turns an error body into a MemoryEngineError without leaking the bearer', async () => {
    const { fetchImpl } = recordingFetch(() =>
      json({ detail: 'queue full', code: 'QUEUE_FULL', retryable: true }, 429, {
        'Retry-After': '5',
      }),
    );
    const client = await createMemoryEngineClient(makeCtx({}), { fetchImpl });
    const err = await client?.listDocuments('public').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(MemoryEngineError);
    if (!(err instanceof MemoryEngineError)) throw new Error('unreachable');
    expect(err).toMatchObject({
      status: 429,
      code: 'QUEUE_FULL',
      detail: 'queue full',
      retryable: true,
      retryAfterSeconds: 5,
    });
    expect(err.message).toBe('memory engine answered 429 QUEUE_FULL');
    expect(err.message).not.toContain('secret-invocation');
  });

  it('keeps structured validation detail and survives a non-JSON error', async () => {
    const structured = recordingFetch(() =>
      json({ detail: [{ loc: ['body', 'chunks'], msg: 'too many' }] }, 422),
    );
    const client = await createMemoryEngineClient(makeCtx({}), {
      fetchImpl: structured.fetchImpl,
    });
    const err = await client?.listDocuments('public').catch((e: unknown) => e);
    expect(err).toMatchObject({ status: 422 });
    expect(err instanceof MemoryEngineError && err.detail).toContain(
      'too many',
    );

    const html = recordingFetch(
      () =>
        new Response('<html>boom secret-invocation</html>', { status: 502 }),
    );
    const client2 = await createMemoryEngineClient(makeCtx({}), {
      fetchImpl: html.fetchImpl,
    });
    const err2 = await client2
      ?.listDocuments('public')
      .catch((e: unknown) => e);
    expect(err2).toMatchObject({ status: 502, retryable: false });
    expect(err2 instanceof Error && err2.message).toBe(
      'memory engine answered 502',
    );
  });

  it('reports a timeout as a retryable TIMEOUT error', async () => {
    const fetchImpl: typeof fetch = (_input, init) =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () =>
          reject(init.signal?.reason),
        );
      });
    const client = await createMemoryEngineClient(makeCtx({}), {
      fetchImpl,
      timeoutMs: 20,
    });
    const err = await client?.listDocuments('public').catch((e: unknown) => e);
    expect(err).toMatchObject({ status: 0, code: 'TIMEOUT', retryable: true });
  });

  it('rejects a malformed success body', async () => {
    const { fetchImpl } = recordingFetch(() => json({ nope: true }));
    const client = await createMemoryEngineClient(makeCtx({}), { fetchImpl });
    await expect(client?.listDocuments('public')).rejects.toMatchObject({
      code: 'MALFORMED_RESPONSE',
    });
  });

  it('is null when the engine URL is missing', async () => {
    expect(
      await createMemoryEngineClient(
        makeCtx({ config: { MEMORY_ENGINE_URL: undefined } }),
      ),
    ).toBeNull();
  });

  it('is null when the service DID cannot be resolved or the mint fails', async () => {
    expect(
      await createMemoryEngineClient(
        makeCtx({ ucan: { resolveServiceDid: async () => null } }),
      ),
    ).toBeNull();
    expect(
      await createMemoryEngineClient(
        makeCtx({
          ucan: {
            mintInvocation: async () => {
              throw new Error('no signing key');
            },
          },
        }),
      ),
    ).toBeNull();
  });
});

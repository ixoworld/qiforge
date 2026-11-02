import { z } from 'zod';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createUnsignedUcanAdapter,
  type UcanAdapter,
} from '../../core/runtime-context';
import { makeRuntimeContext } from '../../core/test-fixtures';
import { MEMORY_WRITE_TOOL_NAMES } from '../../memory/user-context-invalidation';
import type { PluginTool, RuntimeContext } from '../../plugin-api/types';
import { loadDocumentText } from './document-source';
import { resetMemoryEngineWarningsForTests } from './memory-engine-client';
import {
  ADD_ORACLE_DOCUMENT_DESCRIPTION,
  createOracleDocumentTools,
  DELETE_ORACLE_DOCUMENT_DESCRIPTION,
  deriveDocumentId,
  resetDocumentKnobWarningsForTests,
  slugifyTitle,
} from './oracle-document-tools';

const ENTITY = `did:ixo:entity:${'ab12'.repeat(8)}`;

vi.mock('./document-source', () => ({ loadDocumentText: vi.fn() }));

const loadMock = vi.mocked(loadDocumentText);

interface Recorded {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: unknown;
}

function makeCtx(config: Record<string, unknown> = {}): RuntimeContext {
  const ucan: UcanAdapter = {
    ...createUnsignedUcanAdapter(),
    hasSigningKey: () => true,
    resolveServiceDid: async () => 'did:web:engine.example',
    mintInvocation: async () => 'tok',
  };
  return makeRuntimeContext(
    {},
    {
      ambient: {
        ucan,
        config: {
          MEMORY_ENGINE_URL: 'https://engine.example',
          ORACLE_ENTITY_DID: ENTITY,
          ...config,
        },
      },
      runConfig: {
        context: {
          user: {
            did: 'did:ixo:user1',
            matrixUserId: '@u:ixo.world',
            ucanDelegation: { raw: 'delegation' },
          },
          session: { id: 's1', client: 'matrix', requestId: 'r1' },
        },
      },
    },
  );
}

const json = (body: unknown, status = 200, headers: HeadersInit = {}) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', ...headers },
  });

/**
 * `respond` answers writes and deletes; `listRespond` answers every GET (the
 * access pre-check and the list tool), by default an empty list.
 */
function harness(
  respond: (call: Recorded) => Response,
  listRespond: (call: Recorded) => Response = () => json({ documents: [] }),
) {
  const calls: Recorded[] = [];
  const writes: Recorded[] = [];
  const fetchImpl: typeof fetch = async (input, init) => {
    const call: Recorded = {
      url: String(input),
      method: init?.method ?? 'GET',
      headers: Object.fromEntries(new Headers(init?.headers).entries()),
      body: typeof init?.body === 'string' ? JSON.parse(init.body) : undefined,
    };
    calls.push(call);
    if (call.method === 'GET') return listRespond(call);
    writes.push(call);
    return respond(call);
  };
  const tools = createOracleDocumentTools({ fetchImpl });
  const find = (name: string): PluginTool => {
    const found = tools.find((t) => t.name === name);
    if (!found) throw new Error(`no tool ${name}`);
    return found;
  };
  return { calls, writes, tools, find };
}

const GROUPED_REPLY = {
  success: true,
  document: {
    id: 'board-2026',
    generation: 1,
    chunk_count: 1,
    status: 'ingesting',
    replaced: false,
  },
  queued: 1,
};

function loaded(text: string, extra: Partial<{ truncated: boolean }> = {}) {
  return {
    text,
    filename: 'resolution.txt',
    mimetype: 'text/plain',
    bytes: text.length,
    method: 'text' as const,
    truncated: false,
    ...extra,
  };
}

const baseArgs = {
  source: { kind: 'attachment', ref: '$evt1' },
  title: 'Board resolution',
  knowledge_space_type: 'public',
  group_as_document: true,
  confirmed_insertion_from_user: true,
};

beforeEach(() => {
  loadMock.mockReset();
  resetMemoryEngineWarningsForTests();
  resetDocumentKnobWarningsForTests();
});

function withWarnSpy(ctx: RuntimeContext) {
  const warn = vi.fn();
  return { ctx: { ...ctx, logger: { ...ctx.logger, warn } }, warn };
}

describe('tool surface', () => {
  it('exposes three tools with the right effects', () => {
    const { tools } = harness(() => json({}));
    expect(tools.map((t) => t.name)).toEqual([
      'add_oracle_document',
      'list_oracle_documents',
      'delete_oracle_document',
    ]);
    expect(tools.map((t) => t.effect)).toEqual([undefined, 'read', undefined]);
  });

  it('puts the grouped-or-loose rule and the confirmation rule in the description', () => {
    expect(ADD_ORACLE_DOCUMENT_DESCRIPTION).toContain('board resolution');
    expect(ADD_ORACLE_DOCUMENT_DESCRIPTION).toContain(
      'unrelated company facts',
    );
    expect(ADD_ORACLE_DOCUMENT_DESCRIPTION).toContain(
      'required and has no default',
    );
    expect(ADD_ORACLE_DOCUMENT_DESCRIPTION).toContain('ask the person');
  });

  it('requires group_as_document in the schema', () => {
    const { find } = harness(() => json({}));
    const { group_as_document: _omit, ...withoutFlag } = baseArgs;
    expect(
      find('add_oracle_document').schema.safeParse(withoutFlag).success,
    ).toBe(false);
    expect(find('add_oracle_document').schema.safeParse(baseArgs).success).toBe(
      true,
    );
  });

  it('invalidates the user-context cache after a successful write', () => {
    expect(MEMORY_WRITE_TOOL_NAMES).toContain('add_oracle_document');
    expect(MEMORY_WRITE_TOOL_NAMES).toContain('delete_oracle_document');
    expect(MEMORY_WRITE_TOOL_NAMES).not.toContain('list_oracle_documents');
  });
});

describe('add_oracle_document', () => {
  it('writes a grouped document with its id and page labels', async () => {
    loadMock.mockResolvedValue(
      loaded(
        '--- page 1 ---\nResolved: pay the bonus.\n--- page 2 ---\nSigned.',
      ),
    );
    const { writes, find } = harness(() => json(GROUPED_REPLY, 202));
    const out = await find('add_oracle_document').handler(
      {
        ...baseArgs,
        document_id: 'board-2026',
        source_description: 'Signed by the secretary',
      },
      makeCtx(),
    );

    expect(loadMock).toHaveBeenCalledWith(
      expect.anything(),
      { attachment_ref: '$evt1' },
      expect.objectContaining({ maxChars: 768_000 }),
    );
    expect(writes).toHaveLength(1);
    expect(writes[0]?.method).toBe('POST');
    expect(writes[0]?.headers['x-oracle-entity-did']).toBe(ENTITY);
    expect(writes[0]?.body).toEqual({
      knowledge_space_type: 'public',
      confirmed_insertion_from_user: true,
      document: {
        id: 'board-2026',
        title: 'Board resolution',
        source_description: 'Signed by the secretary',
      },
      if_exists: 'replace',
      chunks: [
        {
          label: 'p. 1–2',
          content:
            '--- page 1 ---\nResolved: pay the bonus.\n\n--- page 2 ---\nSigned.',
        },
      ],
    });
    expect(JSON.parse(String(out))).toMatchObject({
      document_id: 'board-2026',
      generation: 1,
      chunks: 1,
      status: 'ingesting',
      replaced: false,
      method: 'text',
      truncated: false,
    });
  });

  it('reports the chunks of a replaced generation still being removed', async () => {
    loadMock.mockResolvedValue(loaded('hello'));
    const { find } = harness(() =>
      json(
        {
          ...GROUPED_REPLY,
          document: {
            ...GROUPED_REPLY.document,
            generation: 2,
            replaced: true,
            retiring_chunks: 5,
          },
        },
        202,
      ),
    );
    const out = await find('add_oracle_document').handler(baseArgs, makeCtx());
    expect(JSON.parse(String(out))).toMatchObject({
      replaced: true,
      retiring_chunks: 5,
    });
  });

  it('writes loose facts without a document and with the title in the label', async () => {
    loadMock.mockResolvedValue(
      loaded('Office is on Main St.\n\nRefunds in 14 days.'),
    );
    const { writes, find } = harness(() =>
      json({ success: true, queued: 1, chunk_ids: ['c1'] }, 202),
    );
    const out = await find('add_oracle_document').handler(
      {
        ...baseArgs,
        group_as_document: false,
        source: { kind: 'vfs', ref: '/private/x.md' },
      },
      makeCtx(),
    );
    expect(loadMock.mock.calls[0]?.[1]).toEqual({ vfs_path: '/private/x.md' });
    expect(writes[0]?.body).toEqual({
      knowledge_space_type: 'public',
      confirmed_insertion_from_user: true,
      chunks: [
        {
          label: 'Board resolution — part 1 of 1',
          content: 'Office is on Main St.\n\nRefunds in 14 days.',
        },
      ],
    });
    expect(JSON.parse(String(out))).toMatchObject({
      queued: 1,
      chunk_ids_count: 1,
      method: 'text',
    });
  });

  it('asks for confirmation and touches nothing when it is missing', async () => {
    const { writes, find } = harness(() => json({}));
    const out = await find('add_oracle_document').handler(
      { ...baseArgs, confirmed_insertion_from_user: false },
      makeCtx(),
    );
    expect(String(out)).toMatch(/^Confirmation required/);
    expect(loadMock).not.toHaveBeenCalled();
    expect(writes).toHaveLength(0);
  });

  it('has the schema, not the handler, refuse a malformed call', () => {
    const { find } = harness(() => json({}));
    const schema = find('add_oracle_document').schema;
    expect(
      schema.safeParse({ ...baseArgs, source: { kind: 'attachment' } }).success,
    ).toBe(false);
    expect(
      schema.safeParse({ ...baseArgs, source: { kind: 'url', ref: 'x' } })
        .success,
    ).toBe(false);
    expect(schema.safeParse({ ...baseArgs, title: '' }).success).toBe(false);
    expect(schema.safeParse({ ...baseArgs, document_id: '-bad' }).success).toBe(
      false,
    );
    expect(schema.safeParse({ ...baseArgs, extra: 1 }).success).toBe(false);
    expect(
      schema.safeParse({ ...baseArgs, document_id: 'ok.id' }).success,
    ).toBe(true);
  });

  it('refuses a kind that does not match its ref, before touching the file', async () => {
    const { calls, find } = harness(() => json({}));
    const add = find('add_oracle_document');
    expect(
      String(
        await add.handler(
          { ...baseArgs, source: { kind: 'vfs', ref: 'private/x.md' } },
          makeCtx(),
        ),
      ),
    ).toContain('absolute Library path');
    expect(
      String(
        await add.handler(
          { ...baseArgs, source: { kind: 'attachment', ref: '/private/x.md' } },
          makeCtx(),
        ),
      ),
    ).toContain('use kind vfs');
    expect(loadMock).not.toHaveBeenCalled();
    expect(calls).toHaveLength(0);
  });

  it('ignores document_id, if_exists and source_description in loose mode and says so', async () => {
    loadMock.mockResolvedValue(loaded('Office is on Main St.'));
    const { writes, find } = harness(() =>
      json({ success: true, queued: 1, chunk_ids: ['c1'] }, 202),
    );
    const out = await find('add_oracle_document').handler(
      {
        ...baseArgs,
        group_as_document: false,
        document_id: 'x',
        if_exists: 'fail',
        source_description: 'dumped',
      },
      makeCtx(),
    );
    const body = z
      .object({ chunks: z.array(z.unknown()) })
      .passthrough()
      .parse(writes[0]?.body);
    expect(body).not.toHaveProperty('document');
    expect(body).not.toHaveProperty('if_exists');
    expect(JSON.parse(String(out)).ignored_in_loose_mode).toEqual([
      'document_id',
      'if_exists',
      'source_description',
    ]);
  });

  it('relays an unknown attachment as a message', async () => {
    loadMock.mockRejectedValue(
      new Error(
        'No attachment $evt1 in this conversation; ask the person to attach the file again.',
      ),
    );
    const { writes, find } = harness(() => json({}));
    const out = await find('add_oracle_document').handler(baseArgs, makeCtx());
    expect(String(out)).toContain('No attachment $evt1');
    expect(writes).toHaveLength(0);
  });

  it('refuses a document over the part limit, and writes the first parts with allow_truncation', async () => {
    const text = Array.from(
      { length: 10 },
      (_, i) => `${i}${'z'.repeat(1500)}`,
    ).join('\n\n');
    loadMock.mockResolvedValue(loaded(text));
    const cfg = {
      MEMORY_DOCUMENT_CHUNK_BYTES: '1024',
      MEMORY_DOCUMENT_MAX_CHUNKS: '3',
    };
    const { writes, find } = harness(() => json(GROUPED_REPLY, 202));
    const add = find('add_oracle_document');

    const refused = await add.handler(baseArgs, makeCtx(cfg));
    expect(String(refused)).toContain('too large to store whole');
    expect(String(refused)).toContain('(15 KB)');
    expect(String(refused)).toContain('at most 3 parts of 1 KB (3 KB in all)');
    expect(String(refused)).toContain('allow_truncation');
    expect(writes).toHaveLength(0);

    const out = await add.handler(
      { ...baseArgs, allow_truncation: true },
      makeCtx(cfg),
    );
    expect(writes).toHaveLength(1);
    const body = z
      .object({ chunks: z.array(z.unknown()) })
      .parse(writes[0]?.body);
    expect(body.chunks).toHaveLength(3);
    expect(JSON.parse(String(out)).truncated).toBe(true);
  });

  it('refuses when the reader hit the character cap', async () => {
    loadMock.mockResolvedValue(loaded('some text', { truncated: true }));
    const { writes, find } = harness(() => json(GROUPED_REPLY, 202));
    const out = await find('add_oracle_document').handler(baseArgs, makeCtx());
    expect(String(out)).toContain('reading stopped at 768000 characters');
    expect(writes).toHaveLength(0);
  });

  it('says so when the file has no text', async () => {
    loadMock.mockResolvedValue(loaded('  \n '));
    const { writes, find } = harness(() => json({}));
    const out = await find('add_oracle_document').handler(baseArgs, makeCtx());
    expect(String(out)).toContain('Nothing to store');
    expect(writes).toHaveLength(0);
  });

  it('is unreachable without MEMORY_ENGINE_URL', async () => {
    const { find } = harness(() => json({}));
    const out = await find('add_oracle_document').handler(
      baseArgs,
      makeCtx({ MEMORY_ENGINE_URL: undefined }),
    );
    expect(String(out)).toContain('not reachable');
    expect(loadMock).not.toHaveBeenCalled();
  });

  it.each([
    [
      403,
      { code: 'DOMAIN_ACCESS_DENIED', detail: 'x' },
      {},
      'not a controller, owner, admin or DAO member',
    ],
    [409, { code: 'DOCUMENT_EXISTS', detail: 'x' }, {}, "if_exists is 'fail'"],
    [
      413,
      { code: 'EPISODE_TOO_LARGE', detail: 'x' },
      {},
      'larger than it accepts',
    ],
    [
      429,
      { code: 'QUEUE_FULL', detail: 'x', retryable: true },
      { 'Retry-After': '5' },
      'queue is full. Retry in about 5 s',
    ],
    [429, { code: 'BUDGET_EXCEEDED', detail: 'x' }, {}, 'budget'],
    [
      422,
      { detail: 'chunks: too long' },
      {},
      'The memory engine refused: status 422 — chunks: too long',
    ],
  ])(
    'maps engine %i %j to plain words',
    async (status, body, headers, expected) => {
      loadMock.mockResolvedValue(loaded('hello'));
      const { find } = harness(() => json(body, status, headers));
      const out = await find('add_oracle_document').handler(
        baseArgs,
        makeCtx(),
      );
      expect(String(out)).toContain(expected);
      expect(String(out)).not.toContain('tok');
    },
  );
});

describe('list_oracle_documents', () => {
  it('lists documents compactly', async () => {
    const { calls, find } = harness(
      () => json({}),
      () =>
        json({
          documents: [
            {
              id: 'board-2026',
              title: 'Board resolution',
              source_description: null,
              generation: 2,
              chunk_count: 4,
              chunks_indexed: 3,
              status: 'ingesting',
              retiring_chunks: 2,
              created_by: 'did:x',
              created_at: '2026-10-01T00:00:00Z',
              updated_at: '2026-10-02T00:00:00Z',
            },
          ],
        }),
    );
    const out = await find('list_oracle_documents').handler(
      { knowledge_space_type: 'private' },
      makeCtx(),
    );
    expect(calls[0]?.url).toContain('knowledge_space_type=private');
    expect(String(out)).toBe(
      '1 document(s) in the private knowledge space (id | title | status | parts | updated):\n' +
        'board-2026 | Board resolution | ingesting (2 old chunks being removed) | 3/4 parts indexed | updated 2026-10-02T00:00:00Z',
    );
  });

  it('reports an empty space', async () => {
    const { find } = harness(() => json({ documents: [] }));
    const out = await find('list_oracle_documents').handler(
      { knowledge_space_type: 'public' },
      makeCtx(),
    );
    expect(String(out)).toBe(
      'No grouped documents in the public knowledge space.',
    );
  });
});

describe('delete_oracle_document', () => {
  it('deletes after confirmation', async () => {
    const { writes, find } = harness(() =>
      json(
        {
          success: true,
          document: { id: 'board-2026', status: 'deleting', chunks: 4 },
        },
        202,
      ),
    );
    const out = await find('delete_oracle_document').handler(
      {
        document_id: 'board-2026',
        knowledge_space_type: 'public',
        confirmed_deletion_from_user: true,
      },
      makeCtx(),
    );
    expect(writes[0]?.method).toBe('DELETE');
    expect(writes[0]?.url).toBe(
      'https://engine.example/knowledge/documents/board-2026?knowledge_space_type=public',
    );
    expect(String(out)).toContain(
      'Deletion scheduled for document "board-2026" (4 chunks)',
    );
  });

  it('asks for confirmation first', async () => {
    const { writes, find } = harness(() => json({}));
    const out = await find('delete_oracle_document').handler(
      {
        document_id: 'board-2026',
        knowledge_space_type: 'public',
        confirmed_deletion_from_user: false,
      },
      makeCtx(),
    );
    expect(String(out)).toMatch(/^Confirmation required/);
    expect(writes).toHaveLength(0);
  });

  it('explains a missing document', async () => {
    const args = {
      document_id: 'nope',
      knowledge_space_type: 'public',
      confirmed_deletion_from_user: true,
    };
    const missing = harness(() => json({ code: 'DOCUMENT_NOT_FOUND' }, 404));
    expect(
      String(
        await missing.find('delete_oracle_document').handler(args, makeCtx()),
      ),
    ).toContain('No document with that id');
  });
});

describe('manifest-level tool choice (description)', () => {
  it('tells the model to use add_oracle_document, not add_oracle_knowledge, for any file', () => {
    expect(
      ADD_ORACLE_DOCUMENT_DESCRIPTION.startsWith(
        'Use this, not memory-engine__add_oracle_knowledge, whenever the knowledge comes from a file',
      ),
    ).toBe(true);
    expect(ADD_ORACLE_DOCUMENT_DESCRIPTION).not.toContain('a policy');
  });

  it('says in the delete description that a second delete retries a failed one', () => {
    expect(DELETE_ORACLE_DOCUMENT_DESCRIPTION).toContain('delete_failed');
    expect(DELETE_ORACLE_DOCUMENT_DESCRIPTION).toContain('call this again');
  });
});

describe('entity DID', () => {
  it.each([
    ['unset', { ORACLE_ENTITY_DID: undefined }],
    ['empty', { ORACLE_ENTITY_DID: '' }],
    ['an account DID', { ORACLE_ENTITY_DID: 'did:ixo:ixo1abcdef' }],
    ['a short entity DID', { ORACLE_ENTITY_DID: 'did:ixo:entity:1' }],
  ])(
    'answers that documents are not configured when ORACLE_ENTITY_DID is %s',
    async (_name, config) => {
      const { calls, find } = harness(() => json({}));
      const { ctx, warn } = withWarnSpy(
        makeCtx({ ...config, ORACLE_DID: 'did:ixo:ixo1abcdef' }),
      );
      for (const [tool, args] of [
        ['add_oracle_document', baseArgs],
        ['list_oracle_documents', { knowledge_space_type: 'public' }],
        [
          'delete_oracle_document',
          {
            document_id: 'x',
            knowledge_space_type: 'public',
            confirmed_deletion_from_user: true,
          },
        ],
      ] as const) {
        expect(String(await find(tool).handler(args, ctx))).toBe(
          'This oracle is not configured for domain documents (ORACLE_ENTITY_DID missing).',
        );
      }
      expect(calls).toHaveLength(0);
      expect(loadMock).not.toHaveBeenCalled();
      expect(warn).toHaveBeenCalledTimes(1);
      expect(String(warn.mock.calls[0]?.[0])).toContain(
        'set ORACLE_ENTITY_DID',
      );
    },
  );

  it('never falls back to ORACLE_DID, even an entity-shaped one', async () => {
    loadMock.mockResolvedValue(loaded('hello'));
    const { writes, find } = harness(() => json(GROUPED_REPLY, 202));
    const out = await find('add_oracle_document').handler(
      baseArgs,
      makeCtx({ ORACLE_ENTITY_DID: undefined, ORACLE_DID: ENTITY }),
    );
    expect(String(out)).toContain('ORACLE_ENTITY_DID missing');
    expect(writes).toHaveLength(0);
    expect(loadMock).not.toHaveBeenCalled();
  });

  it.each([
    ['ENTITY_HEADER_MISSING', 400, 'did not accept the oracle entity DID'],
    ['ENTITY_HEADER_INVALID', 400, 'did not accept the oracle entity DID'],
    ['ENTITY_NOT_VOUCHED', 403, 'does not know this oracle'],
    ['ENTITY_UNVERIFIED', 403, 'try again shortly'],
  ])(
    'maps %s to an operator-facing sentence, logs a warning and reads no file',
    async (code, status, expected) => {
      const { writes, find } = harness(
        () => json({}),
        () => json({ code, detail: 'secret detail', retryable: true }, status),
      );
      const { ctx, warn } = withWarnSpy(makeCtx());
      const out = String(
        await find('add_oracle_document').handler(baseArgs, ctx),
      );
      expect(out).toContain(expected);
      expect(out).not.toContain('secret detail');
      expect(out).not.toContain('tok');
      expect(warn).toHaveBeenCalledWith(expect.stringContaining(code));
      expect(String(warn.mock.calls.flat())).not.toContain('tok');
      expect(loadMock).not.toHaveBeenCalled();
      expect(writes).toHaveLength(0);
    },
  );
});

describe('access pre-check', () => {
  it('stops add_oracle_document on a 403 before any file is read', async () => {
    const { calls, writes, find } = harness(
      () => json(GROUPED_REPLY, 202),
      () => json({ code: 'DOMAIN_ACCESS_DENIED', detail: 'no' }, 403),
    );
    const out = await find('add_oracle_document').handler(baseArgs, makeCtx());
    expect(String(out)).toContain(
      'not a controller, owner, admin or DAO member',
    );
    expect(loadMock).not.toHaveBeenCalled();
    expect(writes).toHaveLength(0);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toContain('knowledge_space_type=private');
  });

  it('stops delete_oracle_document on a 403 before the DELETE', async () => {
    const { writes, find } = harness(
      () => json({}),
      () => json({ code: 'DOMAIN_ACCESS_DENIED' }, 403),
    );
    const out = await find('delete_oracle_document').handler(
      {
        document_id: 'x',
        knowledge_space_type: 'public',
        confirmed_deletion_from_user: true,
      },
      makeCtx(),
    );
    expect(String(out)).toContain('not a controller');
    expect(writes).toHaveLength(0);
  });

  it('lets the write report an inconclusive pre-check (5xx)', async () => {
    loadMock.mockResolvedValue(loaded('hello'));
    const { writes, find } = harness(
      () => json(GROUPED_REPLY, 202),
      () => json({ code: 'INTERNAL' }, 503),
    );
    await find('add_oracle_document').handler(baseArgs, makeCtx());
    expect(loadMock).toHaveBeenCalledTimes(1);
    expect(writes).toHaveLength(1);
  });
});

describe('limits', () => {
  it('defaults the character cap to chunk bytes times parts', async () => {
    loadMock.mockResolvedValue(loaded('hello'));
    const { find } = harness(() => json(GROUPED_REPLY, 202));
    await find('add_oracle_document').handler(
      baseArgs,
      makeCtx({ MEMORY_DOCUMENT_CHUNK_BYTES: '8000' }),
    );
    expect(loadMock.mock.calls[0]?.[2]).toMatchObject({ maxChars: 8000 * 64 });
  });

  it('clamps the part count so the product stays within the engine 900 000 byte cap, warning once', async () => {
    loadMock.mockResolvedValue(loaded('hello'));
    const { writes, find } = harness(() => json(GROUPED_REPLY, 202));
    const { ctx, warn } = withWarnSpy(
      makeCtx({
        MEMORY_DOCUMENT_CHUNK_BYTES: '16384',
        MEMORY_DOCUMENT_MAX_CHUNKS: '64',
      }),
    );
    await find('add_oracle_document').handler(baseArgs, ctx);
    await find('add_oracle_document').handler(baseArgs, ctx);
    expect(loadMock.mock.calls[0]?.[2]).toMatchObject({
      maxChars: 16384 * 54,
    });
    expect(16384 * 54).toBeLessThanOrEqual(900_000);
    expect(writes).toHaveLength(2);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0]?.[0])).toContain('900000');
  });

  it('keeps an explicit MEMORY_DOCUMENT_MAX_CHARS', async () => {
    loadMock.mockResolvedValue(loaded('hello'));
    const { find } = harness(() => json(GROUPED_REPLY, 202));
    await find('add_oracle_document').handler(
      baseArgs,
      makeCtx({ MEMORY_DOCUMENT_MAX_CHARS: '50000' }),
    );
    expect(loadMock.mock.calls[0]?.[2]).toMatchObject({ maxChars: 50_000 });
  });

  it('reports the file size and the real limit in the refusal', async () => {
    loadMock.mockResolvedValue({
      ...loaded('x'.repeat(40_000)),
      bytes: 5 * 1024 * 1024,
    });
    const { find } = harness(() => json(GROUPED_REPLY, 202));
    const out = String(
      await find('add_oracle_document').handler(
        baseArgs,
        makeCtx({
          MEMORY_DOCUMENT_CHUNK_BYTES: '4096',
          MEMORY_DOCUMENT_MAX_CHUNKS: '2',
        }),
      ),
    );
    expect(out).toContain('(5120 KB)');
    expect(out).toContain('at most 2 parts of 4 KB (8 KB in all)');
  });
});

describe('derived document id', () => {
  it('slugs the title to lowercase [a-z0-9.-], at most 80 characters', () => {
    expect(slugifyTitle('Board Resolution — Oct 2026!')).toBe(
      'board-resolution-oct-2026',
    );
    expect(slugifyTitle('  --Ünï  ')).toBe('n');
    expect(slugifyTitle('日本語')).toBe('document');
    expect(slugifyTitle('a'.repeat(200))).toHaveLength(80);
    expect(slugifyTitle('v1.2 Policy')).toBe('v1.2-policy');
  });

  it('is the same for the same content and differs when the content differs', async () => {
    const a = await deriveDocumentId('Board resolution', ['one', 'two']);
    expect(a).toMatch(/^board-resolution-[0-9a-f]{8}$/);
    expect(await deriveDocumentId('Board resolution', ['one', 'two'])).toBe(a);
    expect(
      await deriveDocumentId('Board resolution', ['one', 'two!']),
    ).not.toBe(a);
    expect(await deriveDocumentId('Board resolution', ['onetwo'])).not.toBe(a);
  });

  it('sends a derived id when none is given, so a retry replaces, and reports it', async () => {
    loadMock.mockResolvedValue(loaded('Resolved: pay the bonus.'));
    const { writes, find } = harness((call) => {
      const doc = z
        .object({ document: z.object({ id: z.string() }) })
        .parse(call.body).document;
      return json(
        {
          ...GROUPED_REPLY,
          document: { ...GROUPED_REPLY.document, id: doc.id },
        },
        202,
      );
    });
    const add = find('add_oracle_document');
    const first = JSON.parse(String(await add.handler(baseArgs, makeCtx())));
    const second = JSON.parse(String(await add.handler(baseArgs, makeCtx())));
    expect(first.document_id).toMatch(/^board-resolution-[0-9a-f]{8}$/);
    expect(first.document_id).toBe(second.document_id);
    expect(first.document_id_derived).toBe(true);
    expect(writes[0]?.body).toMatchObject({
      document: { id: first.document_id },
      if_exists: 'replace',
    });
  });

  it('uses the caller id as given and does not call it derived', async () => {
    loadMock.mockResolvedValue(loaded('hello'));
    const { find } = harness(() => json(GROUPED_REPLY, 202));
    const out = JSON.parse(
      String(
        await find('add_oracle_document').handler(
          { ...baseArgs, document_id: 'board-2026' },
          makeCtx(),
        ),
      ),
    );
    expect(out.document_id).toBe('board-2026');
    expect(out).not.toHaveProperty('document_id_derived');
  });
});

describe('retry guidance', () => {
  const timeout = () => {
    throw new DOMException('too slow', 'TimeoutError');
  };

  it('tells a grouped write to call again with the same document_id after a timeout', async () => {
    loadMock.mockResolvedValue(loaded('hello'));
    const { find } = harness(timeout);
    const out = String(
      await find('add_oracle_document').handler(
        { ...baseArgs, document_id: 'board-2026' },
        makeCtx(),
      ),
    );
    expect(out).toContain('same document_id ("board-2026")');
    expect(out).toContain('replaces');
  });

  it('gives the derived id in the timeout hint of a grouped write', async () => {
    loadMock.mockResolvedValue(loaded('hello'));
    const { find } = harness(timeout);
    const out = String(
      await find('add_oracle_document').handler(baseArgs, makeCtx()),
    );
    expect(out).toMatch(/same document_id \("board-resolution-[0-9a-f]{8}"\)/);
  });

  it('tells a loose write not to retry after a timeout and to search instead', async () => {
    loadMock.mockResolvedValue(loaded('hello'));
    const { find } = harness(timeout);
    const out = String(
      await find('add_oracle_document').handler(
        { ...baseArgs, group_as_document: false },
        makeCtx(),
      ),
    );
    expect(out).toContain('Do not retry');
    expect(out).toContain('search');
  });

  it.each([
    [true, 'again with the same document_id ("board-2026")'],
    [false, 'Do NOT retry'],
  ])('maps PARTIAL_QUEUE for grouped=%s', async (grouped, expected) => {
    loadMock.mockResolvedValue(loaded('hello'));
    const { find } = harness(() =>
      json({ code: 'PARTIAL_QUEUE', queued: 7, detail: 'queue stopped' }, 503),
    );
    const out = String(
      await find('add_oracle_document').handler(
        {
          ...baseArgs,
          group_as_document: grouped,
          document_id: undefined,
          ...(grouped ? { document_id: 'board-2026' } : {}),
        },
        makeCtx(),
      ),
    );
    expect(out).toContain('7 part(s) were stored before the engine stopped');
    expect(out).toContain(expected);
  });

  it('uses the engine Retry-After for DOCUMENT_BACKLOG, BUDGET_EXCEEDED and other 429s', async () => {
    loadMock.mockResolvedValue(loaded('hello'));
    for (const [code, expected] of [
      ['DOCUMENT_BACKLOG', 'Retry in about 42 s'],
      ['BUDGET_EXCEEDED', 'Retry in about 42 s'],
      ['USER_RATE_LIMITED', 'Retry in about 42 s'],
      ['SOMETHING_NEW', 'Retry in about 42 s'],
    ] as const) {
      const { find } = harness(() =>
        json({ code }, 429, { 'Retry-After': '42' }),
      );
      const out = String(
        await find('add_oracle_document').handler(baseArgs, makeCtx()),
      );
      expect(out).toContain(expected);
    }
  });

  it('keeps a generic wait for DOCUMENT_BACKLOG without Retry-After', async () => {
    loadMock.mockResolvedValue(loaded('hello'));
    const { find } = harness(() => json({ code: 'DOCUMENT_BACKLOG' }, 429));
    expect(
      String(await find('add_oracle_document').handler(baseArgs, makeCtx())),
    ).toContain('about a minute');
  });

  it('maps DOCUMENT_INGESTING on delete', async () => {
    const { find } = harness(() => json({ code: 'DOCUMENT_INGESTING' }, 409));
    const out = await find('delete_oracle_document').handler(
      {
        document_id: 'x',
        knowledge_space_type: 'public',
        confirmed_deletion_from_user: true,
      },
      makeCtx(),
    );
    expect(String(out)).toContain('still being processed');
  });
});

describe('list_oracle_documents filters', () => {
  const doc = (id: string, status: string, extra: object = {}) => ({
    id,
    title: `Title ${id}`,
    generation: 1,
    chunk_count: 2,
    chunks_indexed: 2,
    status,
    created_at: '2026-10-01T00:00:00Z',
    ...extra,
  });
  const many = [
    doc('a', 'ready'),
    doc('b', 'delete_failed', { delete_error: 'graph store unreachable' }),
    doc('c', 'ready'),
    doc('d', 'ingesting'),
  ];

  it('filters by status and shows the delete error of a failed deletion', async () => {
    const { find } = harness(
      () => json({}),
      () => json({ documents: many }),
    );
    const failed = String(
      await find('list_oracle_documents').handler(
        { knowledge_space_type: 'public', status: 'delete_failed' },
        makeCtx(),
      ),
    );
    expect(failed).toContain('1 document(s) with status delete_failed');
    expect(failed).toContain(
      'b | Title b | delete_failed: graph store unreachable',
    );
    expect(failed).not.toContain('Title a');

    const none = String(
      await find('list_oracle_documents').handler(
        { knowledge_space_type: 'public', status: 'partial' },
        makeCtx(),
      ),
    );
    expect(none).toBe(
      'No grouped documents with status partial in the public knowledge space.',
    );
  });

  it('caps the rows at limit and says how many exist', async () => {
    const { find } = harness(
      () => json({}),
      () => json({ documents: many }),
    );
    const out = String(
      await find('list_oracle_documents').handler(
        { knowledge_space_type: 'public', limit: 2 },
        makeCtx(),
      ),
    );
    expect(out).toContain('2 of 4 document(s)');
    expect(out).toContain('Title a');
    expect(out).toContain('Title b');
    expect(out).not.toContain('Title c');
  });

  it('defaults the limit to 100 and bounds it at 500 in the schema', async () => {
    const hundredTwenty = Array.from({ length: 120 }, (_, i) =>
      doc(`d${i}`, 'ready'),
    );
    const { find } = harness(
      () => json({}),
      () => json({ documents: hundredTwenty }),
    );
    const list = find('list_oracle_documents');
    const out = String(
      await list.handler({ knowledge_space_type: 'public' }, makeCtx()),
    );
    expect(out).toContain('100 of 120 document(s)');
    expect(
      list.schema.safeParse({ knowledge_space_type: 'public', limit: 501 })
        .success,
    ).toBe(false);
    expect(
      list.schema.safeParse({ knowledge_space_type: 'public', limit: 500 })
        .success,
    ).toBe(true);
  });
});

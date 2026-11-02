/**
 * In-process mock of the Memory Engine MCP server, for the MCP-path e2e.
 *
 * Real pieces under test on the oracle side: `MultiServerMCPClient` speaking
 * Streamable HTTP from inside workerd, the JSON-Schema→zod tool adaptation,
 * and the per-request UCAN headers. This mock therefore implements the REAL
 * wire protocol (via `@modelcontextprotocol/sdk`'s `McpServer` + the
 * streamable-HTTP transport in stateless mode) — only the memory "engine"
 * behind the tools is fake: an in-memory list, so a fact stored by
 * `add_memory` in one turn comes back from `search_memory_engine` in the
 * next.
 *
 * The same server answers the engine's REST `POST /search-enhanced-batch`
 * (what the runtime's first-turn user-context prefetch calls with
 * `MEMORY_ENGINE_URL`): six slots in query order, the stored memories
 * returned as facts in the first (identity) and last (recent) slot. And it
 * accepts the session-history indexer's `POST /messages` upload (recorded,
 * answered 202 `{ accepted: <message count> }`, nothing stored) unless
 * `state.historyUploads` is `'refuse'`, which answers 503 so the runtime
 * treats the upload as failed (recorded with `refused: true`).
 *
 * The engine's document routes (`POST|GET|DELETE /knowledge/documents`) are
 * an in-memory store that validates the contract the runtime's oracle
 * document tools code against (UCAN headers, `x-oracle-entity-did`, the
 * confirmation flag, the chunk caps) and records every request.
 *
 * Also serves `/.well-known/did.json` (the oracle resolves the service DID
 * from the MCP URL's origin before minting), and `GET /__test/state` exposing
 * every recorded request + tool call for assertions. Each recorded request
 * keeps the auth headers, `x-room-id` and `x-oracle-entity-did` (the domain
 * entity the real engine keys every memory space by), and a batch request
 * also its queries' `oracle_dids`.
 */
import { randomBytes } from 'node:crypto';
import {
  createServer,
  type IncomingMessage,
  type Server as HttpServer,
  type ServerResponse,
} from 'node:http';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { z } from 'zod';

export interface RecordedRequest {
  method: string;
  /** Request path: `/mcp` or `/search-enhanced-batch`. */
  pathname: string;
  /** JSON-RPC methods contained in the request body (POSTs only). */
  rpcMethods: string[];
  authorization?: string;
  xAuthType?: string;
  xRoomId?: string;
  /** `x-oracle-entity-did`: the oracle's domain entity (`ORACLE_ENTITY_DID`). */
  xOracleEntityDid?: string;
  /** `/search-enhanced-batch` only: how many queries the batch carried. */
  queryCount?: number;
  /** `/messages` only: how many messages the history upload carried. */
  messageCount?: number;
  /** `/messages` only: the mock refused it (`state.historyUploads`). */
  refused?: boolean;
  /**
   * `/search-enhanced-batch` only: every query's `oracle_dids`, in query
   * order (a query without a string-array `oracle_dids` records `[]`).
   */
  oracleDids?: string[][];
}

export interface RecordedToolCall {
  tool: string;
  args: Record<string, unknown>;
}

export interface RecordedDocumentRequest {
  method: string;
  pathname: string;
  search: string;
  authorization?: string;
  xAuthType?: string;
  xRoomId?: string;
  xOracleEntityDid?: string;
  /** Parsed JSON body (POST only). */
  body?: unknown;
}

export interface MockDocumentChunk {
  label?: string;
  content: string;
}

export interface MockDocument {
  id: string;
  space: string;
  title: string;
  source_description: string | null;
  generation: number;
  chunks: MockDocumentChunk[];
  /** `ingesting` until `INGEST_MS` after the write, then `ready`; `deleting` after a DELETE. */
  status: 'ingesting' | 'ready' | 'deleting';
  createdAtMs: number;
  /** When a `deleting` document disappears (the engine removes it in the background). */
  removeAtMs?: number;
}

export interface MockMcpState {
  requests: RecordedRequest[];
  /** Every `/knowledge/documents` request, in arrival order. */
  documentRequests: RecordedDocumentRequest[];
  /** Grouped documents currently stored. */
  documents: MockDocument[];
  /** Chunks stored without a document (`group_as_document: false`). */
  looseChunks: Array<MockDocumentChunk & { id: string; space: string }>;
  toolCalls: RecordedToolCall[];
  memories: string[];
  /**
   * Whether `/search-enhanced-batch` returns the stored memories (default
   * true). A drill that must prove the MCP search tool again switches it off,
   * so the model cannot recall from the pre-loaded context.
   */
  batchServesMemories: boolean;
  /**
   * Delay before the batch endpoint answers, in ms (default 0). A drill sets
   * it above the runtime's prefetch cap to prove the gather that outlives a
   * turn still fills the room's cache for the next session.
   */
  batchDelayMs: number;
  /**
   * Whether `POST /messages` (the session-history upload the runtime sends
   * for the previous session whenever a new one is created) is accepted
   * (default) or refused with 503. An accepted upload makes the runtime drop
   * the room's prefetched user context, so a drill that asserts on that
   * cache refuses uploads for the duration of the assertion.
   */
  historyUploads: 'accept' | 'refuse';
  /**
   * Printed by `search_memory_engine` and never by the batch endpoint, so an
   * answer containing it came over the MCP wire even when a cached
   * pre-loaded context already carries the memory text.
   */
  lookupReference: string;
}

export interface MockMcpServer {
  port: number;
  origin: string;
  /** The MCP endpoint URL — what MEMORY_MCP_URL should be set to. */
  mcpUrl: string;
  did: string;
  state: MockMcpState;
  stop: () => Promise<void>;
}

function text(s: string) {
  return { content: [{ type: 'text' as const, text: s }] };
}

function buildMcpServer(state: MockMcpState): McpServer {
  const server = new McpServer({
    name: 'memory-engine-mock',
    version: '1.0.0',
  });
  server.registerTool(
    'search_memory_engine',
    {
      description:
        'Search the memories stored about the current user. Returns the matching memory texts.',
      inputSchema: {
        query: z.string().describe('What to look for in the stored memories.'),
      },
    },
    (args: { query: string }) => {
      state.toolCalls.push({ tool: 'search_memory_engine', args });
      if (state.memories.length === 0) return text('No memories found.');
      return text(
        `Found ${state.memories.length} memories:\n${state.memories
          .map((m) => `- ${m}`)
          .join('\n')}\nLookup reference: ${state.lookupReference}`,
      );
    },
  );
  server.registerTool(
    'add_memory',
    {
      description:
        'Store one durable memory about the current user. `content` is the memory text.',
      inputSchema: {
        content: z.string().describe('The memory text to store.'),
        name: z
          .string()
          .optional()
          .describe('Optional short label for the memory.'),
      },
    },
    (args: { content: string; name?: string }) => {
      state.toolCalls.push({ tool: 'add_memory', args });
      state.memories.push(args.content);
      return text('Memory stored.');
    },
  );
  // In the runtime's default tool surface since 0.21.0; the real engine
  // refuses a caller who is not a controller or owner of the oracle's
  // entity. The mock records the call and refuses the same way without the
  // confirmation flag, so a drill can tell a stored write from a refused one.
  server.registerTool(
    'add_oracle_knowledge',
    {
      description:
        'Store knowledge shared with every user of this oracle. Needs the user to confirm the scope first.',
      inputSchema: {
        name: z.string().describe('Short title of the knowledge.'),
        content: z.string().describe('The knowledge text to store.'),
        confirmed_insertion_from_user: z
          .boolean()
          .describe('The user confirmed the knowledge may be shared.'),
        knowledge_space_type: z
          .enum(['public', 'private'])
          .describe(
            'public: every user of the oracle; private: its controllers and owners.',
          ),
      },
    },
    (args: {
      name: string;
      content: string;
      confirmed_insertion_from_user: boolean;
      knowledge_space_type: 'public' | 'private';
    }) => {
      state.toolCalls.push({ tool: 'add_oracle_knowledge', args });
      if (!args.confirmed_insertion_from_user) {
        return text(
          'Oracle knowledge addition requires explicit user confirmation.',
        );
      }
      return text(
        `Oracle knowledge "${args.name}" added to shared knowledge space`,
      );
    },
  );
  server.registerTool(
    'delete_episode',
    {
      description: 'Delete one stored memory episode by its id.',
      inputSchema: {
        episode_id: z.string().describe('Id of the episode.'),
      },
    },
    (args: { episode_id: string }) => {
      state.toolCalls.push({ tool: 'delete_episode', args });
      return text('Episode deleted.');
    },
  );
  server.registerTool(
    'clear',
    {
      description: 'Erase ALL memories stored about the current user.',
      inputSchema: {},
    },
    () => {
      state.toolCalls.push({ tool: 'clear', args: {} });
      state.memories.length = 0;
      return text('All memories cleared.');
    },
  );
  return server;
}

/** JSON-RPC method names in a (possibly batched) request body. */
function rpcMethodsOf(body: unknown): string[] {
  const items = Array.isArray(body) ? body : [body];
  return items
    .map((m) =>
      m !== null && typeof m === 'object' && 'method' in m
        ? String((m as { method: unknown }).method)
        : '',
    )
    .filter(Boolean);
}

/** The fields of the engine's `SearchEnhancedResponse` the mock fills. */
interface MockSearchSlot {
  strategy_used: string;
  query: string;
  total_results: {
    facts: number;
    entities: number;
    episodes: number;
    communities: number;
  };
  facts: Array<{
    uuid: string;
    fact: string;
    source_node_uuid: string;
    target_node_uuid: string;
    created_at: string;
    valid_at: string | null;
    invalid_at: string | null;
  }>;
  entities: never[];
  episodes: never[];
  communities: never[];
}

/**
 * One batch answer slot. Every stored memory is a fact in the `identity` and
 * `recent` slots (the first and last query of the runtime's batch); the
 * other four slots come back empty.
 */
function searchSlot(
  request: BatchQuery,
  memories: readonly string[],
  withMemories: boolean,
): MockSearchSlot {
  const now = new Date().toISOString();
  const facts = withMemories
    ? memories.map((fact, i) => ({
        uuid: `mock-fact-${i}`,
        fact,
        source_node_uuid: 'mock-user',
        target_node_uuid: `mock-fact-target-${i}`,
        created_at: now,
        valid_at: now,
        invalid_at: null,
      }))
    : [];
  return {
    strategy_used: request.strategy,
    query: request.query,
    total_results: {
      facts: facts.length,
      entities: 0,
      episodes: 0,
      communities: 0,
    },
    facts,
    entities: [],
    episodes: [],
    communities: [],
  };
}

/** One request of a `/search-enhanced-batch` body: the fields the mock echoes. */
interface BatchQuery {
  query: string;
  strategy: string;
  /** The entity DIDs the query searches (wire name `oracle_dids`). */
  oracleDids: string[];
}

/** The queries of a `/search-enhanced-batch` body; undefined when malformed. */
function batchQueries(body: unknown): BatchQuery[] | undefined {
  if (body === null || typeof body !== 'object' || !('queries' in body))
    return undefined;
  const { queries } = body;
  if (!Array.isArray(queries)) return undefined;
  return queries.map((q: unknown): BatchQuery => {
    const query =
      q !== null &&
      typeof q === 'object' &&
      'query' in q &&
      typeof q.query === 'string'
        ? q.query
        : '';
    const strategy =
      q !== null &&
      typeof q === 'object' &&
      'strategy' in q &&
      typeof q.strategy === 'string'
        ? q.strategy
        : 'balanced';
    const oracleDids =
      q !== null &&
      typeof q === 'object' &&
      'oracle_dids' in q &&
      Array.isArray(q.oracle_dids)
        ? q.oracle_dids.filter(
            (d: unknown): d is string => typeof d === 'string',
          )
        : [];
    return { query, strategy, oracleDids };
  });
}

function recordedHeaders(
  req: IncomingMessage,
): Pick<
  RecordedRequest,
  'authorization' | 'xAuthType' | 'xRoomId' | 'xOracleEntityDid'
> {
  return {
    ...(req.headers.authorization
      ? { authorization: req.headers.authorization }
      : {}),
    ...(typeof req.headers['x-auth-type'] === 'string'
      ? { xAuthType: req.headers['x-auth-type'] }
      : {}),
    ...(typeof req.headers['x-room-id'] === 'string'
      ? { xRoomId: req.headers['x-room-id'] }
      : {}),
    ...(typeof req.headers['x-oracle-entity-did'] === 'string'
      ? { xOracleEntityDid: req.headers['x-oracle-entity-did'] }
      : {}),
  };
}

const MAX_CHUNK_BYTES = 16_384;
const MAX_CHUNKS = 64;
/** The engine's cap on the chunks of one document, in total UTF-8 bytes. */
const MAX_DOCUMENT_BYTES = 900_000;
/** `ingesting` turns `ready` this long after a write. */
const INGEST_MS = 400;
/** A deleted document stays `deleting` this long, then is gone. */
const DELETE_MS = 800;

/** The oracle's domain entity DID: `did:ixo:entity:` and 32 lowercase hex digits. */
const ENTITY_DID_PATTERN = /^did:ixo:entity:[0-9a-f]{32}$/;

const documentBodySchema = z.object({
  knowledge_space_type: z.enum(['public', 'private']),
  confirmed_insertion_from_user: z.boolean(),
  document: z
    .object({
      id: z
        .string()
        .regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,119}$/)
        .optional(),
      title: z.string().min(1).max(200),
      source_description: z.string().max(500).optional(),
    })
    .optional(),
  if_exists: z.enum(['replace', 'fail']).optional(),
  chunks: z
    .array(
      z.object({
        label: z.string().max(120).optional(),
        content: z.string().min(1),
      }),
    )
    .min(1)
    .max(MAX_CHUNKS),
});

function sendJson(
  res: ServerResponse,
  status: number,
  body: unknown,
  headers: Record<string, string> = {},
): void {
  res.writeHead(status, { 'content-type': 'application/json', ...headers });
  res.end(JSON.stringify(body));
}

/** Advance the background work: ingestion completes, deletions finish. */
function settle(state: MockMcpState, now: number): void {
  state.documents = state.documents.filter(
    (d) => d.removeAtMs === undefined || d.removeAtMs > now,
  );
  for (const d of state.documents) {
    if (d.status === 'ingesting' && now - d.createdAtMs >= INGEST_MS) {
      d.status = 'ready';
    }
  }
}

function summaryOf(doc: MockDocument) {
  return {
    id: doc.id,
    title: doc.title,
    source_description: doc.source_description,
    generation: doc.generation,
    chunk_count: doc.chunks.length,
    chunks_indexed: doc.status === 'ingesting' ? 0 : doc.chunks.length,
    status: doc.status,
    created_by: 'mock',
    created_at: '2026-01-01T00:00:00Z',
    updated_at: '2026-01-01T00:00:00Z',
  };
}

/** The Memory Engine's document routes, backed by `state`. */
async function handleDocuments(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  state: MockMcpState,
): Promise<void> {
  const raw: Buffer[] = [];
  for await (const chunk of req) raw.push(chunk as Buffer);
  const text = Buffer.concat(raw).toString('utf8');
  const method = req.method ?? 'GET';
  let body: unknown;
  try {
    body = text ? JSON.parse(text) : undefined;
  } catch {
    body = undefined;
    state.documentRequests.push({
      method,
      pathname: url.pathname,
      search: url.search,
      ...recordedHeaders(req),
    });
    sendJson(res, 400, { detail: 'body is not JSON', code: 'INVALID_JSON' });
    return;
  }
  const entityDid = req.headers['x-oracle-entity-did'];
  state.documentRequests.push({
    method,
    pathname: url.pathname,
    search: url.search,
    ...recordedHeaders(req),
    ...(typeof entityDid === 'string' ? { xOracleEntityDid: entityDid } : {}),
    ...(body === undefined ? {} : { body }),
  });

  if (req.headers['x-auth-type'] !== 'ucan' || !req.headers.authorization) {
    sendJson(res, 401, { detail: 'UCAN required', code: 'UNAUTHORIZED' });
    return;
  }
  if (typeof entityDid !== 'string' || entityDid.length === 0) {
    sendJson(res, 400, {
      detail: 'x-oracle-entity-did is required',
      code: 'ENTITY_HEADER_MISSING',
    });
    return;
  }
  if (!ENTITY_DID_PATTERN.test(entityDid)) {
    sendJson(res, 400, {
      detail: 'x-oracle-entity-did is not a domain entity DID',
      code: 'ENTITY_HEADER_INVALID',
    });
    return;
  }
  const roomId = req.headers['x-room-id'];
  if (typeof roomId !== 'string' || roomId.length === 0) {
    sendJson(res, 400, {
      detail: 'x-room-id is required',
      code: 'ROOM_ID_MISSING',
    });
    return;
  }
  settle(state, Date.now());

  const space = url.searchParams.get('knowledge_space_type');
  const id = decodeURIComponent(
    url.pathname.slice('/knowledge/documents'.length).replace(/^\//, ''),
  );

  if (method === 'POST' && id === '') {
    const parsed = documentBodySchema.safeParse(body);
    if (!parsed.success) {
      sendJson(res, 422, { detail: parsed.error.issues, code: 'VALIDATION' });
      return;
    }
    const request = parsed.data;
    if (request.confirmed_insertion_from_user !== true) {
      sendJson(res, 403, {
        detail: 'confirmation required',
        code: 'CONFIRMATION_REQUIRED',
      });
      return;
    }
    if (
      request.chunks.some(
        (c) => Buffer.byteLength(c.content, 'utf8') > MAX_CHUNK_BYTES,
      )
    ) {
      sendJson(res, 413, {
        detail: 'chunk too large',
        code: 'EPISODE_TOO_LARGE',
      });
      return;
    }
    const totalBytes = request.chunks.reduce(
      (sum, c) => sum + Buffer.byteLength(c.content, 'utf8'),
      0,
    );
    if (totalBytes > MAX_DOCUMENT_BYTES) {
      sendJson(res, 413, {
        detail: `chunks total ${totalBytes} bytes; the cap is ${MAX_DOCUMENT_BYTES}`,
        code: 'DOCUMENT_TOO_LARGE',
      });
      return;
    }
    if (!request.document) {
      const stored = request.chunks.map((c, i) => ({
        ...c,
        id: `loose-${state.looseChunks.length + i + 1}`,
        space: request.knowledge_space_type,
      }));
      state.looseChunks.push(...stored);
      sendJson(res, 202, {
        success: true,
        queued: stored.length,
        chunk_ids: stored.map((c) => c.id),
      });
      return;
    }
    const docId = request.document.id ?? `doc-${state.documents.length + 1}`;
    const existing = state.documents.find(
      (d) => d.id === docId && d.space === request.knowledge_space_type,
    );
    if (existing && request.if_exists === 'fail') {
      sendJson(res, 409, { detail: 'exists', code: 'DOCUMENT_EXISTS' });
      return;
    }
    const doc: MockDocument = {
      id: docId,
      space: request.knowledge_space_type,
      title: request.document.title,
      source_description: request.document.source_description ?? null,
      generation: (existing?.generation ?? 0) + 1,
      chunks: request.chunks,
      status: 'ingesting',
      createdAtMs: Date.now(),
    };
    state.documents = [...state.documents.filter((d) => d !== existing), doc];
    sendJson(res, 202, {
      success: true,
      document: {
        id: doc.id,
        generation: doc.generation,
        chunk_count: doc.chunks.length,
        status: 'ingesting',
        replaced: existing !== undefined,
      },
      queued: doc.chunks.length,
    });
    return;
  }

  if (space !== 'public' && space !== 'private') {
    sendJson(res, 422, { detail: 'knowledge_space_type', code: 'VALIDATION' });
    return;
  }
  if (method === 'GET' && id === '') {
    sendJson(res, 200, {
      documents: state.documents
        .filter((d) => d.space === space)
        .map(summaryOf),
    });
    return;
  }
  const doc = state.documents.find((d) => d.id === id && d.space === space);
  if (!doc) {
    sendJson(res, 404, {
      detail: 'no such document',
      code: 'DOCUMENT_NOT_FOUND',
    });
    return;
  }
  if (method === 'GET') {
    sendJson(res, 200, { ...summaryOf(doc), chunks: doc.chunks });
    return;
  }
  if (method === 'DELETE') {
    // The engine answers at once and removes the chunks in the background;
    // a second delete while it runs is accepted and changes nothing.
    if (doc.status !== 'deleting') {
      doc.status = 'deleting';
      doc.removeAtMs = Date.now() + DELETE_MS;
      // The background removal needs no further request to finish.
      setTimeout(() => settle(state, Date.now()), DELETE_MS + 20).unref();
    }
    sendJson(res, 202, {
      success: true,
      document: { id: doc.id, status: 'deleting', chunks: doc.chunks.length },
    });
    return;
  }
  sendJson(res, 405, { detail: 'method not allowed' });
}

export async function startMockMcpServer(port: number): Promise<MockMcpServer> {
  const origin = `http://localhost:${port}`;
  // did:web for a host with a port percent-encodes the colon.
  const did = `did:web:localhost%3A${port}`;
  const state: MockMcpState = {
    requests: [],
    documentRequests: [],
    documents: [],
    looseChunks: [],
    toolCalls: [],
    memories: [],
    batchServesMemories: true,
    batchDelayMs: 0,
    historyUploads: 'accept',
    lookupReference: `LOOKUP-${randomBytes(4).toString('hex')}`,
  };

  const http: HttpServer = createServer((req, res) => {
    void (async () => {
      const url = new URL(req.url ?? '/', origin);
      if (url.pathname === '/.well-known/did.json') {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ id: did }));
        return;
      }
      if (url.pathname === '/__test/state') {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify(state));
        return;
      }
      if (url.pathname === '/__test/reset' && req.method === 'POST') {
        state.requests.length = 0;
        state.documentRequests.length = 0;
        state.documents.length = 0;
        state.looseChunks.length = 0;
        state.toolCalls.length = 0;
        state.memories.length = 0;
        state.batchServesMemories = true;
        state.batchDelayMs = 0;
        state.historyUploads = 'accept';
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ ok: true }));
        return;
      }
      if (
        url.pathname === '/knowledge/documents' ||
        url.pathname.startsWith('/knowledge/documents/')
      ) {
        await handleDocuments(req, res, url, state);
        return;
      }
      if (url.pathname === '/search-enhanced-batch') {
        if (req.method !== 'POST') {
          res.writeHead(405, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ error: 'POST only' }));
          return;
        }
        const raw: Buffer[] = [];
        for await (const chunk of req) raw.push(chunk as Buffer);
        const queries = batchQueries(
          JSON.parse(Buffer.concat(raw).toString('utf8')),
        );
        state.requests.push({
          method: req.method,
          pathname: url.pathname,
          rpcMethods: [],
          ...recordedHeaders(req),
          ...(queries
            ? {
                queryCount: queries.length,
                oracleDids: queries.map((q) => q.oracleDids),
              }
            : {}),
        });
        if (!queries) {
          res.writeHead(422, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ error: 'body needs a `queries` array' }));
          return;
        }
        const last = queries.length - 1;
        if (state.batchDelayMs > 0) {
          await new Promise((r) => setTimeout(r, state.batchDelayMs));
        }
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(
          JSON.stringify({
            results: queries.map((q, i) =>
              searchSlot(
                q,
                state.memories,
                state.batchServesMemories && (i === 0 || i === last),
              ),
            ),
          }),
        );
        return;
      }
      if (url.pathname === '/messages') {
        if (req.method !== 'POST') {
          res.writeHead(405, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ error: 'POST only' }));
          return;
        }
        const raw: Buffer[] = [];
        for await (const chunk of req) raw.push(chunk as Buffer);
        const body: unknown = JSON.parse(Buffer.concat(raw).toString('utf8'));
        const messages =
          body !== null &&
          typeof body === 'object' &&
          'messages' in body &&
          Array.isArray(body.messages)
            ? body.messages
            : undefined;
        const refused = state.historyUploads === 'refuse';
        state.requests.push({
          method: req.method,
          pathname: url.pathname,
          rpcMethods: [],
          ...recordedHeaders(req),
          ...(messages ? { messageCount: messages.length } : {}),
          ...(refused ? { refused: true } : {}),
        });
        if (refused) {
          res.writeHead(503, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ error: 'history uploads refused' }));
          return;
        }
        if (!messages) {
          res.writeHead(422, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ error: 'body needs a `messages` array' }));
          return;
        }
        res.writeHead(202, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ accepted: messages.length }));
        return;
      }
      if (url.pathname !== '/mcp') {
        res.writeHead(404, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: `no route ${url.pathname}` }));
        return;
      }
      if (req.method !== 'POST') {
        // Stateless mode: no standalone SSE stream, no sessions to delete.
        res.writeHead(405, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: 'POST only (stateless)' }));
        return;
      }
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(chunk as Buffer);
      const body: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      state.requests.push({
        method: req.method,
        pathname: url.pathname,
        rpcMethods: rpcMethodsOf(body),
        ...recordedHeaders(req),
      });
      // Stateless streamable HTTP: fresh server+transport per request, torn
      // down when the response closes (the SDK's documented stateless mode).
      const server = buildMcpServer(state);
      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: undefined,
      });
      res.on('close', () => {
        void transport.close();
        void server.close();
      });
      await server.connect(transport);
      await transport.handleRequest(req, res, body);
    })().catch((err: unknown) => {
      if (!res.headersSent)
        res.writeHead(500, { 'content-type': 'application/json' });
      res.end(
        JSON.stringify({
          error: err instanceof Error ? err.message : String(err),
        }),
      );
    });
  });

  await new Promise<void>((resolve, reject) => {
    http.once('error', reject);
    // No host: bind dual-stack so "localhost" reaches us whether the
    // oracle's resolver picks ::1 or 127.0.0.1.
    http.listen(port, () => resolve());
  });

  return {
    port,
    origin,
    mcpUrl: `${origin}/mcp`,
    did,
    state,
    stop: () =>
      new Promise<void>((resolve) => {
        http.close(() => resolve());
        // Pending SSE responses would otherwise hold the server open.
        http.closeAllConnections();
      }),
  };
}

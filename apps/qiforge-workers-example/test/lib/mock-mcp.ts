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

export interface MockMcpState {
  requests: RecordedRequest[];
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

export async function startMockMcpServer(port: number): Promise<MockMcpServer> {
  const origin = `http://localhost:${port}`;
  // did:web for a host with a port percent-encodes the colon.
  const did = `did:web:localhost%3A${port}`;
  const state: MockMcpState = {
    requests: [],
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
        state.toolCalls.length = 0;
        state.memories.length = 0;
        state.batchServesMemories = true;
        state.batchDelayMs = 0;
        state.historyUploads = 'accept';
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ ok: true }));
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

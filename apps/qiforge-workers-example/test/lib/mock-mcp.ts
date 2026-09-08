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
 * Also serves `/.well-known/did.json` (the oracle resolves the service DID
 * from the MCP URL's origin before minting), and `GET /__test/state` exposing
 * every recorded request + tool call for assertions.
 */
import { createServer, type Server as HttpServer } from 'node:http';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { z } from 'zod';

export interface RecordedRequest {
  method: string;
  /** JSON-RPC methods contained in the request body (POSTs only). */
  rpcMethods: string[];
  authorization?: string;
  xAuthType?: string;
  xRoomId?: string;
}

export interface RecordedToolCall {
  tool: string;
  args: Record<string, unknown>;
}

export interface MockMcpState {
  requests: RecordedRequest[];
  toolCalls: RecordedToolCall[];
  memories: string[];
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
          .join('\n')}`,
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

export async function startMockMcpServer(port: number): Promise<MockMcpServer> {
  const origin = `http://localhost:${port}`;
  // did:web for a host with a port percent-encodes the colon.
  const did = `did:web:localhost%3A${port}`;
  const state: MockMcpState = { requests: [], toolCalls: [], memories: [] };

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
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ ok: true }));
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
        rpcMethods: rpcMethodsOf(body),
        ...(req.headers.authorization
          ? { authorization: req.headers.authorization }
          : {}),
        ...(typeof req.headers['x-auth-type'] === 'string'
          ? { xAuthType: req.headers['x-auth-type'] }
          : {}),
        ...(typeof req.headers['x-room-id'] === 'string'
          ? { xRoomId: req.headers['x-room-id'] }
          : {}),
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

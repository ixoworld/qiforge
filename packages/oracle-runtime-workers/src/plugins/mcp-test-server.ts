import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  type CallToolResult,
  type ClientCapabilities,
  type Tool,
} from '@modelcontextprotocol/sdk/types.js';
import { CfWorkerJsonSchemaValidator } from '@modelcontextprotocol/sdk/validation/cfworker';

/**
 * Test-only: an MCP server built with `@modelcontextprotocol/sdk` 1.x, the
 * SDK the upstream servers run, answering Streamable HTTP requests in
 * process. Tests install {@link TestMcpServer.fetch} as the global `fetch`,
 * so `MCPAdapter` connects with its real transport and protocol code.
 */

export interface TestMcpTool {
  definition: Tool;
  call(args: Record<string, unknown>): Promise<CallToolResult>;
}

export interface TestMcpServer {
  /** A `fetch` that serves `url` from this server and refuses anything else. */
  fetch: typeof fetch;
  /** The JSON-RPC methods the server received, in order. */
  methods: string[];
  /** What the client declared when it initialized. */
  clientCapabilities(): ClientCapabilities | undefined;
  close(): Promise<void>;
}

function methodsOf(body: unknown): string[] {
  const messages = Array.isArray(body) ? body : [body];
  return messages.flatMap((message: unknown) =>
    typeof message === 'object' &&
    message !== null &&
    'method' in message &&
    typeof message.method === 'string'
      ? [message.method]
      : [],
  );
}

export async function serveTestMcp(
  url: string,
  tools: readonly TestMcpTool[],
): Promise<TestMcpServer> {
  // The cfworker validator: the SDK's default (Ajv) generates code, which
  // workerd refuses.
  const server = new Server(
    { name: 'test-server', version: '1.0.0' },
    {
      capabilities: { tools: {} },
      jsonSchemaValidator: new CfWorkerJsonSchemaValidator(),
    },
  );
  server.setRequestHandler(ListToolsRequestSchema, () => ({
    tools: tools.map((tool) => tool.definition),
  }));
  server.setRequestHandler(CallToolRequestSchema, (request) => {
    const tool = tools.find((t) => t.definition.name === request.params.name);
    if (!tool) throw new Error(`no tool "${request.params.name}"`);
    return tool.call(request.params.arguments ?? {});
  });
  const transport = new WebStandardStreamableHTTPServerTransport({
    sessionIdGenerator: () => crypto.randomUUID(),
    enableJsonResponse: true,
  });
  await server.connect(transport);

  const methods: string[] = [];
  const serve: typeof fetch = async (input, init) => {
    const request = new Request(input, init);
    if (request.url !== url)
      throw new TypeError(`test MCP server: unexpected fetch ${request.url}`);
    if (request.method === 'POST')
      methods.push(...methodsOf(await request.clone().json()));
    return transport.handleRequest(request);
  };
  return {
    fetch: serve,
    methods,
    clientCapabilities: () => server.getClientCapabilities(),
    close: () => server.close(),
  };
}

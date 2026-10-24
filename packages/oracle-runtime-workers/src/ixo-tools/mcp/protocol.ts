import { mcpTools } from '@ixo/agent-tools';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  SUPPORTED_PROTOCOL_VERSIONS,
  McpError,
  ErrorCode,
} from '@modelcontextprotocol/sdk/types.js';
import type { IxoToolsSurface } from '../surface';
import { runIxoOperation } from '../lifetime';
import {
  authenticateIxoMcp,
  ixoMcpAuthFailure,
  readBoundedBody,
  type IxoMcpAuthorization,
} from './auth';
import {
  isIxoMcpResource,
  ixoMcpMetadata,
  ixoMcpMetadataUrl,
  type IxoMcpConfig,
} from './config';

export type IxoMcpHandlerInput = Readonly<{
  config: IxoMcpConfig;
  secret: string | undefined;
  surfaceFor(
    authorization: IxoMcpAuthorization,
    lifetimeSignal: AbortSignal,
  ): Promise<IxoToolsSurface>;
}>;
export function withIxoMcpResponse(
  response: Response,
  request: Request,
  config: IxoMcpConfig,
): Response {
  const headers = new Headers(response.headers);
  headers.set('cache-control', 'no-store');
  headers.set('vary', 'Origin');
  headers.set('x-content-type-options', 'nosniff');
  const origin = request.headers.get('origin');
  if (
    origin &&
    config.clients.some((client) => client.origins.includes(origin))
  ) {
    headers.set('access-control-allow-origin', origin);
    headers.set(
      'access-control-expose-headers',
      'WWW-Authenticate, MCP-Protocol-Version',
    );
  }
  return new Response(response.body, { status: response.status, headers });
}
function failure(status: number, error: string): Response {
  return Response.json({ error }, { status });
}
export function handleIxoMcpMetadata(
  request: Request,
  config: IxoMcpConfig,
): Response {
  const response =
    request.method === 'GET'
      ? Response.json(ixoMcpMetadata(config))
      : failure(405, 'method_not_allowed');
  if (response.status === 405) response.headers.set('allow', 'GET');
  return withIxoMcpResponse(response, request, config);
}
export function prepareIxoMcpRequest(
  request: Request,
  config: IxoMcpConfig,
): Response | null {
  const finish = (response: Response) =>
    withIxoMcpResponse(response, request, config);
  if (!isIxoMcpResource(request, config))
    return finish(failure(404, 'not_found'));
  const origin = request.headers.get('origin');
  if (
    origin !== null &&
    !config.clients.some((client) => client.origins.includes(origin))
  )
    return finish(failure(403, 'origin_denied'));
  if (request.method === 'OPTIONS') {
    const requestedMethod = request.headers.get(
      'access-control-request-method',
    );
    const requestedHeaders =
      request.headers
        .get('access-control-request-headers')
        ?.toLowerCase()
        .split(',')
        .map((header) => header.trim()) ?? [];
    const allowed = [
      'authorization',
      'content-type',
      'accept',
      'mcp-protocol-version',
    ];
    if (
      !origin ||
      requestedMethod !== 'POST' ||
      requestedHeaders.some((header) => !allowed.includes(header))
    )
      return finish(failure(403, 'preflight_denied'));
    return finish(
      new Response(null, {
        status: 204,
        headers: {
          'access-control-allow-methods': 'POST',
          'access-control-allow-headers': allowed.join(', '),
        },
      }),
    );
  }
  if (request.method !== 'POST') {
    const response = failure(405, 'method_not_allowed');
    response.headers.set('allow', 'POST, OPTIONS');
    return finish(response);
  }
  if (request.headers.has('last-event-id'))
    return finish(failure(400, 'replay_unsupported'));
  if (request.headers.has('mcp-session-id'))
    return finish(failure(400, 'sessions_unsupported'));
  const version = request.headers.get('mcp-protocol-version');
  if (version !== null && !SUPPORTED_PROTOCOL_VERSIONS.includes(version))
    return finish(failure(400, 'protocol_version_unsupported'));
  if (
    request.headers.get('content-type')?.split(';')[0]?.trim() !==
    'application/json'
  )
    return finish(failure(415, 'content_type_unsupported'));
  return null;
}
export async function handleIxoMcp(
  request: Request,
  input: IxoMcpHandlerInput,
): Promise<Response> {
  const prepared = prepareIxoMcpRequest(request, input.config);
  if (prepared) return prepared;
  return withIxoMcpLifetime(request, input.config, (signal) =>
    handleAuthorizedIxoMcp(request, input, signal),
  );
}
export async function withIxoMcpLifetime(
  request: Request,
  config: IxoMcpConfig,
  work: (signal: AbortSignal) => Promise<Response>,
): Promise<Response> {
  try {
    return await runIxoOperation(request.signal, work);
  } catch (error) {
    const cancelled =
      error instanceof DOMException && error.name === 'AbortError';
    const timedOut =
      error instanceof DOMException && error.name === 'TimeoutError';
    return withIxoMcpResponse(
      failure(
        cancelled ? 499 : timedOut ? 504 : 503,
        cancelled
          ? 'request_cancelled'
          : timedOut
            ? 'request_timeout'
            : 'tools_unavailable',
      ),
      request,
      config,
    );
  }
}

async function handleAuthorizedIxoMcp(
  request: Request,
  input: IxoMcpHandlerInput,
  signal: AbortSignal,
): Promise<Response> {
  const { config } = input;
  const finish = (response: Response) =>
    withIxoMcpResponse(response, request, config);
  const auth = await authenticateIxoMcp(request, config, input.secret, signal);
  if (!auth.ok) return finish(auth.response);
  const { authorization } = auth;
  let timeout: ReturnType<typeof setTimeout> | undefined;
  const bodyController = new AbortController();
  let parsedBody: unknown;
  try {
    parsedBody = await Promise.race([
      readBoundedBody(
        request,
        65_536,
        AbortSignal.any([signal, bodyController.signal]),
      ).then((text) => JSON.parse(text)),
      new Promise<never>((_, reject) => {
        timeout = setTimeout(() => {
          bodyController.abort();
          reject(new Error('body_timeout'));
        }, 5_000);
      }),
    ]);
  } catch {
    if (!(await authorization.current()))
      return finish(ixoMcpAuthFailure(config));
    return finish(failure(400, 'invalid_request_body'));
  } finally {
    clearTimeout(timeout);
  }
  const server = new Server(
    { name: 'ixo-tools', version: '1.0.0' },
    { capabilities: { tools: {} } },
  );
  const transport = new WebStandardStreamableHTTPServerTransport({
    enableJsonResponse: true,
  });
  try {
    signal.throwIfAborted();
    const surface = await input.surfaceFor(authorization, signal);
    signal.throwIfAborted();
    server.setRequestHandler(ListToolsRequestSchema, async (call) => {
      if (call.params?.cursor !== undefined)
        throw new McpError(
          ErrorCode.InvalidParams,
          'Pagination cursor unsupported',
        );
      try {
        if (!(await authorization.current())) return { tools: [] };
        signal.throwIfAborted();
        const discovery = await surface.discover();
        signal.throwIfAborted();
        return {
          tools:
            discovery.status === 'available'
              ? mcpTools().filter((tool) => discovery.tools.includes(tool.name))
              : [],
        };
      } catch {
        return { tools: [] };
      }
    });
    server.setRequestHandler(CallToolRequestSchema, async (call) => {
      try {
        const tool = mcpTools().find(
          (entry) => entry.name === call.params.name,
        );
        signal.throwIfAborted();
        const discovery = await surface.discover();
        signal.throwIfAborted();
        if (
          !tool ||
          discovery.status !== 'available' ||
          !discovery.tools.includes(tool.name) ||
          !(await authorization.current())
        ) {
          const refusal = { status: 'unauthorized', reason: 'grant_missing' };
          return {
            content: [{ type: 'text', text: JSON.stringify(refusal) }],
            structuredContent: refusal,
            isError: true,
          };
        }
        signal.throwIfAborted();
        const result = await surface.invoke(
          tool.name,
          call.params.arguments ?? {},
        );
        signal.throwIfAborted();
        return {
          content: [{ type: 'text', text: JSON.stringify(result) }],
          structuredContent: result,
          isError: result.status !== 'available',
        };
      } catch {
        const refusal = {
          status: 'unavailable',
          reason: 'upstream_failed',
          retryable: true,
        };
        return {
          content: [{ type: 'text', text: JSON.stringify(refusal) }],
          structuredContent: refusal,
          isError: true,
        };
      }
    });
    await server.connect(transport);
    const response = await transport.handleRequest(request, { parsedBody });
    const body = response.body
      ? await readBoundedBody(response, 2_097_152, signal)
      : null;
    if (!(await authorization.current()))
      return finish(ixoMcpAuthFailure(config));
    signal.throwIfAborted();
    return finish(
      new Response(body, {
        status: response.status,
        headers: response.headers,
      }),
    );
  } catch {
    if (!(await authorization.current()))
      return finish(ixoMcpAuthFailure(config));
    return finish(failure(503, 'tools_unavailable'));
  } finally {
    void server.close().catch(() => undefined);
  }
}
export { ixoMcpMetadataUrl };

import { mcpTools } from '@ixo/agent-tools';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { LATEST_PROTOCOL_VERSION } from '@modelcontextprotocol/sdk/types.js';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  authenticateIxoMcp,
  handleIxoMcp,
  handleIxoMcpMetadata,
  ixoMcpMetadataUrl,
  parseIxoMcpConfig,
  type IxoMcpConfig,
} from '../src/ixo-tools/mcp';
import type { IxoToolsSurface } from '../src/ixo-tools/surface';

const config = parseIxoMcpConfig({
  resource: 'https://oracle.example/v1/mcp',
  issuer: 'https://auth.example',
  resourceClientId: 'resource-1',
  clients: [{ clientId: 'client-1', origins: ['https://app.example'] }],
});
const secret = 'resource-secret';
function principal() {
  const now = Math.floor(Date.now() / 1000);
  return {
    active: true,
    iss: config.issuer,
    sub: 'did:ixo:alice',
    aud: config.resource,
    client_id: 'client-1',
    gid: 'grant-1',
    gver: 'version-1',
    scope: 'ixo:tools:read',
    iat: now - 20,
    exp: now + 300,
    jti: 'token-1',
    token_type: 'Bearer',
  };
}
function request(
  body: unknown = { jsonrpc: '2.0', id: 1, method: 'tools/list' },
  headers: Record<string, string> = {},
): Request {
  return new Request(config.resource, {
    method: 'POST',
    headers: {
      authorization: 'Bearer ingress-token',
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      'mcp-protocol-version': LATEST_PROTOCOL_VERSION,
      ...headers,
    },
    body: JSON.stringify(body),
  });
}
function fixture(
  options: {
    claim?: () => unknown;
    surface?: IxoToolsSurface;
    config?: IxoMcpConfig;
  } = {},
) {
  const calls: { url: string; init: RequestInit | undefined }[] = [];
  const claim = principal();
  vi.stubGlobal(
    'fetch',
    async (input: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: String(input), init });
      return Response.json(options.claim ? options.claim() : claim);
    },
  );
  const invoke = vi.fn<IxoToolsSurface['invoke']>(async () => ({
    status: 'unavailable',
    reason: 'not_integrated',
    retryable: false,
  }));
  const surface: IxoToolsSurface = options.surface ?? {
    discover: async () => ({ status: 'available', tools: ['ixo_account_get'] }),
    invoke,
  };
  const surfaceFor = vi.fn(async () => surface);
  return {
    calls,
    invoke,
    surfaceFor,
    claim,
    run: (req = request()) =>
      handleIxoMcp(req, {
        config: options.config ?? config,
        secret,
        surfaceFor,
      }),
  };
}
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('IXO MCP operator configuration and discovery metadata', () => {
  it('defaults to shared UTC and freezes trusted client policies', () => {
    const parsed = parseIxoMcpConfig({
      ...config,
      clients: [{ clientId: 'client-1' }],
    });
    expect(parsed.clients[0]).toEqual({
      clientId: 'client-1',
      disclosure: 'shared',
      timezone: 'UTC',
      origins: [],
    });
    expect(Object.isFrozen(parsed.clients[0])).toBe(true);
    expect(ixoMcpMetadataUrl(parsed)).toBe(
      'https://oracle.example/.well-known/oauth-protected-resource/v1/mcp',
    );
    const response = handleIxoMcpMetadata(
      new Request(ixoMcpMetadataUrl(parsed)),
      parsed,
    );
    expect(response.headers.get('cache-control')).toBe('no-store');
  });
  it.each([
    { resource: 'http://oracle.example/v1/mcp' },
    { resource: 'https://oracle.example/other' },
    { resource: 'https://oracle.example/v1/mcp?x=y' },
    { issuer: 'https://auth.example/' },
    { issuer: 'https://auth.example/path' },
    { issuer: 'https://user:pass@auth.example' },
    { clients: [{ clientId: 'c' }, { clientId: 'c' }] },
    { clients: [{ clientId: 'c', timezone: 'invalid' }] },
    { clients: [{ clientId: 'c', origins: ['https://app.example/path'] }] },
    { unknown: true },
  ])('rejects unsupported trusted configuration %j', (change) => {
    expect(() => parseIxoMcpConfig({ ...config, ...change })).toThrow();
  });
});

describe('IXO MCP confidential active introspection', () => {
  it('authenticates with only the fixed backchannel and preserves the incoming body', async () => {
    const f = fixture();
    const req = request();
    const result = await authenticateIxoMcp(req, config, secret);
    expect(result.ok).toBe(true);
    expect(req.bodyUsed).toBe(false);
    expect(f.calls[0]?.url).toBe('https://auth.example/oauth/introspect');
    expect(f.calls[0]?.init?.redirect).toBe('manual');
    const headers = new Headers(f.calls[0]?.init?.headers);
    expect(headers.get('authorization')).toBe(
      `Basic ${btoa('resource-1:resource-secret')}`,
    );
    expect(f.calls[0]?.init?.body).toBe(
      'token=ingress-token&token_type_hint=access_token',
    );
    if (!result.ok) throw new Error('expected active authorization');
    expect(await result.authorization.current()).toBe(true);
    expect(f.calls).toHaveLength(2);
  });
  it.each([
    { active: false },
    { iss: 'https://other.example' },
    { aud: 'https://other.example/v1/mcp' },
    { client_id: 'unregistered' },
    { scope: 'openid' },
    { token_type: 'bearer' },
    { exp: 1 },
    { iat: 9_999_999_999 },
    { gver: 1 },
    { gver: '' },
    { sub: 'not-a-did' },
    { extra: 'secret' },
  ])(
    'denies an invalid authoritative result %j before acquiring a surface',
    async (change) => {
      const f = fixture({ claim: () => ({ ...principal(), ...change }) });
      const response = await f.run();
      expect(response.status).toBe(401);
      expect(f.surfaceFor).not.toHaveBeenCalled();
      expect(response.headers.get('www-authenticate')).toContain(
        'resource_metadata=',
      );
      expect(await response.text()).not.toContain(secret);
    },
  );
  it('denies a malformed header and missing resource secret without network I/O', async () => {
    const f = fixture();
    expect(
      (
        await authenticateIxoMcp(
          request(undefined, { authorization: 'Bearer token, other' }),
          config,
          secret,
        )
      ).ok,
    ).toBe(false);
    const result = await authenticateIxoMcp(request(), config, undefined);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected unavailable authorization');
    expect(result.response.status).toBe(503);
    expect(f.calls).toHaveLength(0);
  });
  it('requires the authenticated client own Origin policy', async () => {
    const other = parseIxoMcpConfig({
      ...config,
      clients: [
        ...config.clients,
        { clientId: 'client-2', origins: ['https://other.example'] },
      ],
    });
    const f = fixture({ config: other });
    expect(
      (await f.run(request(undefined, { origin: 'https://other.example' })))
        .status,
    ).toBe(401);
    expect(f.surfaceFor).not.toHaveBeenCalled();
  });
  it.each(['gid', 'gver', 'jti', 'client_id', 'scope', 'exp'] as const)(
    'rechecks the complete %s binding rather than active alone',
    async (key) => {
      const initial = principal();
      let value: unknown = initial;
      fixture({ claim: () => value });
      const result = await authenticateIxoMcp(request(), config, secret);
      expect(result.ok).toBe(true);
      value = {
        ...initial,
        [key]: key === 'exp' ? initial.exp + 1 : 'changed',
      };
      if (!result.ok) throw new Error('expected initial authorization');
      expect(await result.authorization.current()).toBe(false);
    },
  );
  it.each([
    () =>
      new Response(null, {
        status: 307,
        headers: { location: 'https://evil.example' },
      }),
    () =>
      new Response('not json', {
        headers: { 'content-type': 'application/json' },
      }),
    () =>
      new Response('x'.repeat(16_385), {
        headers: { 'content-type': 'application/json' },
      }),
    () => new Response('{}', { headers: { 'content-type': 'text/html' } }),
  ])(
    'fails closed on redirect or invalid backchannel bytes case %#',
    async (response) => {
      const fetcher = vi.fn(async () => response());
      vi.stubGlobal('fetch', fetcher);
      expect((await authenticateIxoMcp(request(), config, secret)).ok).toBe(
        false,
      );
      expect(fetcher).toHaveBeenCalledTimes(1);
    },
  );
  it('bounds a stalled streamed introspection body and cancels the reader', async () => {
    const cancel = vi.fn();
    vi.stubGlobal(
      'fetch',
      async () =>
        new Response(
          new ReadableStream({
            start(controller) {
              controller.enqueue(new TextEncoder().encode('{'));
            },
            cancel,
          }),
          { headers: { 'content-type': 'application/json' } },
        ),
    );
    expect((await authenticateIxoMcp(request(), config, secret)).ok).toBe(
      false,
    );
    expect(cancel).toHaveBeenCalled();
  });
});

describe('real SDK stateless JSON protocol in workerd', () => {
  it('supports an official SDK client lifecycle over the request-local server', async () => {
    const f = fixture();
    const client = new Client({ name: 'ixo-protocol-test', version: '1' });
    const transport = new StreamableHTTPClientTransport(
      new URL(config.resource),
      {
        requestInit: { headers: { authorization: 'Bearer ingress-token' } },
        fetch: async (input, init) => f.run(new Request(input, init)),
      },
    );
    try {
      await client.connect(transport);
      const listed = await client.listTools();
      expect(listed.tools.map((tool) => tool.name)).toEqual([
        'ixo_account_get',
      ]);
      const called = await client.callTool({
        name: 'ixo_account_get',
        arguments: {},
      });
      expect(called).toMatchObject({
        isError: true,
        structuredContent: { reason: 'not_integrated' },
      });
    } finally {
      await client.close();
    }
  });
  it('negotiates initialize through the SDK without creating a transport session', async () => {
    const f = fixture();
    const response = await f.run(
      request({
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: {
          protocolVersion: 'unrecognized',
          capabilities: {},
          clientInfo: { name: 'test', version: '1' },
        },
      }),
    );
    expect(response.status).toBe(200);
    expect(response.headers.get('mcp-session-id')).toBeNull();
    expect(await response.json()).toMatchObject({
      result: {
        protocolVersion: LATEST_PROTOCOL_VERSION,
        capabilities: { tools: {} },
      },
    });
    expect(f.calls).toHaveLength(2);
  });
  it('accepts initialized notifications with 202 and no response body', async () => {
    const f = fixture();
    const response = await f.run(
      request({ jsonrpc: '2.0', method: 'notifications/initialized' }),
    );
    expect(response.status).toBe(202);
    expect(await response.text()).toBe('');
    expect(f.calls).toHaveLength(2);
  });
  it('lists only current native descriptors without widening their schemas', async () => {
    const f = fixture();
    const response = await f.run();
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      result: {
        tools: mcpTools().filter((tool) => tool.name === 'ixo_account_get'),
      },
    });
    expect(f.calls).toHaveLength(3);
  });
  it('returns typed shared-handler refusals through structuredContent and text', async () => {
    const f = fixture();
    const response = await f.run(
      request({
        jsonrpc: '2.0',
        id: 2,
        method: 'tools/call',
        params: { name: 'ixo_account_get', arguments: {} },
      }),
    );
    expect(await response.json()).toMatchObject({
      result: {
        isError: true,
        structuredContent: { status: 'unavailable', reason: 'not_integrated' },
      },
    });
    expect(f.invoke).toHaveBeenCalledWith('ixo_account_get', {});
  });
  it('refuses an undiscovered tool without invocation', async () => {
    const f = fixture();
    const response = await f.run(
      request({
        jsonrpc: '2.0',
        id: 2,
        method: 'tools/call',
        params: { name: 'ixo_credits_get', arguments: {} },
      }),
    );
    expect(await response.json()).toMatchObject({
      result: { isError: true, structuredContent: { status: 'unauthorized' } },
    });
    expect(f.invoke).not.toHaveBeenCalled();
  });
  it('drops a completed result when authority is revoked during execution', async () => {
    let active = true;
    const f = fixture({
      claim: () => (active ? principal() : { active: false }),
      surface: {
        discover: async () => ({
          status: 'available',
          tools: ['ixo_account_get'],
        }),
        invoke: async () => {
          active = false;
          return {
            status: 'unavailable',
            reason: 'not_integrated',
            retryable: false,
          };
        },
      },
    });
    const response = await f.run(
      request({
        jsonrpc: '2.0',
        id: 2,
        method: 'tools/call',
        params: { name: 'ixo_account_get' },
      }),
    );
    expect(response.status).toBe(401);
    expect(await response.text()).not.toContain('not_integrated');
  });
  it('drops initialization when the final current check fails', async () => {
    let count = 0;
    const f = fixture({
      claim: () => (++count === 1 ? principal() : { active: false }),
    });
    const response = await f.run(
      request({
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: {
          protocolVersion: LATEST_PROTOCOL_VERSION,
          capabilities: {},
          clientInfo: { name: 'test', version: '1' },
        },
      }),
    );
    expect(response.status).toBe(401);
  });
  it.each([
    ['mcp-session-id', 'other-client-session', 400],
    ['mcp-protocol-version', 'bad', 400],
    ['origin', 'https://evil.example', 403],
    ['content-type', 'text/plain', 415],
  ] as const)(
    'rejects unsupported %s before authentication or native I/O',
    async (header, value, status) => {
      const f = fixture();
      const response = await f.run(request(undefined, { [header]: value }));
      expect(response.status).toBe(status);
      expect(f.calls).toHaveLength(0);
      expect(f.surfaceFor).not.toHaveBeenCalled();
    },
  );
  it('handles explicit browser preflight without minting or authenticating', async () => {
    const f = fixture();
    const response = await f.run(
      new Request(config.resource, {
        method: 'OPTIONS',
        headers: {
          origin: 'https://app.example',
          'access-control-request-method': 'POST',
          'access-control-request-headers':
            'authorization, content-type, mcp-protocol-version',
        },
      }),
    );
    expect(response.status).toBe(204);
    expect(response.headers.get('access-control-allow-origin')).toBe(
      'https://app.example',
    );
    expect(f.calls).toHaveLength(0);
  });
  it.each(['GET', 'DELETE', 'PATCH'])(
    'rejects %s and advertises only the supported methods',
    async (method) => {
      const f = fixture();
      const response = await f.run(new Request(config.resource, { method }));
      expect(response.status).toBe(405);
      expect(response.headers.get('allow')).toBe('POST, OPTIONS');
    },
  );
  it('bounds the inbound JSON body', async () => {
    const f = fixture();
    const response = await f.run(request({ huge: 'x'.repeat(65_536) }));
    expect(response.status).toBe(400);
    expect(f.surfaceFor).not.toHaveBeenCalled();
  });
  it('sanitizes handler exceptions before the SDK serializes them', async () => {
    const f = fixture();
    f.invoke.mockRejectedValue(new Error(`upstream ingress-token ${secret}`));
    const response = await f.run(
      request({
        jsonrpc: '2.0',
        id: 2,
        method: 'tools/call',
        params: { name: 'ixo_account_get' },
      }),
    );
    const body = await response.text();
    expect(response.status).toBe(200);
    expect(body).toContain('upstream_failed');
    expect(body).not.toContain(secret);
    expect(body).not.toContain('ingress-token');
  });
  it('does not leak internal errors or credentials through protocol failures', async () => {
    const f = fixture();
    f.surfaceFor.mockRejectedValue(new Error(`Bearer ingress-token ${secret}`));
    const response = await f.run();
    expect(response.status).toBe(503);
    expect(await response.text()).toBe('{"error":"tools_unavailable"}');
  });
});

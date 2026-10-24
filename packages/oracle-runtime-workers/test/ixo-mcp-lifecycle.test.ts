import { SUPPORTED_PROTOCOL_VERSIONS } from '@modelcontextprotocol/sdk/types.js';
import { IXO_TOOLS_TIMEOUT_MS } from '../src/ixo-tools/lifetime';
import type { IxoToolsSurface } from '../src/ixo-tools/surface';
import type { IxoMcpHandlerInput } from '../src/ixo-tools/mcp';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { handleIxoMcp, parseIxoMcpConfig } from '../src/ixo-tools/mcp';

const config = parseIxoMcpConfig({
  resource: 'https://oracle.example/v1/mcp',
  issuer: 'https://auth.example',
  resourceClientId: 'resource',
  clients: [{ clientId: 'client' }],
});
function fixture() {
  const now = Math.floor(Date.now() / 1000);
  const introspect = vi.fn(async () => {
    return Response.json({
      active: true,
      iss: config.issuer,
      sub: 'did:ixo:alice',
      aud: config.resource,
      client_id: 'client',
      gid: 'grant',
      gver: 'generation',
      scope: 'ixo:tools:read',
      iat: now - 1,
      exp: now + 300,
      jti: 'token',
      token_type: 'Bearer',
    });
  });
  vi.stubGlobal('fetch', introspect);
  const discover = vi.fn<IxoToolsSurface['discover']>(async () => ({
    status: 'available' as const,
    tools: [],
  }));
  const invoke = vi.fn<IxoToolsSurface['invoke']>(async () => ({
    status: 'unavailable' as const,
    reason: 'not_integrated' as const,
    retryable: false,
  }));
  const surfaceFor = vi.fn<IxoMcpHandlerInput['surfaceFor']>(async () => ({
    discover,
    invoke,
  }));
  return {
    introspect,
    discover,
    invoke,
    surfaceFor,
    run: (request: Request) =>
      handleIxoMcp(request, { config, secret: 'test-secret', surfaceFor }),
  };
}
function list(params: unknown = {}, signal?: AbortSignal) {
  return new Request(config.resource, {
    method: 'POST',
    signal,
    headers: {
      authorization: 'Bearer token',
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
    },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/list',
      params,
    }),
  });
}
afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});
describe('IXO MCP lifecycle', () => {
  it.each(['', 'stale-client-page'])(
    'refuses unsupported cursor %j instead of restarting the catalog',
    async (cursor) => {
      const f = fixture();
      const response = await f.run(list({ cursor }));
      expect(await response.json()).toMatchObject({ error: { code: -32602 } });
      expect(f.discover).not.toHaveBeenCalled();
    },
  );
  it('does no authorization or tool work for an already aborted request', async () => {
    const f = fixture();
    const controller = new AbortController();
    controller.abort();
    const response = await f.run(list({}, controller.signal));
    expect(response.status).toBe(499);
    expect(f.introspect).not.toHaveBeenCalled();
    expect(f.discover).not.toHaveBeenCalled();
  });
});

function rpc(
  body: unknown,
  signal?: AbortSignal,
  headers: Record<string, string> = {},
) {
  const request = list({}, signal);
  return new Request(request.url, {
    method: 'POST',
    signal,
    headers: { ...Object.fromEntries(request.headers), ...headers },
    body: JSON.stringify(body),
  });
}
function deferred<T>() {
  let resolve: (value: T) => void = () => undefined;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
describe('IXO MCP bounded requests and stateless recovery', () => {
  it('withholds a result when the observed HTTP request aborts during a read', async () => {
    const f = fixture();
    const started = deferred<void>();
    const held = deferred<void>();
    f.discover.mockResolvedValue({
      status: 'available',
      tools: ['ixo_account_get'],
    });
    f.invoke.mockImplementation(async () => {
      started.resolve();
      await held.promise;
      return {
        status: 'unavailable',
        reason: 'not_integrated',
        retryable: false,
      };
    });
    const controller = new AbortController();
    const result = f.run(
      rpc(
        {
          jsonrpc: '2.0',
          id: 7,
          method: 'tools/call',
          params: { name: 'ixo_account_get' },
        },
        controller.signal,
      ),
    );
    await started.promise;
    controller.abort('private user reason');
    const response = await result;
    expect(response.status).toBe(499);
    expect(await response.text()).toBe('{"error":"request_cancelled"}');
    expect(response.headers.get('cache-control')).toBe('no-store');
    held.resolve();
    expect((await f.run(list())).status).toBe(200);
  });
  it('bounds a stalled surface factory and prevents its late discovery', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const f = fixture();
    const entered = deferred<void>();
    const held = deferred<IxoToolsSurface>();
    f.surfaceFor.mockImplementation(async () => {
      entered.resolve();
      return held.promise;
    });
    const response = f.run(list());
    await entered.promise;
    await vi.advanceTimersByTimeAsync(IXO_TOOLS_TIMEOUT_MS);
    expect((await response).status).toBe(504);
    expect(await (await response).text()).toBe('{"error":"request_timeout"}');
    held.resolve({ discover: f.discover, invoke: f.invoke });
    await Promise.resolve();
    await Promise.resolve();
    expect(f.discover).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });
  it('keeps a cancelled request isolated from a concurrent request with the same RPC ID', async () => {
    const f = fixture();
    const firstEntered = deferred<void>();
    const held = deferred<IxoToolsSurface>();
    f.surfaceFor.mockImplementationOnce(async () => {
      firstEntered.resolve();
      return held.promise;
    });
    const controller = new AbortController();
    const first = f.run(list({}, controller.signal));
    await firstEntered.promise;
    const second = await f.run(list());
    controller.abort();
    expect(second.status).toBe(200);
    expect((await first).status).toBe(499);
    held.resolve({ discover: f.discover, invoke: f.invoke });
  });
  it('accepts an unmatched cancellation notification without cancelling another POST', async () => {
    const f = fixture();
    const entered = deferred<void>();
    const held = deferred<void>();
    f.discover.mockResolvedValue({
      status: 'available',
      tools: ['ixo_account_get'],
    });
    f.invoke.mockImplementation(async () => {
      entered.resolve();
      await held.promise;
      return {
        status: 'unavailable',
        reason: 'not_integrated',
        retryable: false,
      };
    });
    const first = f.run(
      rpc({
        jsonrpc: '2.0',
        id: 99,
        method: 'tools/call',
        params: { name: 'ixo_account_get' },
      }),
    );
    await entered.promise;
    const notification = await f.run(
      rpc({
        jsonrpc: '2.0',
        method: 'notifications/cancelled',
        params: { requestId: 99, reason: 'cancel' },
      }),
    );
    expect(notification.status).toBe(202);
    expect(await notification.text()).toBe('');
    held.resolve();
    expect((await first).status).toBe(200);
    expect((await f.run(list())).status).toBe(200);
  });
  it.each(SUPPORTED_PROTOCOL_VERSIONS)(
    'negotiates the actual advertised protocol %s',
    async (version) => {
      const f = fixture();
      const response = await f.run(
        rpc(
          {
            jsonrpc: '2.0',
            id: 3,
            method: 'initialize',
            params: {
              protocolVersion: version,
              capabilities: {},
              clientInfo: { name: 'raw-version-probe', version: '1' },
            },
          },
          undefined,
          { 'mcp-protocol-version': version },
        ),
      );
      expect(await response.json()).toMatchObject({
        result: { protocolVersion: version },
      });
      expect(response.headers.get('mcp-session-id')).toBeNull();
      const listing = await f.run(
        rpc({ jsonrpc: '2.0', id: 4, method: 'tools/list' }, undefined, {
          'mcp-protocol-version': version,
        }),
      );
      expect(await listing.json()).toMatchObject({ result: { tools: [] } });
    },
  );
  it.each([
    ['mcp-session-id', 'stale-session'],
    ['last-event-id', 'stale-event'],
  ])('refuses stale %s state before authorization', async (header, value) => {
    const f = fixture();
    const response = await f.run(
      rpc({ jsonrpc: '2.0', id: 4, method: 'tools/list' }, undefined, {
        [header]: value,
      }),
    );
    expect(response.status).toBe(400);
    expect(f.introspect).not.toHaveBeenCalled();
    expect(f.discover).not.toHaveBeenCalled();
  });
});

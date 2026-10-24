import type * as ShellApp from '../src/shell/app';
import { createExecutionContext } from 'cloudflare:test';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { OracleWorkerEnv } from '../src/do/contracts';
import { IXO_TOOLS_TIMEOUT_MS } from '../src/ixo-tools/lifetime';

const owner = vi.hoisted(() => ({
  call: vi.fn<(request: Request) => Promise<Response>>(),
  select: vi.fn(),
}));
vi.mock('../src/shell/app', async (importOriginal) => {
  const actual = await importOriginal<typeof ShellApp>();
  return {
    ...actual,
    userStub: (...args: unknown[]) => {
      owner.select(...args);
      return { handleIxoMcp: owner.call };
    },
  };
});
import { createOracleWorker } from '../src';
const resource = 'https://mcp.test/v1/mcp';
const worker = createOracleWorker({
  config: { name: 'MCP test' },
  plugins: [],
  ixoToolsMcp: {
    resource,
    issuer: 'https://auth.test',
    resourceClientId: 'resource',
    clients: [{ clientId: 'client' }],
  },
});
const unused = (): never => {
  throw new Error('Unexpected namespace access');
};
const namespace = {
  newUniqueId: unused,
  idFromName: unused,
  idFromString: unused,
  get: unused,
  getByName: unused,
  getExisting: unused,
  jurisdiction: unused,
};
const environment = {
  ORACLE_NAME: 'MCP test',
  BLOCKSYNC_GRAPHQL_URL: 'https://indexer.test/graphql',
  MATRIX_BASE_URL: 'https://matrix.test',
  MATRIX_ORACLE_ADMIN_USER_ID: '@oracle:matrix.test',
  MATRIX_ORACLE_ADMIN_PASSWORD: 'unused',
  OPEN_ROUTER_API_KEY: 'unused',
  USER_ORACLE: namespace,
  MATRIX_GATEWAY: namespace,
  ORACLE_DID: 'did:ixo:oracle',
  IXO_MCP_RESOURCE_CLIENT_SECRET: 'secret',
} satisfies OracleWorkerEnv;
function request() {
  return new Request(resource, {
    method: 'POST',
    headers: {
      authorization: 'Bearer token',
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
    },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
  });
}
function deferred<T>() {
  let resolve: (value: T) => void = () => undefined;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
let active = true;
beforeEach(() => {
  active = true;
  owner.call.mockReset();
  owner.select.mockReset();
  const now = Math.floor(Date.now() / 1000);
  vi.stubGlobal('fetch', async () =>
    Response.json(
      active
        ? {
            active: true,
            iss: 'https://auth.test',
            sub: 'did:ixo:alice',
            aud: resource,
            client_id: 'client',
            gid: 'grant',
            gver: 'generation',
            scope: 'ixo:tools:read',
            iat: now - 1,
            exp: now + 300,
            jti: 'token',
            token_type: 'Bearer',
          }
        : { active: false },
    ),
  );
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});
describe('IXO real Worker entry with controlled owner RPC', () => {
  it('bounds a held owner call and forwards an aborted request lifetime', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const entered = deferred<AbortSignal>();
    const held = deferred<Response>();
    owner.call.mockImplementation(async (req) => {
      entered.resolve(req.signal);
      return held.promise;
    });
    const response = worker.fetch(
      request(),
      environment,
      createExecutionContext(),
    );
    const signal = await entered.promise;
    await vi.advanceTimersByTimeAsync(IXO_TOOLS_TIMEOUT_MS);
    expect(signal.aborted).toBe(true);
    expect((await response).status).toBe(504);
    expect(await (await response).text()).toBe('{"error":"request_timeout"}');
    held.resolve(Response.json({ privateValue: 'late owner response' }));
    expect(owner.select).toHaveBeenCalledWith(environment, 'did:ixo:alice');
    expect(vi.getTimerCount()).toBe(0);
  });
  it('withholds a completed owner response when OAuth is revoked before Worker disclosure', async () => {
    owner.call.mockImplementation(async () => {
      active = false;
      return Response.json({ privateValue: 'must remain hidden' });
    });
    const response = await worker.fetch(
      request(),
      environment,
      createExecutionContext(),
    );
    expect(response.status).toBe(401);
    expect(await response.text()).not.toContain('privateValue');
    expect(response.headers.get('cache-control')).toBe('no-store');
  });
  it('cancels a stalled owner response reader at the outer deadline', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const entered = deferred<void>();
    const cancel = vi.fn();
    owner.call.mockResolvedValue(
      new Response(
        new ReadableStream({
          pull() {
            entered.resolve();
          },
          cancel,
        }),
      ),
    );
    const response = worker.fetch(
      request(),
      environment,
      createExecutionContext(),
    );
    await entered.promise;
    await vi.advanceTimersByTimeAsync(IXO_TOOLS_TIMEOUT_MS);
    expect((await response).status).toBe(504);
    expect(cancel).toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });
});

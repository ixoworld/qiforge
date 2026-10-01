import { afterEach, describe, expect, it, vi } from 'vitest';
import { BYO_SECRET_NAMES } from './byo-catalog';
import { handleByoRequest } from './byo-routes';
import {
  WorkersByoService,
  type ByoSecretsBackend,
  type ByoStateStore,
} from './byo-service';

const ROOM = '!oracle-room:server';
const DID = 'did:ixo:ixo1user';

function makeSecrets(): ByoSecretsBackend & { values: Map<string, string> } {
  const values = new Map<string, string>();
  return {
    values,
    async getIndex() {
      return [...values.keys()].map((name) => ({ name, eventId: `$${name}` }));
    },
    async getValues(_roomId, names) {
      const out: Record<string, string> = {};
      for (const name of names) {
        const v = values.get(name);
        if (v !== undefined) out[name] = v;
      }
      return out;
    },
    async putSecret(_roomId, name, value) {
      values.set(name, value);
    },
    async deleteSecret(_roomId, name) {
      values.delete(name);
    },
  };
}

function makeStore(): ByoStateStore {
  const map = new Map<string, string>();
  return {
    async get(key) {
      return map.get(key);
    },
    async put(key, value) {
      map.set(key, value);
    },
    async delete(key) {
      map.delete(key);
    },
  };
}

function makeService(
  secrets: ByoSecretsBackend,
  enabled = true,
): WorkersByoService {
  return new WorkersByoService({
    enabled,
    secrets,
    resolveRoomId: async () => ROOM,
    store: makeStore(),
  });
}

function req(method: string, path: string, body?: unknown): Request {
  return new Request(`https://user-oracle${path}`, {
    method,
    ...(body !== undefined
      ? {
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(body),
        }
      : {}),
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('handleByoRequest', () => {
  it('GET /byo-llm/status reports enabled:false (200) when BYO is off', async () => {
    const res = await handleByoRequest(
      makeService(makeSecrets(), false),
      DID,
      req('GET', '/byo-llm/status'),
    );
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({
      enabled: false,
      providers: [],
    });
  });

  it('404s every non-status route when BYO is off', async () => {
    const service = makeService(makeSecrets(), false);
    const res = await handleByoRequest(
      service,
      DID,
      req('GET', '/byo-llm/chatgpt/authorize-url'),
    );
    expect(res.status).toBe(404);
    const body = (await res.json()) as { statusCode: number; message: string };
    expect(body.statusCode).toBe(404);
    expect(body.message).toMatch(/not enabled/);
  });

  it('GET /byo-llm/status lists per-provider connections', async () => {
    const secrets = makeSecrets();
    secrets.values.set(BYO_SECRET_NAMES.openai, 'sk-user');
    const res = await handleByoRequest(
      makeService(secrets),
      DID,
      req('GET', '/byo-llm/status'),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      enabled: boolean;
      providers: Array<{ provider: string; connected: boolean }>;
    };
    expect(body.enabled).toBe(true);
    expect(body.providers.find((p) => p.provider === 'openai')?.connected).toBe(
      true,
    );
    expect(
      body.providers.find((p) => p.provider === 'chatgpt')?.connected,
    ).toBe(false);
  });

  it('PUT + DELETE /byo-llm/credentials/:provider store and remove keys', async () => {
    const secrets = makeSecrets();
    const service = makeService(secrets);

    const put = await handleByoRequest(
      service,
      DID,
      req('PUT', '/byo-llm/credentials/gemini', { apiKey: '  sk-gem  ' }),
    );
    expect(put.status).toBe(200);
    await expect(put.json()).resolves.toEqual({ ok: true, provider: 'gemini' });
    expect(secrets.values.get(BYO_SECRET_NAMES.gemini)).toBe('sk-gem');

    const del = await handleByoRequest(
      service,
      DID,
      req('DELETE', '/byo-llm/credentials/gemini'),
    );
    expect(del.status).toBe(200);
    expect(secrets.values.has(BYO_SECRET_NAMES.gemini)).toBe(false);
  });

  it('rejects bad credential writes', async () => {
    const service = makeService(makeSecrets());
    expect(
      (
        await handleByoRequest(
          service,
          DID,
          req('PUT', '/byo-llm/credentials/chatgpt', { apiKey: 'x' }),
        )
      ).status,
    ).toBe(400);
    expect(
      (
        await handleByoRequest(
          service,
          DID,
          req('PUT', '/byo-llm/credentials/gemini', { apiKey: '   ' }),
        )
      ).status,
    ).toBe(400);
    expect(
      (
        await handleByoRequest(
          service,
          DID,
          req('PUT', '/byo-llm/credentials/mistral', { apiKey: 'x' }),
        )
      ).status,
    ).toBe(400);
  });

  it('POST /byo-llm/validate/:provider live-checks with fetch mocked', async () => {
    const secrets = makeSecrets();
    secrets.values.set(BYO_SECRET_NAMES.deepseek, 'sk-ds');
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL) => {
        expect(String(input)).toBe('https://api.deepseek.com/v1/models');
        return Response.json({ data: [] });
      }),
    );
    const res = await handleByoRequest(
      makeService(secrets),
      DID,
      req('POST', '/byo-llm/validate/deepseek'),
    );
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({ valid: true });
  });

  it('GET /byo-llm/chatgpt/authorize-url mints a PKCE pair and state', async () => {
    const res = await handleByoRequest(
      makeService(makeSecrets()),
      DID,
      req('GET', '/byo-llm/chatgpt/authorize-url'),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      url: string;
      codeVerifier: string;
      state: string;
    };
    const url = new URL(body.url);
    expect(url.origin).toBe('https://auth.openai.com');
    expect(url.searchParams.get('code_challenge_method')).toBe('S256');
    expect(url.searchParams.get('state')).toBe(body.state);
    expect(body.codeVerifier.length).toBeGreaterThanOrEqual(43);
  });

  it('device flow: start binds the flow to the caller; a foreign poll fails', async () => {
    const service = makeService(makeSecrets());
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL) => {
        expect(String(input)).toBe(
          'https://auth.openai.com/api/accounts/deviceauth/usercode',
        );
        return Response.json({
          device_auth_id: 'auth-123',
          user_code: 'ABCD-1234',
          interval: '5',
        });
      }),
    );
    const start = await handleByoRequest(
      service,
      DID,
      req('POST', '/byo-llm/chatgpt/device/start'),
    );
    expect(start.status).toBe(200);
    const body = (await start.json()) as {
      deviceAuthId: string;
      interval: number;
    };
    expect(body.deviceAuthId).toBe('auth-123');
    expect(body.interval).toBe(5);

    // A different authenticated user cannot complete this flow.
    const foreign = await handleByoRequest(
      service,
      'did:ixo:ixo1mallory',
      req('POST', '/byo-llm/chatgpt/device/poll', {
        deviceAuthId: 'auth-123',
        userCode: 'ABCD-1234',
      }),
    );
    await expect(foreign.json()).resolves.toMatchObject({ status: 'failed' });
  });

  it('502s when the device flow is unavailable upstream', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => Response.json({}, { status: 503 })),
    );
    const res = await handleByoRequest(
      makeService(makeSecrets()),
      DID,
      req('POST', '/byo-llm/chatgpt/device/start'),
    );
    expect(res.status).toBe(502);
  });

  it('404s unknown byo paths', async () => {
    const res = await handleByoRequest(
      makeService(makeSecrets()),
      DID,
      req('GET', '/byo-llm/nope'),
    );
    expect(res.status).toBe(404);
  });
});

import { afterEach, describe, expect, it, vi } from 'vitest';
import { BYO_SECRET_NAMES, type ChatGptOAuthTokens } from './byo-catalog';
import {
  WorkersByoService,
  type ByoSecretsBackend,
  type ByoStateStore,
} from './byo-service';

const ROOM = '!oracle-room:server';
const DID = 'did:ixo:ixo1user';

/** In-memory secrets backend mirroring WorkersSecretsService semantics. */
function makeSecrets(): ByoSecretsBackend & {
  values: Map<string, string>;
  putCalls: Array<{ name: string; value: string }>;
} {
  const values = new Map<string, string>();
  const putCalls: Array<{ name: string; value: string }> = [];
  return {
    values,
    putCalls,
    async getIndex(roomId) {
      expect(roomId).toBe(ROOM);
      return [...values.keys()].map((name) => ({ name, eventId: `$${name}` }));
    },
    async getValues(roomId, names) {
      expect(roomId).toBe(ROOM);
      const out: Record<string, string> = {};
      for (const name of names) {
        const v = values.get(name);
        if (v !== undefined) out[name] = v;
      }
      return out;
    },
    async putSecret(_roomId, name, value) {
      putCalls.push({ name, value });
      values.set(name, value);
    },
    async deleteSecret(_roomId, name) {
      values.delete(name);
    },
  };
}

function makeStore(): ByoStateStore {
  const map = new Map<string, { value: string; expiresAt?: number }>();
  return {
    async get(key) {
      const hit = map.get(key);
      if (!hit) return undefined;
      if (hit.expiresAt !== undefined && hit.expiresAt <= Date.now()) {
        map.delete(key);
        return undefined;
      }
      return hit.value;
    },
    async put(key, value, ttlMs) {
      map.set(key, {
        value,
        ...(ttlMs !== undefined ? { expiresAt: Date.now() + ttlMs } : {}),
      });
    },
    async delete(key) {
      map.delete(key);
    },
  };
}

function json404(): Response {
  return new Response('{"error":"not found"}', {
    status: 404,
    headers: { 'content-type': 'application/json' },
  });
}

function makeService(
  secrets: ByoSecretsBackend,
  opts?: { enabled?: boolean; roomId?: string | null },
): WorkersByoService {
  return new WorkersByoService({
    // Tests never touch the network: the reachability probe answers
    // "reachable" unless a test injects its own probeFetch.
    probeFetch: async () => json404(),
    enabled: opts?.enabled ?? true,
    secrets,
    resolveRoomId: async () =>
      opts?.roomId === undefined ? ROOM : opts.roomId,
    store: makeStore(),
  });
}

function freshTokens(
  overrides?: Partial<ChatGptOAuthTokens>,
): ChatGptOAuthTokens {
  return {
    accessToken: 'at-1',
    refreshToken: 'rt-1',
    accountId: 'acct',
    expiresAt: Date.now() + 3_600_000,
    ...overrides,
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('WorkersByoService', () => {
  it('is inert when disabled', async () => {
    const service = makeService(makeSecrets(), { enabled: false });
    expect(service.isEnabled()).toBe(false);
    await expect(service.getCredentials(DID)).resolves.toEqual({});
    await expect(service.hasCredentials(DID)).resolves.toBe(false);
    await expect(service.resolveForTurn({ userDid: DID })).resolves.toBeNull();
    await expect(service.status(DID)).resolves.toEqual({
      enabled: false,
      providers: [],
    });
  });

  it('reads credentials from the room secrets and caches them', async () => {
    const secrets = makeSecrets();
    secrets.values.set(BYO_SECRET_NAMES.openai, ' sk-user-key ');
    secrets.values.set('UNRELATED_SECRET', 'ignored');
    const service = makeService(secrets);

    const creds = await service.getCredentials(DID);
    expect(creds).toEqual({
      openai: { provider: 'openai', apiKey: 'sk-user-key' },
    });

    // Cached: mutating the backend does not change the next read...
    secrets.values.delete(BYO_SECRET_NAMES.openai);
    await expect(service.getCredentials(DID)).resolves.toEqual(creds);
    // ...but refresh bypasses the cache.
    await expect(
      service.getCredentials(DID, { refresh: true }),
    ).resolves.toEqual({});
  });

  it('status reports connections with picker entries', async () => {
    const secrets = makeSecrets();
    secrets.values.set(BYO_SECRET_NAMES.deepseek, 'sk-ds');
    const service = makeService(secrets);

    const status = await service.status(DID);
    expect(status.enabled).toBe(true);
    const deepseek = status.providers.find((p) => p.provider === 'deepseek')!;
    expect(deepseek.connected).toBe(true);
    expect(deepseek.models.map((m) => m.id)).toEqual([
      'byo:deepseek/deepseek-v4-flash',
      'byo:deepseek/deepseek-v4-pro',
    ]);
    expect(deepseek.defaultModelId).toBe('byo:deepseek/deepseek-v4-flash');
    const openai = status.providers.find((p) => p.provider === 'openai')!;
    expect(openai.connected).toBe(false);
    expect(openai.models).toEqual([]);
  });

  it('storeApiKey / deleteCredential write through the secrets backend', async () => {
    const secrets = makeSecrets();
    const service = makeService(secrets);

    await service.storeApiKey(DID, 'anthropic', 'sk-ant');
    expect(secrets.values.get(BYO_SECRET_NAMES.anthropic)).toBe('sk-ant');
    await expect(service.hasCredentials(DID)).resolves.toBe(true);

    await service.deleteCredential(DID, 'anthropic');
    expect(secrets.values.has(BYO_SECRET_NAMES.anthropic)).toBe(false);
    await expect(service.hasCredentials(DID)).resolves.toBe(false);
  });

  describe('resolveForTurn', () => {
    it('activates the requested byo: model when its credential is connected', async () => {
      const secrets = makeSecrets();
      secrets.values.set(BYO_SECRET_NAMES.openai, 'sk-user');
      const service = makeService(secrets);

      const turn = await service.resolveForTurn({
        userDid: DID,
        requestedModel: 'byo:openai/gpt-5.6-sol',
      });
      expect(turn).toEqual({
        provider: 'openai',
        credential: { provider: 'openai', apiKey: 'sk-user' },
        mainModelId: 'gpt-5.6-sol',
        byoModelId: 'byo:openai/gpt-5.6-sol',
      });
    });

    it('falls back with a notice when the byo: model has no credential', async () => {
      const service = makeService(makeSecrets());
      const notices: Array<Record<string, unknown>> = [];
      const turn = await service.resolveForTurn({
        userDid: DID,
        requestedModel: 'byo:openai/gpt-5.6-sol',
        onNotice: (n) => notices.push({ ...n }),
      });
      expect(turn).toBeNull();
      expect(notices).toHaveLength(1);
      expect(notices[0]).toMatchObject({
        kind: 'byo_fallback',
        reason: 'not_connected',
        provider: 'openai',
      });
    });

    it('ignores non-byo and unknown byo model ids', async () => {
      const secrets = makeSecrets();
      secrets.values.set(BYO_SECRET_NAMES.openai, 'sk-user');
      const service = makeService(secrets);
      await expect(
        service.resolveForTurn({
          userDid: DID,
          requestedModel: 'openai/gpt-5.6-sol',
        }),
      ).resolves.toBeNull();
      await expect(
        service.resolveForTurn({
          userDid: DID,
          requestedModel: 'byo:openai/unknown-model',
        }),
      ).resolves.toBeNull();
    });

    it('prefers the first connected provider when no model is requested', async () => {
      const secrets = makeSecrets();
      secrets.values.set(BYO_SECRET_NAMES.gemini, 'sk-g');
      secrets.values.set(BYO_SECRET_NAMES.deepseek, 'sk-d');
      const service = makeService(secrets);
      const turn = await service.resolveForTurn({ userDid: DID });
      // BYO_PROVIDERS order: chatgpt, openai, anthropic, gemini, deepseek.
      expect(turn?.provider).toBe('gemini');
      expect(turn?.mainModelId).toBe('gemini-3.6-flash');
      expect(turn?.byoModelId).toBe('byo:gemini/gemini-3.6-flash');
    });

    it('refreshes an expired ChatGPT token (single-flight) and writes it back', async () => {
      const secrets = makeSecrets();
      const expired = freshTokens({ expiresAt: Date.now() + 1000 }); // inside skew
      secrets.values.set(BYO_SECRET_NAMES.chatgpt, JSON.stringify(expired));
      const service = makeService(secrets);

      const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
        expect(String(input)).toBe('https://auth.openai.com/oauth/token');
        return Response.json({
          access_token: 'at-2',
          refresh_token: 'rt-2',
          expires_in: 3600,
        });
      });
      vi.stubGlobal('fetch', fetchMock);

      const [a, b] = await Promise.all([
        service.resolveForTurn({ userDid: DID }),
        service.resolveForTurn({ userDid: DID }),
      ]);
      expect(fetchMock).toHaveBeenCalledTimes(1);
      for (const turn of [a, b]) {
        expect(turn?.provider).toBe('chatgpt');
        expect(turn?.credential).toMatchObject({
          provider: 'chatgpt',
          oauth: {
            accessToken: 'at-2',
            refreshToken: 'rt-2',
            accountId: 'acct',
          },
        });
      }
      // Rotated tokens were written back to the room secret.
      const persisted = JSON.parse(
        secrets.values.get(BYO_SECRET_NAMES.chatgpt)!,
      ) as ChatGptOAuthTokens;
      expect(persisted.refreshToken).toBe('rt-2');
    });

    it('degrades with a reconnect notice on a permanent refresh failure', async () => {
      const secrets = makeSecrets();
      secrets.values.set(
        BYO_SECRET_NAMES.chatgpt,
        JSON.stringify(freshTokens({ expiresAt: Date.now() - 1 })),
      );
      const service = makeService(secrets);
      vi.stubGlobal(
        'fetch',
        vi.fn(async () =>
          Response.json(
            { error: { code: 'refresh_token_expired', message: 'expired' } },
            { status: 400 },
          ),
        ),
      );
      const notices: Array<Record<string, unknown>> = [];
      const turn = await service.resolveForTurn({
        userDid: DID,
        onNotice: (n) => notices.push({ ...n }),
      });
      expect(turn).toBeNull();
      expect(notices[0]).toMatchObject({
        reason: 'reconnect_required',
        provider: 'chatgpt',
      });
    });
  });

  describe('validate', () => {
    it('checks an API key against the provider with a live call', async () => {
      const secrets = makeSecrets();
      secrets.values.set(BYO_SECRET_NAMES.openai, 'sk-user');
      const service = makeService(secrets);

      const fetchMock = vi.fn(
        async (input: RequestInfo | URL, init?: RequestInit) => {
          expect(String(input)).toBe('https://api.openai.com/v1/models');
          const headers = init?.headers;
          expect(headers).toMatchObject({ Authorization: 'Bearer sk-user' });
          return Response.json({ data: [] });
        },
      );
      vi.stubGlobal('fetch', fetchMock);
      await expect(service.validate(DID, 'openai')).resolves.toEqual({
        valid: true,
      });

      vi.stubGlobal(
        'fetch',
        vi.fn(async () => Response.json({}, { status: 401 })),
      );
      await expect(service.validate(DID, 'openai')).resolves.toEqual({
        valid: false,
        error: 'The provider rejected this key',
      });
    });

    it('reports not-connected without a stored credential', async () => {
      const service = makeService(makeSecrets());
      await expect(service.validate(DID, 'gemini')).resolves.toEqual({
        valid: false,
        error: 'Not connected',
      });
    });
  });

  it('device-auth bindings are per-user and expire', async () => {
    const service = makeService(makeSecrets());
    await service.bindDeviceAuth(DID, 'auth-1');
    await expect(service.isDeviceAuthOwner(DID, 'auth-1')).resolves.toBe(true);
    await expect(
      service.isDeviceAuthOwner('did:ixo:ixo1mallory', 'auth-1'),
    ).resolves.toBe(false);
    await expect(service.isDeviceAuthOwner(DID, 'unknown')).resolves.toBe(
      false,
    );
  });
});

describe('WorkersByoService — ChatGPT backend reachability', () => {
  function connectedChatGpt(): ReturnType<typeof makeSecrets> {
    const secrets = makeSecrets();
    secrets.values.set(
      BYO_SECRET_NAMES.chatgpt,
      JSON.stringify({
        accessToken: 'at-1',
        refreshToken: 'rt-1',
        accountId: 'acct',
        expiresAt: Date.now() + 3_600_000,
      }),
    );
    return secrets;
  }
  const html403 = () =>
    new Response('<html>blocked</html>', {
      status: 403,
      headers: { 'content-type': 'text/html; charset=utf-8' },
    });

  it('falls back to the platform model with an "unreachable" notice when the backend answers an HTML 403, and probes once per window', async () => {
    const probeFetch = vi.fn(async () => html403());
    const service = new WorkersByoService({
      enabled: true,
      secrets: connectedChatGpt(),
      resolveRoomId: async () => ROOM,
      store: makeStore(),
      probeFetch,
    });
    const notices: Array<{ reason: string; provider?: string }> = [];
    const turn = await service.resolveForTurn({
      userDid: DID,
      onNotice: (n) => notices.push({ reason: n.reason, provider: n.provider }),
    });
    expect(turn).toBeNull();
    expect(notices).toEqual([{ reason: 'unreachable', provider: 'chatgpt' }]);
    // Second turn inside the TTL: no second probe.
    await service.resolveForTurn({ userDid: DID });
    expect(probeFetch).toHaveBeenCalledTimes(1);
  });

  it('keeps the ChatGPT turn when the backend is reachable (any non-HTML answer) or the probe itself fails', async () => {
    for (const probeFetch of [
      vi.fn(async () => json404()),
      vi.fn(async () => {
        throw new Error('dns');
      }),
    ]) {
      const service = new WorkersByoService({
        enabled: true,
        secrets: connectedChatGpt(),
        resolveRoomId: async () => ROOM,
        store: makeStore(),
        probeFetch,
      });
      const turn = await service.resolveForTurn({ userDid: DID });
      expect(turn?.provider).toBe('chatgpt');
    }
  });

  it('probes the configured backend proxy with the gate header', async () => {
    const probeFetch = vi.fn(async () => json404());
    const service = new WorkersByoService({
      enabled: true,
      secrets: connectedChatGpt(),
      resolveRoomId: async () => ROOM,
      store: makeStore(),
      probeFetch,
      chatGptBackend: {
        baseUrl: 'https://chatgpt.proxy.example',
        proxyAuthToken: 'shared-secret',
      },
    });
    const turn = await service.resolveForTurn({ userDid: DID });
    expect(turn?.provider).toBe('chatgpt');
    expect(turn?.chatGptBackend).toEqual({
      baseUrl: 'https://chatgpt.proxy.example',
      proxyAuthToken: 'shared-secret',
    });
    const [url, init] = probeFetch.mock.calls[0] as unknown as [
      string,
      { headers: Record<string, string> },
    ];
    expect(url).toBe('https://chatgpt.proxy.example/responses');
    expect(init.headers['X-Proxy-Auth']).toBe('Bearer shared-secret');
    expect(init.headers.Authorization).toMatch(/^Bearer /);
  });

  it('probes through the live global fetch when none is injected (never a captured bare global)', async () => {
    const original = globalThis.fetch;
    const service = new WorkersByoService({
      enabled: true,
      secrets: connectedChatGpt(),
      resolveRoomId: async () => ROOM,
      store: makeStore(),
    });
    // Installed AFTER construction: a captured global would never see it.
    const stub = vi.fn(async () => html403());
    globalThis.fetch = stub as unknown as typeof fetch;
    try {
      const notices: string[] = [];
      const turn = await service.resolveForTurn({
        userDid: DID,
        onNotice: (n) => notices.push(n.reason),
      });
      expect(stub).toHaveBeenCalledTimes(1);
      expect(turn).toBeNull();
      expect(notices).toEqual(['unreachable']);
    } finally {
      globalThis.fetch = original;
    }
  });
});

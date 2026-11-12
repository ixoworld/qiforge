import { describe, expect, it } from 'vitest';
import type { ByoCredential } from './byo-catalog';
import {
  CHATGPT_MODELS_CLIENT_VERSION,
  discoverAccountModels,
  parseChatGptModelList,
  parseOpenAiModelList,
  parseStoredDiscovery,
} from './byo-model-discovery';

const OPENAI: ByoCredential = { provider: 'openai', apiKey: 'sk-user' };
const CHATGPT: ByoCredential = {
  provider: 'chatgpt',
  oauth: {
    accessToken: 'at',
    refreshToken: 'rt',
    accountId: 'acct-1',
    expiresAt: Date.now() + 3_600_000,
  },
};
const BACKEND = {
  baseUrl: 'https://proxy.example/codex',
  proxyAuthToken: 'px',
};

interface Seen {
  url: string;
  headers: Headers;
}

function stub(response: () => Response | Promise<Response>): {
  fetch: typeof fetch;
  seen: Seen[];
} {
  const seen: Seen[] = [];
  return {
    seen,
    fetch: async (input, init) => {
      seen.push({
        url: String(input),
        headers: new Headers(init?.headers),
      });
      return response();
    },
  };
}

const deps = (f: typeof fetch) => ({
  fetch: f,
  chatGptBackend: BACKEND,
  timeoutMs: 1000,
});

describe('model list parsers', () => {
  it('read OpenAI ids and ChatGPT slugs, and refuse any other shape', () => {
    expect(parseOpenAiModelList({ data: [{ id: 'a' }, { id: 'b' }] })).toEqual([
      'a',
      'b',
    ]);
    expect(parseOpenAiModelList({ data: [{ id: 1 }] })).toBeNull();
    expect(parseOpenAiModelList({ models: [] })).toBeNull();
    expect(parseChatGptModelList({ models: [{ slug: 'x' }] })).toEqual(['x']);
    expect(parseChatGptModelList({ models: [{ id: 'x' }] })).toBeNull();
    expect(parseChatGptModelList([])).toBeNull();
  });
});

describe('discoverAccountModels', () => {
  it('lists an OpenAI key’s models with GET /v1/models', async () => {
    const s = stub(() => Response.json({ data: [{ id: 'gpt-5.6-luna' }] }));
    await expect(discoverAccountModels(OPENAI, deps(s.fetch))).resolves.toEqual(
      { ok: true, modelIds: ['gpt-5.6-luna'] },
    );
    expect(s.seen[0]?.url).toBe('https://api.openai.com/v1/models');
    expect(s.seen[0]?.headers.get('authorization')).toBe('Bearer sk-user');
  });

  it('lists a subscription’s models through the configured backend', async () => {
    const s = stub(() =>
      Response.json({ models: [{ slug: 'gpt-5.6-terra' }] }),
    );
    await expect(
      discoverAccountModels(CHATGPT, deps(s.fetch)),
    ).resolves.toEqual({ ok: true, modelIds: ['gpt-5.6-terra'] });
    expect(s.seen[0]?.url).toBe(
      `https://proxy.example/codex/models?client_version=${CHATGPT_MODELS_CLIENT_VERSION}`,
    );
    const h = s.seen[0]!.headers;
    expect(h.get('authorization')).toBe('Bearer at');
    expect(h.get('chatgpt-account-id')).toBe('acct-1');
    expect(h.get('x-proxy-auth')).toBe('Bearer px');
    expect(h.get('originator')).toBe('codex_cli_rs');
  });

  it('an empty list is a list, not a failure', async () => {
    const s = stub(() => Response.json({ data: [] }));
    await expect(discoverAccountModels(OPENAI, deps(s.fetch))).resolves.toEqual(
      { ok: true, modelIds: [] },
    );
  });

  it('reports why it could not list, never an empty list', async () => {
    const status = stub(() => new Response('', { status: 401 }));
    await expect(
      discoverAccountModels(OPENAI, deps(status.fetch)),
    ).resolves.toEqual({
      ok: false,
      reason: 'the model listing answered HTTP 401',
    });
    const html = stub(() => new Response('<html>', { status: 200 }));
    await expect(
      discoverAccountModels(CHATGPT, deps(html.fetch)),
    ).resolves.toEqual({ ok: false, reason: 'the model listing was not JSON' });
    const shape = stub(() => Response.json({ nope: true }));
    await expect(
      discoverAccountModels(OPENAI, deps(shape.fetch)),
    ).resolves.toEqual({
      ok: false,
      reason: 'the model listing had an unexpected shape',
    });
    const down: typeof fetch = async () => {
      throw new Error('boom');
    };
    await expect(discoverAccountModels(OPENAI, deps(down))).resolves.toEqual({
      ok: false,
      reason: 'the model listing could not be reached: boom',
    });
  });

  it('has no listing for the other providers', async () => {
    const s = stub(() => Response.json({}));
    await expect(
      discoverAccountModels({ provider: 'gemini', apiKey: 'k' }, deps(s.fetch)),
    ).resolves.toMatchObject({ ok: false });
    expect(s.seen).toEqual([]);
  });
});

describe('parseStoredDiscovery', () => {
  it('round-trips both forms and rejects anything else', () => {
    const account = {
      source: 'account',
      modelIds: ['a'],
      fetchedAt: 1,
    };
    expect(parseStoredDiscovery(JSON.stringify(account))).toEqual(account);
    const catalog = { source: 'catalog', reason: 'r', fetchedAt: 2 };
    expect(parseStoredDiscovery(JSON.stringify(catalog))).toEqual(catalog);
    expect(parseStoredDiscovery('not json')).toBeNull();
    expect(
      parseStoredDiscovery('{"source":"account","fetchedAt":1}'),
    ).toBeNull();
  });
});

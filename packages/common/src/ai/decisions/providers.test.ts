import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import {
  CloudflareJevDecisionAdapter,
  OpenRouterJevDecisionAdapter,
  WorkersAiJevDecisionAdapter,
  type WorkersAiBinding,
} from './jev/index.js';
import {
  DECISION_PROVIDERS,
  decisionProviderEnvShape,
  resolveDecisionAdapter,
} from './providers.js';

const workersAi: WorkersAiBinding = {
  run: async () => ({ answers: {} }),
};

describe('decisionProviderEnvShape', () => {
  it('accepts the supported providers and rejects unknown ones', () => {
    const schema = z.object(decisionProviderEnvShape);

    expect(schema.parse({})).toEqual({});
    for (const provider of DECISION_PROVIDERS) {
      expect(schema.parse({ DECISION_PROVIDER: provider })).toEqual({
        DECISION_PROVIDER: provider,
      });
    }
    expect(schema.safeParse({ DECISION_PROVIDER: 'gpt' }).success).toBe(false);
    expect(schema.safeParse({ DECISION_MODEL: '' }).success).toBe(false);
  });
});

describe('resolveDecisionAdapter', () => {
  it('leaves Decisions unconfigured when no provider is selected', () => {
    expect(resolveDecisionAdapter({})).toEqual({
      ok: true,
      adapter: undefined,
    });
    expect(resolveDecisionAdapter({ DECISION_PROVIDER: '' })).toEqual({
      ok: true,
      adapter: undefined,
    });
    expect(resolveDecisionAdapter({ DECISION_PROVIDER: '  ' })).toEqual({
      ok: true,
      adapter: undefined,
    });
  });

  it('reports an unknown provider as a config issue', () => {
    const result = resolveDecisionAdapter({ DECISION_PROVIDER: 'gpt' });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.issues.map((issue) => issue.field)).toEqual([
      'DECISION_PROVIDER',
    ]);
  });

  it('requires OPEN_ROUTER_API_KEY for openrouter-jev', () => {
    const result = resolveDecisionAdapter({
      DECISION_PROVIDER: 'openrouter-jev',
    });

    expect(result).toEqual({
      ok: false,
      issues: [
        {
          field: 'OPEN_ROUTER_API_KEY',
          message: expect.stringContaining('openrouter-jev'),
        },
      ],
    });
  });

  it('builds the OpenRouter adapter with model, fetch and headers', async () => {
    const fetchMock = vi.fn<typeof fetch>(
      async () =>
        new Response(
          JSON.stringify({ answers: { work: { type: 'noul', noul: 0.5 } } }),
          { status: 200 },
        ),
    );

    const defaults = resolveDecisionAdapter({
      DECISION_PROVIDER: 'openrouter-jev',
      OPEN_ROUTER_API_KEY: 'or-key',
    });
    expect(defaults.ok).toBe(true);
    if (!defaults.ok) return;
    expect(defaults.adapter).toBeInstanceOf(OpenRouterJevDecisionAdapter);
    expect(defaults.adapter?.model).toBe('typesafe/jev-1.13');

    const custom = resolveDecisionAdapter(
      {
        DECISION_PROVIDER: 'openrouter-jev',
        OPEN_ROUTER_API_KEY: 'or-key',
        DECISION_MODEL: 'typesafe/jev-2',
      },
      { fetch: fetchMock, openRouterHeaders: { 'X-Title': 'Oracle' } },
    );
    expect(custom.ok).toBe(true);
    if (!custom.ok) return;
    expect(custom.adapter?.model).toBe('typesafe/jev-2');

    await custom.adapter?.evaluate({
      state: 'x',
      questions: { work: { kind: 'boolean', instructions: 'Work?' } },
    });
    const [, init] = fetchMock.mock.calls[0]!;
    expect(init?.headers).toMatchObject({
      'X-Title': 'Oracle',
      Authorization: 'Bearer or-key',
    });
  });

  it('uses the Workers AI binding for cloudflare-jev without credentials', () => {
    const result = resolveDecisionAdapter(
      { DECISION_PROVIDER: 'cloudflare-jev', DECISION_MODEL: 'typesafe/jev-x' },
      { workersAi },
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.adapter).toBeInstanceOf(WorkersAiJevDecisionAdapter);
    expect(result.adapter?.model).toBe('typesafe/jev-x');
  });

  it('requires both Cloudflare credentials for the REST adapter', () => {
    const missingBoth = resolveDecisionAdapter({
      DECISION_PROVIDER: 'cloudflare-jev',
    });
    expect(missingBoth.ok).toBe(false);
    if (missingBoth.ok) return;
    expect(missingBoth.issues.map((issue) => issue.field)).toEqual([
      'CLOUDFLARE_ACCOUNT_ID',
      'CLOUDFLARE_API_TOKEN',
    ]);
    for (const issue of missingBoth.issues) {
      expect(issue.message).toContain('AI binding');
    }

    const missingToken = resolveDecisionAdapter({
      DECISION_PROVIDER: 'cloudflare-jev',
      CLOUDFLARE_ACCOUNT_ID: 'acct',
      CLOUDFLARE_API_TOKEN: '   ',
    });
    expect(missingToken.ok).toBe(false);
    if (missingToken.ok) return;
    expect(missingToken.issues.map((issue) => issue.field)).toEqual([
      'CLOUDFLARE_API_TOKEN',
    ]);
  });

  it('builds the Cloudflare REST adapter from credentials', async () => {
    const fetchMock = vi.fn<typeof fetch>(
      async () =>
        new Response(
          JSON.stringify({ answers: { work: { type: 'noul', noul: 0.5 } } }),
          { status: 200 },
        ),
    );

    const defaults = resolveDecisionAdapter({
      DECISION_PROVIDER: 'cloudflare-jev',
      CLOUDFLARE_ACCOUNT_ID: 'acct',
      CLOUDFLARE_API_TOKEN: 'token',
    });
    expect(defaults.ok).toBe(true);
    if (!defaults.ok) return;
    expect(defaults.adapter).toBeInstanceOf(CloudflareJevDecisionAdapter);
    expect(defaults.adapter?.model).toBe('typesafe/jev');

    const custom = resolveDecisionAdapter(
      {
        DECISION_PROVIDER: 'cloudflare-jev',
        CLOUDFLARE_ACCOUNT_ID: 'acct',
        CLOUDFLARE_API_TOKEN: 'token',
        DECISION_MODEL: 'typesafe/jev-next',
      },
      { fetch: fetchMock },
    );
    expect(custom.ok).toBe(true);
    if (!custom.ok) return;
    expect(custom.adapter?.model).toBe('typesafe/jev-next');

    await custom.adapter?.evaluate({
      state: 'x',
      questions: { work: { kind: 'boolean', instructions: 'Work?' } },
    });
    expect(fetchMock.mock.calls[0]?.[0]).toBe(
      'https://api.cloudflare.com/client/v4/accounts/acct/ai/run',
    );
  });
});

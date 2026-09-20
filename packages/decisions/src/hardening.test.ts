import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import {
  defineDecision,
  DecisionRuntime,
  scopeDecisions,
  validateDecisionRequest,
  type DecisionAdapter,
  type DecisionRequest,
} from './index.js';
import {
  CloudflareJevDecisionAdapter,
  OpenRouterJevDecisionAdapter,
} from './providers/index.js';
import { createDecisionAdapterFromConfig } from './config.js';

const request: DecisionRequest = {
  state: { message: 'Please help with my invoice.' },
  questions: {
    work: { kind: 'boolean', instructions: 'Does this request help?' },
    team: {
      kind: 'choice',
      instructions: 'Which team?',
      options: { billing: 'Invoices', support: 'Other help' },
    },
    urgency: {
      kind: 'ordinal',
      instructions: 'How urgent?',
      levels: ['Routine', 'Urgent'],
    },
  },
};
const payload = {
  model: 'jev-1.13.0',
  answers: {
    work: { type: 'noul', noul: 0.9 },
    team: {
      type: 'choice',
      choice: 'billing',
      confidence: 0.9,
      probabilities: { billing: 0.9, support: 0.1 },
    },
    urgency: {
      type: 'score',
      score: 0.2,
      confidence: 0.8,
      probabilities: { '0': 0.8, '1': 0.2 },
    },
  },
  usage: { input_tokens: 50, output_tokens: 5 },
};
const definition = defineDecision({
  name: 'test.route',
  version: '1',
  description: 'Test routing',
  inputSchema: z.string(),
  project: () => structuredClone(request),
});
const simple = defineDecision({
  name: 'test.boolean',
  version: '1',
  description: 'Test boolean',
  inputSchema: z.string(),
  project: (text) => ({
    state: text,
    questions: { work: request.questions.work! },
  }),
});
const answer = {
  answers: { work: { kind: 'boolean' as const, probabilityTrue: 0.9 } },
};

const providers = [
  {
    name: 'cloudflare',
    create: (fetch: typeof globalThis.fetch) =>
      new CloudflareJevDecisionAdapter({
        accountId: 'account',
        apiToken: 'secret',
        gatewayId: 'audit',
        fetch,
      }),
    endpoint: 'https://api.cloudflare.com/client/v4/accounts/account/ai/run',
  },
  {
    name: 'openrouter',
    create: (fetch: typeof globalThis.fetch) =>
      new OpenRouterJevDecisionAdapter({ apiKey: 'secret', fetch }),
    endpoint: 'https://openrouter.ai/api/alpha/decisions',
  },
];

describe.each(providers)('$name contract', ({ create, endpoint, name }) => {
  it('sends only projected state to the provider-specific Decisions endpoint', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(async () =>
      Response.json(payload),
    );
    const result = await new DecisionRuntime(undefined, create(fetch)).evaluate(
      definition,
      'private input excluded by projection',
    );
    const [url, init] = fetch.mock.calls[0]!;
    expect(url).toBe(endpoint);
    expect(init?.redirect).toBe('error');
    const body = JSON.parse(String(init?.body));
    expect(name === 'cloudflare' ? body.input.state : body.state).toEqual(
      request.state,
    );
    expect(String(init?.body)).not.toContain('private input excluded');
    expect(result.answers.urgency).toMatchObject({ score: 0.2 });
    expect(result.modelVersion).toBe('jev-1.13.0');
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(body.provider).toEqual(
      name === 'openrouter'
        ? { allow_fallbacks: false, data_collection: 'deny' }
        : undefined,
    );
  });

  it.each([
    {
      ...payload,
      answers: { ...payload.answers, work: { type: 'noul', noul: 1.5 } },
    },
    {
      ...payload,
      answers: {
        ...payload.answers,
        team: { ...payload.answers.team, choice: 'constructor' },
      },
    },
    {
      ...payload,
      answers: {
        ...payload.answers,
        urgency: {
          ...payload.answers.urgency,
          probabilities: { unrelated: 1 },
        },
      },
    },
    { ...payload, answers: {} },
    { ...payload, model: '' },
    { ...payload, usage: { input_tokens: -1 } },
  ])('rejects malformed results at the adapter boundary', async (body) => {
    await expect(
      create(async () => Response.json(body)).evaluate(request),
    ).rejects.toThrow();
  });

  it.each(['fetch', 'json', 'http', 'code'])(
    'does not leak private content from %s errors',
    async (failure) => {
      const sensitive = 'PRIVATE-CONTENT-SECRET';
      const fetch = vi.fn<typeof globalThis.fetch>(async () => {
        if (failure === 'fetch')
          throw new Error(sensitive, { cause: sensitive });
        if (failure === 'json') return new Response(`{"${sensitive}`);
        if (failure === 'code')
          return Response.json({
            success: false,
            errors: [{ code: sensitive, message: sensitive }],
          });
        return new Response(sensitive, { status: 429 });
      });
      const error = await create(fetch)
        .evaluate(request)
        .catch((error: unknown) => error);
      expect(error).toBeInstanceOf(Error);
      expect(String(error)).not.toContain(sensitive);
      expect(JSON.stringify(error)).not.toContain(sensitive);
      expect(error).not.toHaveProperty('cause');
      expect(fetch).toHaveBeenCalledTimes(1);
    },
  );

  it('bounds streamed bodies without Content-Length and cancels reads', async () => {
    const cancel = vi.fn();
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        controller.enqueue(new Uint8Array(256 * 1024 + 1));
      },
      cancel,
    });
    await expect(
      create(async () => new Response(stream)).evaluate(request),
    ).rejects.toThrow();
    expect(cancel).toHaveBeenCalledTimes(1);
  });

  it('forwards cancellation to an in-flight fetch', async () => {
    const controller = new AbortController();
    const fetch = vi.fn<typeof globalThis.fetch>(
      async (_url, init) =>
        new Promise((_resolve, reject) => {
          init?.signal?.addEventListener(
            'abort',
            () => reject(init.signal?.reason),
            { once: true },
          );
          controller.abort();
        }),
    );
    await expect(
      create(fetch).evaluate(request, { signal: controller.signal }),
    ).rejects.toMatchObject({ name: 'AbortError' });
    expect(fetch.mock.calls[0]?.[1]?.signal?.aborted).toBe(true);
  });
});

describe('runtime hardening', () => {
  it('never invokes the provider for a cancelled request', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>();
    await expect(
      new DecisionRuntime(undefined, providers[0]!.create(fetch)).evaluate(
        simple,
        'test',
        { signal: AbortSignal.abort('private cancellation reason') },
      ),
    ).rejects.toMatchObject({ name: 'AbortError' });
    expect(fetch).not.toHaveBeenCalled();
  });

  it('cancels even if the host adapter ignores AbortSignal', async () => {
    const controller = new AbortController();
    const adapter: DecisionAdapter = {
      provider: 'test',
      model: 'test',
      evaluate: () => new Promise(() => undefined),
    };
    const pending = new DecisionRuntime(undefined, adapter).evaluate(
      simple,
      'test',
      { signal: controller.signal },
    );
    controller.abort();
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
  });

  it('does not let caller options replace the owning turn signal', async () => {
    const controller = new AbortController();
    const adapter: DecisionAdapter = {
      provider: 'test',
      model: 'test',
      evaluate: () => new Promise(() => undefined),
    };
    const scoped = scopeDecisions(
      new DecisionRuntime(undefined, adapter),
      controller.signal,
    );
    const pending = scoped.evaluate(simple, 'test', {
      signal: new AbortController().signal,
    });
    controller.abort();
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
  });

  it('times out and retains capacity accounting for adapters still running', async () => {
    const adapter: DecisionAdapter = {
      provider: 'test',
      model: 'test',
      evaluate: () => new Promise(() => undefined),
    };
    const runtime = new DecisionRuntime(undefined, adapter);
    const results = await Promise.allSettled(
      Array.from({ length: 8 }, () =>
        runtime.evaluate(simple, 'test', { timeoutMs: 5 }),
      ),
    );
    expect(results.every((result) => result.status === 'rejected')).toBe(true);
    await expect(runtime.evaluate(simple, 'test')).rejects.toThrow(
      'concurrency limit',
    );
  });

  it.each([NaN, Infinity, 0, -1, 0.5, 30001])(
    'rejects invalid timeout %s before provider invocation',
    async (timeoutMs) => {
      const evaluate = vi.fn(async () => answer);
      await expect(
        new DecisionRuntime(undefined, {
          provider: 'test',
          model: 'test',
          evaluate,
        }).evaluate(simple, 'test', { timeoutMs }),
      ).rejects.toThrow('timeout');
      expect(evaluate).not.toHaveBeenCalled();
    },
  );

  it('validates against the original contract when an adapter mutates its copy', async () => {
    const adapter: DecisionAdapter = {
      provider: 'test',
      model: 'test',
      async evaluate(input) {
        input.questions = {};
        return { answers: {} };
      },
    };
    await expect(
      new DecisionRuntime(undefined, adapter).evaluate(simple, 'test'),
    ).rejects.toThrow('keys do not match');
  });

  it('bounds question text as well as state', () => {
    const oversized = structuredClone(request);
    oversized.questions.work!.instructions = 'x'.repeat(129 * 1024);
    expect(() => validateDecisionRequest(oversized)).toThrow('128KiB');
  });

  it('fails closed on an unsupported provider or missing credentials', () => {
    expect(() =>
      createDecisionAdapterFromConfig({ DECISION_PROVIDER: 'typo' }),
    ).toThrow('Unsupported');
    expect(() =>
      createDecisionAdapterFromConfig({ DECISION_PROVIDER: 'openrouter-jev' }),
    ).toThrow('OPEN_ROUTER_API_KEY');
    expect(
      createDecisionAdapterFromConfig({
        DECISION_PROVIDER: 'openrouter-jev',
        OPEN_ROUTER_API_KEY: 'secret',
      })?.model,
    ).toBe('typesafe/jev-1.13');
  });
});

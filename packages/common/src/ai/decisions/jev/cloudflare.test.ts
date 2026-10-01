import { describe, expect, it, vi } from 'vitest';
import type { DecisionRequest } from '../types.js';
import { CloudflareJevDecisionAdapter } from './cloudflare.js';
import { JevDecisionError } from './wire.js';

const request: DecisionRequest = {
  state: {
    message: 'Please file my taxes.',
  },
  questions: {
    work: {
      kind: 'boolean',
      instructions: 'Is paid work requested now?',
      criteria: {
        true: 'Explicit request to perform work',
        false: 'Question or support request',
      },
    },
    service: {
      kind: 'choice',
      instructions: 'Which service matches?',
      options: {
        tax: 'Tax preparation',
        books: 'Bookkeeping',
        none: 'No matching service',
      },
    },
    urgency: {
      kind: 'ordinal',
      instructions: 'How urgent is the request?',
      levels: ['low', 'medium', 'high'],
    },
  },
};

const booleanRequest: DecisionRequest = {
  state: 'message',
  questions: {
    work: {
      kind: 'boolean',
      instructions: 'Is this work?',
    },
  },
};

function successResponse(result: unknown): Response {
  return new Response(JSON.stringify(result), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
}

describe('CloudflareJevDecisionAdapter', () => {
  it('requires an account id and an API token', () => {
    expect(
      () => new CloudflareJevDecisionAdapter({ accountId: ' ', apiToken: 't' }),
    ).toThrow(TypeError);
    expect(
      () => new CloudflareJevDecisionAdapter({ accountId: 'a', apiToken: '' }),
    ).toThrow(TypeError);
  });

  it('maps boolean, choice, and ordinal questions to Jev', async () => {
    const fetchMock = vi.fn<typeof fetch>(async () =>
      successResponse({
        model: 'jev-1.13.0',
        answers: {
          work: { type: 'noul', noul: 0.98 },
          service: {
            type: 'choice',
            choice: 'tax',
            confidence: 0.95,
            probabilities: { tax: 0.95, books: 0.03, none: 0.02 },
          },
          urgency: {
            type: 'score',
            score: 1.4,
            confidence: 0.82,
            legend: { 0: 'low', 1: 'medium', 2: 'high' },
            probabilities: { 0: 0.1, 1: 0.4, 2: 0.5 },
          },
        },
        usage: { input_tokens: 100, output_tokens: 20 },
      }),
    );

    const adapter = new CloudflareJevDecisionAdapter({
      accountId: 'account-1',
      apiToken: 'secret-token',
      fetch: fetchMock,
    });
    expect(adapter.provider).toBe('cloudflare');
    expect(adapter.model).toBe('typesafe/jev');

    const result = await adapter.evaluate(request);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe(
      'https://api.cloudflare.com/client/v4/accounts/account-1/ai/run',
    );
    expect(init?.method).toBe('POST');
    expect(init?.headers).toEqual({
      Authorization: 'Bearer secret-token',
      'Content-Type': 'application/json',
    });

    const body = JSON.parse(String(init?.body)) as {
      model: string;
      input: {
        state: unknown;
        questions: Record<string, unknown>;
      };
    };
    expect(body.model).toBe('typesafe/jev');
    expect(body.input.state).toEqual(request.state);
    expect(body.input.questions).toEqual({
      work: {
        type: 'noul',
        instructions:
          'Is paid work requested now?\n' +
          'Answer true when: Explicit request to perform work\n' +
          'Answer false when: Question or support request',
      },
      service: {
        type: 'choice',
        instructions: 'Which service matches?',
        criteria: {
          tax: 'Tax preparation',
          books: 'Bookkeeping',
          none: 'No matching service',
        },
      },
      urgency: {
        type: 'score',
        instructions: 'How urgent is the request?',
        criteria: ['low', 'medium', 'high'],
      },
    });

    expect(result).toEqual({
      modelVersion: 'jev-1.13.0',
      answers: {
        work: { kind: 'boolean', probabilityTrue: 0.98 },
        service: {
          kind: 'choice',
          value: 'tax',
          confidence: 0.95,
          probabilities: { tax: 0.95, books: 0.03, none: 0.02 },
        },
        urgency: {
          kind: 'ordinal',
          score: 1.4,
          confidence: 0.82,
          probabilities: { 0: 0.1, 1: 0.4, 2: 0.5 },
        },
      },
      usage: { inputTokens: 100, outputTokens: 20 },
    });
  });

  it('accepts the Cloudflare API envelope', async () => {
    const adapter = new CloudflareJevDecisionAdapter({
      accountId: 'account-1',
      apiToken: 'token',
      fetch: vi.fn<typeof fetch>(async () =>
        successResponse({
          success: true,
          errors: [],
          messages: [],
          result: {
            model: 'jev-1.13.0',
            answers: {
              work: { type: 'noul', noul: 0.75 },
            },
          },
        }),
      ),
    });

    const result = await adapter.evaluate(booleanRequest);

    expect(result.answers.work).toEqual({
      kind: 'boolean',
      probabilityTrue: 0.75,
    });
  });

  it('forwards the AbortSignal and honours model and baseUrl overrides', async () => {
    const controller = new AbortController();
    const fetchMock = vi.fn<typeof fetch>(async () =>
      successResponse({
        answers: {
          work: { type: 'noul', noul: 0.5 },
        },
      }),
    );
    const adapter = new CloudflareJevDecisionAdapter({
      accountId: 'account-1',
      apiToken: 'token',
      model: 'typesafe/jev-next',
      baseUrl: 'https://gateway.example.com/',
      fetch: fetchMock,
    });

    await adapter.evaluate(booleanRequest, { signal: controller.signal });

    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe(
      'https://gateway.example.com/client/v4/accounts/account-1/ai/run',
    );
    expect(init?.signal).toBe(controller.signal);
    expect(JSON.parse(String(init?.body))).toMatchObject({
      model: 'typesafe/jev-next',
    });
    expect(adapter.model).toBe('typesafe/jev-next');
  });

  it('does not expose projected state in HTTP errors', async () => {
    const sensitive = 'private-message-that-must-not-leak';
    const adapter = new CloudflareJevDecisionAdapter({
      accountId: 'account-1',
      apiToken: 'token',
      fetch: vi.fn<typeof fetch>(
        async () =>
          new Response(
            JSON.stringify({
              success: false,
              errors: [{ code: 1001, message: sensitive }],
            }),
            { status: 401 },
          ),
      ),
    });

    let error: unknown;
    try {
      await adapter.evaluate({
        state: sensitive,
        questions: booleanRequest.questions,
      });
    } catch (caught) {
      error = caught;
    }

    expect(error).toBeInstanceOf(JevDecisionError);
    expect(String(error)).not.toContain(sensitive);
    expect(error).toMatchObject({ provider: 'cloudflare', status: 401 });
  });

  it('keeps provider errors free of echoed state', async () => {
    const sensitive = 'provider echoed private state';
    const adapter = new CloudflareJevDecisionAdapter({
      accountId: 'account-1',
      apiToken: 'token',
      fetch: vi.fn<typeof fetch>(async () =>
        successResponse({
          success: false,
          errors: [{ code: 9001, message: sensitive }],
        }),
      ),
    });

    await expect(
      adapter.evaluate({
        state: sensitive,
        questions: booleanRequest.questions,
      }),
    ).rejects.toMatchObject({
      name: 'JevDecisionError',
      provider: 'cloudflare',
      code: 9001,
    });
  });

  it('rejects unknown Jev answer types', async () => {
    const adapter = new CloudflareJevDecisionAdapter({
      accountId: 'account-1',
      apiToken: 'token',
      fetch: vi.fn<typeof fetch>(async () =>
        successResponse({
          answers: {
            work: { type: 'freeform', text: 'yes' },
          },
        }),
      ),
    });

    await expect(adapter.evaluate(booleanRequest)).rejects.toBeInstanceOf(
      JevDecisionError,
    );
  });

  it('wraps invalid JSON and transport failures', async () => {
    const invalidJson = new CloudflareJevDecisionAdapter({
      accountId: 'account-1',
      apiToken: 'token',
      fetch: vi.fn<typeof fetch>(
        async () => new Response('not json', { status: 200 }),
      ),
    });
    await expect(invalidJson.evaluate(booleanRequest)).rejects.toMatchObject({
      name: 'JevDecisionError',
      status: 200,
    });

    const networkFailure = new Error('socket hang up');
    const transport = new CloudflareJevDecisionAdapter({
      accountId: 'account-1',
      apiToken: 'token',
      fetch: vi.fn<typeof fetch>(async () => {
        throw networkFailure;
      }),
    });
    await expect(transport.evaluate(booleanRequest)).rejects.toMatchObject({
      name: 'JevDecisionError',
      cause: networkFailure,
    });
  });

  it('propagates abort errors', async () => {
    const controller = new AbortController();
    const aborted = new DOMException('Aborted', 'AbortError');
    const fetchMock = vi.fn<typeof fetch>(async () => {
      controller.abort();
      throw aborted;
    });
    const adapter = new CloudflareJevDecisionAdapter({
      accountId: 'account-1',
      apiToken: 'token',
      fetch: fetchMock,
    });

    await expect(
      adapter.evaluate(booleanRequest, { signal: controller.signal }),
    ).rejects.toBe(aborted);
  });
});

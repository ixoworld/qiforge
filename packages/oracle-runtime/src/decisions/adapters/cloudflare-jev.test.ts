import type { DecisionRequest } from '@ixo/common';
import { describe, expect, it, vi } from 'vitest';
import {
  CloudflareJevDecisionAdapter,
  CloudflareJevDecisionError,
} from './cloudflare-jev.js';

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

function successResponse(result: unknown): Response {
  return new Response(JSON.stringify(result), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
}

describe('CloudflareJevDecisionAdapter', () => {
  it('maps boolean, choice, and ordinal questions to Jev', async () => {
    const fetchMock = vi.fn(
      async (_input: RequestInfo | URL, _init?: RequestInit) =>
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
              legend: { '0': 'low', '1': 'medium', '2': 'high' },
              probabilities: { '0': 0.1, '1': 0.4, '2': 0.5 },
            },
          },
          usage: { input_tokens: 100, output_tokens: 20 },
        }),
    );

    const adapter = new CloudflareJevDecisionAdapter({
      accountId: 'account-1',
      apiToken: 'secret-token',
      fetch: fetchMock as typeof fetch,
    });

    const result = await adapter.evaluate(request);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe(
      'https://api.cloudflare.com/client/v4/accounts/account-1/ai/run',
    );

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
        instructions: 'Is paid work requested now?',
        criteria: {
          true: 'Explicit request to perform work',
          false: 'Question or support request',
        },
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
          probabilities: { '0': 0.1, '1': 0.4, '2': 0.5 },
        },
      },
      usage: { inputTokens: 100, outputTokens: 20 },
    });
  });

  it('accepts the Cloudflare API envelope', async () => {
    const adapter = new CloudflareJevDecisionAdapter({
      accountId: 'account-1',
      apiToken: 'token',
      fetch: vi.fn(
        async () =>
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
      ) as typeof fetch,
    });

    const result = await adapter.evaluate({
      state: 'do this',
      questions: {
        work: {
          kind: 'boolean',
          instructions: 'Is this work?',
        },
      },
    });

    expect(result.answers.work).toEqual({
      kind: 'boolean',
      probabilityTrue: 0.75,
    });
  });

  it('forwards AbortSignal and an optional AI Gateway id', async () => {
    const controller = new AbortController();
    const fetchMock = vi.fn(
      async (_input: RequestInfo | URL, _init?: RequestInit) =>
        successResponse({
          answers: {
            work: { type: 'noul', noul: 0.5 },
          },
        }),
    );
    const adapter = new CloudflareJevDecisionAdapter({
      accountId: 'account-1',
      apiToken: 'token',
      gatewayId: 'decisions',
      fetch: fetchMock as typeof fetch,
    });

    await adapter.evaluate(
      {
        state: 'message',
        questions: {
          work: {
            kind: 'boolean',
            instructions: 'Is this work?',
          },
        },
      },
      { signal: controller.signal },
    );

    const [, init] = fetchMock.mock.calls[0]!;
    expect(init?.signal).toBe(controller.signal);
    expect(init?.headers).toMatchObject({
      'cf-aig-gateway-id': 'decisions',
      'Content-Type': 'application/json',
    });
  });

  it('does not expose projected state in HTTP errors', async () => {
    const sensitive = 'private-message-that-must-not-leak';
    const adapter = new CloudflareJevDecisionAdapter({
      accountId: 'account-1',
      apiToken: 'token',
      fetch: vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              success: false,
              errors: [{ code: 1001, message: sensitive }],
            }),
            { status: 401 },
          ),
      ) as typeof fetch,
    });

    let error: unknown;
    try {
      await adapter.evaluate({
        state: sensitive,
        questions: {
          work: {
            kind: 'boolean',
            instructions: 'Is this work?',
          },
        },
      });
    } catch (caught) {
      error = caught;
    }

    expect(error).toBeInstanceOf(CloudflareJevDecisionError);
    expect(String(error)).not.toContain(sensitive);
    expect((error as CloudflareJevDecisionError).status).toBe(401);
  });

  it('keeps provider errors free of echoed state', async () => {
    const sensitive = 'provider echoed private state';
    const adapter = new CloudflareJevDecisionAdapter({
      accountId: 'account-1',
      apiToken: 'token',
      fetch: vi.fn(
        async () =>
          successResponse({
            success: false,
            errors: [{ code: 9001, message: sensitive }],
          }),
      ) as typeof fetch,
    });

    await expect(
      adapter.evaluate({
        state: sensitive,
        questions: {
          work: {
            kind: 'boolean',
            instructions: 'Is this work?',
          },
        },
      }),
    ).rejects.toMatchObject({
      name: 'CloudflareJevDecisionError',
      code: 9001,
    });
  });

  it('rejects unknown Jev answer types', async () => {
    const adapter = new CloudflareJevDecisionAdapter({
      accountId: 'account-1',
      apiToken: 'token',
      fetch: vi.fn(
        async () =>
          successResponse({
            answers: {
              work: { type: 'freeform', text: 'yes' },
            },
          }),
      ) as typeof fetch,
    });

    await expect(
      adapter.evaluate({
        state: 'message',
        questions: {
          work: {
            kind: 'boolean',
            instructions: 'Is this work?',
          },
        },
      }),
    ).rejects.toBeInstanceOf(CloudflareJevDecisionError);
  });

  it('propagates abort errors', async () => {
    const controller = new AbortController();
    const aborted = new DOMException('Aborted', 'AbortError');
    const fetchMock = vi.fn(async () => {
      controller.abort();
      throw aborted;
    });
    const adapter = new CloudflareJevDecisionAdapter({
      accountId: 'account-1',
      apiToken: 'token',
      fetch: fetchMock as typeof fetch,
    });

    await expect(
      adapter.evaluate(
        {
          state: 'message',
          questions: {
            work: {
              kind: 'boolean',
              instructions: 'Is this work?',
            },
          },
        },
        { signal: controller.signal },
      ),
    ).rejects.toBe(aborted);
  });
});

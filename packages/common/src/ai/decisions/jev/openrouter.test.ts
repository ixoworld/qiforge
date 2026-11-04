import { describe, expect, it, vi } from 'vitest';
import type { DecisionRequest } from '../types.js';
import {
  OPENROUTER_FALLBACK_DECISION_MODEL,
  OpenRouterJevDecisionAdapter,
} from './openrouter.js';
import { JevDecisionError } from './wire.js';

const request: DecisionRequest = {
  state: { message: 'Please file my taxes.' },
  questions: {
    work: {
      kind: 'boolean',
      instructions: 'Is paid work requested now?',
    },
    service: {
      kind: 'choice',
      instructions: 'Which service matches?',
      options: { tax: 'Tax preparation', none: 'No matching service' },
    },
  },
};

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

describe('OpenRouterJevDecisionAdapter', () => {
  it('requires an API key', () => {
    expect(() => new OpenRouterJevDecisionAdapter({ apiKey: '  ' })).toThrow(
      TypeError,
    );
  });

  it('posts the decisions request with auth and extra headers', async () => {
    const fetchMock = vi.fn<typeof fetch>(async () =>
      jsonResponse({
        model: 'typesafe/jev-1.13',
        provider: 'TypeSafe',
        answers: {
          work: { type: 'noul', noul: 0.9 },
          service: {
            type: 'choice',
            choice: 'tax',
            confidence: 0.8,
            probabilities: { tax: 0.8, none: 0.2 },
          },
        },
        usage: { prompt_tokens: 50, completion_tokens: 5, cost: 0.0002 },
      }),
    );
    const adapter = new OpenRouterJevDecisionAdapter({
      apiKey: 'or-key',
      fetch: fetchMock,
      headers: { 'HTTP-Referer': 'https://oracle.example', 'X-Title': 'Test' },
    });
    expect(adapter.provider).toBe('openrouter');
    expect(adapter.model).toBe('typesafe/jev-1.13');

    const result = await adapter.evaluate(request);

    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe('https://openrouter.ai/api/alpha/decisions');
    expect(init?.method).toBe('POST');
    expect(init?.headers).toEqual({
      'HTTP-Referer': 'https://oracle.example',
      'X-Title': 'Test',
      Authorization: 'Bearer or-key',
      'Content-Type': 'application/json',
    });
    expect(JSON.parse(String(init?.body))).toEqual({
      model: 'typesafe/jev-1.13',
      state: request.state,
      questions: {
        work: { type: 'noul', instructions: 'Is paid work requested now?' },
        service: {
          type: 'choice',
          instructions: 'Which service matches?',
          criteria: { tax: 'Tax preparation', none: 'No matching service' },
        },
      },
    });

    expect(result).toEqual({
      modelVersion: 'typesafe/jev-1.13',
      answers: {
        work: { kind: 'boolean', probabilityTrue: 0.9 },
        service: {
          kind: 'choice',
          value: 'tax',
          confidence: 0.8,
          probabilities: { tax: 0.8, none: 0.2 },
        },
      },
      provenance: {
        method: { kind: 'provider-native' },
        apiDialect: 'systemone-v1',
        requestedModel: 'typesafe/jev-1.13',
        returnedModel: 'typesafe/jev-1.13',
        modelPinning: 'pinned',
        providerArtifactRef: 'typesafe/jev-1.13',
      },
      usage: { inputTokens: 50, outputTokens: 5 },
    });
  });

  it('honours model and baseUrl overrides and forwards the signal', async () => {
    const controller = new AbortController();
    const fetchMock = vi.fn<typeof fetch>(async () =>
      jsonResponse({ answers: { work: { type: 'noul', noul: 0.1 } } }),
    );
    const adapter = new OpenRouterJevDecisionAdapter({
      apiKey: 'or-key',
      model: 'typesafe/jev-2',
      baseUrl: 'https://proxy.example/',
      fetch: fetchMock,
    });

    const result = await adapter.evaluate(
      { state: 'x', questions: { work: request.questions.work! } },
      { signal: controller.signal },
    );

    // Only the default release id is recorded as pinned.
    expect(adapter.capabilities.modelPinning).toBe('unknown');
    expect(result.provenance).toMatchObject({
      requestedModel: 'typesafe/jev-2',
      modelPinning: 'unknown',
    });
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe('https://proxy.example/api/alpha/decisions');
    expect(init?.signal).toBe(controller.signal);
    expect(JSON.parse(String(init?.body))).toMatchObject({
      model: 'typesafe/jev-2',
    });
  });

  it('reports non-2xx responses with status and code but never the message', async () => {
    const sensitive = 'provider-error-text-that-must-not-leak';
    const adapter = new OpenRouterJevDecisionAdapter({
      apiKey: 'or-key',
      fetch: vi.fn<typeof fetch>(async () =>
        jsonResponse({ error: { code: 402, message: sensitive } }, 402),
      ),
    });

    let error: unknown;
    try {
      await adapter.evaluate({ ...request, state: sensitive });
    } catch (caught) {
      error = caught;
    }

    expect(error).toBeInstanceOf(JevDecisionError);
    expect(error).toMatchObject({
      provider: 'openrouter',
      status: 402,
      code: 402,
    });
    expect(String(error)).not.toContain(sensitive);
  });

  it('tolerates non-JSON error bodies', async () => {
    const adapter = new OpenRouterJevDecisionAdapter({
      apiKey: 'or-key',
      fetch: vi.fn<typeof fetch>(
        async () => new Response('Bad Gateway', { status: 502 }),
      ),
    });

    await expect(adapter.evaluate(request)).rejects.toMatchObject({
      name: 'JevDecisionError',
      status: 502,
      code: undefined,
    });
  });

  it('rejects malformed success payloads', async () => {
    const adapter = new OpenRouterJevDecisionAdapter({
      apiKey: 'or-key',
      fetch: vi.fn<typeof fetch>(async () =>
        jsonResponse({ answers: { work: { type: 'freeform' } } }),
      ),
    });

    await expect(adapter.evaluate(request)).rejects.toBeInstanceOf(
      JevDecisionError,
    );
  });

  it('propagates abort errors and wraps other transport failures', async () => {
    const controller = new AbortController();
    const aborted = new DOMException('Aborted', 'AbortError');
    const abortingAdapter = new OpenRouterJevDecisionAdapter({
      apiKey: 'or-key',
      fetch: vi.fn<typeof fetch>(async () => {
        controller.abort();
        throw aborted;
      }),
    });
    await expect(
      abortingAdapter.evaluate(request, { signal: controller.signal }),
    ).rejects.toBe(aborted);

    const failure = new Error('ECONNRESET');
    const failingAdapter = new OpenRouterJevDecisionAdapter({
      apiKey: 'or-key',
      fetch: vi.fn<typeof fetch>(async () => {
        throw failure;
      }),
    });
    await expect(failingAdapter.evaluate(request)).rejects.toMatchObject({
      name: 'JevDecisionError',
      provider: 'openrouter',
      cause: failure,
    });
  });

  describe('fallback model', () => {
    const answer = (model: string) =>
      jsonResponse({
        model,
        answers: {
          work: { type: 'noul', noul: 0.7 },
          service: {
            type: 'choice',
            choice: 'tax',
            confidence: 0.6,
            probabilities: { tax: 0.6, none: 0.4 },
          },
        },
      });
    const requestedModels = (
      fetchMock: ReturnType<typeof vi.fn<typeof fetch>>,
    ) =>
      fetchMock.mock.calls.map(
        ([, init]) =>
          (JSON.parse(String(init?.body)) as { model: string }).model,
      );

    it('asks the Microsoft model once when the Jev request fails', async () => {
      const fetchMock = vi
        .fn<typeof fetch>()
        .mockResolvedValueOnce(jsonResponse({ error: { code: 503 } }, 503))
        .mockResolvedValueOnce(
          answer('microsoft/microsoft-decision-1-20261009'),
        );
      const adapter = new OpenRouterJevDecisionAdapter({
        apiKey: 'or-key',
        fetch: fetchMock,
      });

      const result = await adapter.evaluate(request);

      expect(requestedModels(fetchMock)).toEqual([
        'typesafe/jev-1.13',
        OPENROUTER_FALLBACK_DECISION_MODEL,
      ]);
      expect(result.answers.work).toEqual({
        kind: 'boolean',
        probabilityTrue: 0.7,
      });
      expect(result.provenance).toMatchObject({
        requestedModel: 'microsoft/microsoft-decision-1',
        returnedModel: 'microsoft/microsoft-decision-1-20261009',
        modelPinning: 'unknown',
      });
    });

    it('falls back on a transport failure and an unreadable answer too', async () => {
      for (const failure of [
        async () => {
          throw new Error('ECONNRESET');
        },
        async () => jsonResponse({ answers: { work: { type: 'freeform' } } }),
      ]) {
        const fetchMock = vi
          .fn<typeof fetch>()
          .mockImplementationOnce(failure)
          .mockResolvedValueOnce(answer('microsoft/microsoft-decision-1'));
        const adapter = new OpenRouterJevDecisionAdapter({
          apiKey: 'or-key',
          fetch: fetchMock,
        });
        await expect(adapter.evaluate(request)).resolves.toBeDefined();
        expect(fetchMock).toHaveBeenCalledTimes(2);
      }
    });

    it('does not ask the fallback after a success or an abort', async () => {
      const ok = vi.fn<typeof fetch>(async () => answer('typesafe/jev-1.13'));
      await new OpenRouterJevDecisionAdapter({
        apiKey: 'or-key',
        fetch: ok,
      }).evaluate(request);
      expect(ok).toHaveBeenCalledTimes(1);

      const controller = new AbortController();
      const aborted = new DOMException('Aborted', 'AbortError');
      const aborting = vi.fn<typeof fetch>(async () => {
        controller.abort();
        throw aborted;
      });
      await expect(
        new OpenRouterJevDecisionAdapter({
          apiKey: 'or-key',
          fetch: aborting,
        }).evaluate(request, { signal: controller.signal }),
      ).rejects.toBe(aborted);
      expect(aborting).toHaveBeenCalledTimes(1);
    });

    it('throws when the fallback fails as well', async () => {
      const fetchMock = vi.fn<typeof fetch>(async () =>
        jsonResponse({ error: { code: 502 } }, 502),
      );
      const adapter = new OpenRouterJevDecisionAdapter({
        apiKey: 'or-key',
        fetch: fetchMock,
      });
      await expect(adapter.evaluate(request)).rejects.toMatchObject({
        name: 'JevDecisionError',
        status: 502,
      });
      expect(fetchMock).toHaveBeenCalledTimes(2);
    });

    it('is off with `fallbackModel: null`', async () => {
      const fetchMock = vi.fn<typeof fetch>(async () =>
        jsonResponse({ error: { code: 503 } }, 503),
      );
      const adapter = new OpenRouterJevDecisionAdapter({
        apiKey: 'or-key',
        fetch: fetchMock,
        fallbackModel: null,
      });
      await expect(adapter.evaluate(request)).rejects.toBeInstanceOf(
        JevDecisionError,
      );
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });
  });
});

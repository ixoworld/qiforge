import { describe, expect, it, vi } from 'vitest';
import { fetchGenerationAttempts } from './model-call';

describe('fetchGenerationAttempts', () => {
  it('waits for the record and returns each provider attempt (shape of a live record, 2026-11-13)', async () => {
    const responses = [
      new Response('{"error":{"message":"not found"}}', { status: 404 }),
      Response.json({
        data: {
          id: 'gen-1',
          provider_responses: [
            {
              provider_name: 'OpenAI',
              status: 400,
              latency: 363,
              model_permaslug: 'openai/gpt-5.6-luna-20260709',
              is_byok: false,
            },
            {
              provider_name: 'Azure',
              status: 400,
              latency: 783,
              model_permaslug: 'openai/gpt-5.6-luna-20260709',
            },
            {
              provider_name: 'Amazon Bedrock',
              status: 200,
              latency: 622,
              model_permaslug: 'openai/gpt-5.6-luna-20260709',
            },
          ],
        },
      }),
    ];
    const fetchImpl = vi.fn(
      async (_input: RequestInfo | URL, _init?: RequestInit) =>
        responses.shift()!,
    );
    const attempts = await fetchGenerationAttempts({
      apiKey: 'sk-test',
      baseURL: 'https://openrouter.ai/api/v1/',
      generationId: 'gen-1',
      fetch: fetchImpl,
      sleep: async () => undefined,
    });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(fetchImpl.mock.calls[0]?.[0]).toBe(
      'https://openrouter.ai/api/v1/generation?id=gen-1',
    );
    expect(attempts).toEqual([
      {
        provider: 'OpenAI',
        model: 'openai/gpt-5.6-luna-20260709',
        status: 400,
        latencyMs: 363,
      },
      {
        provider: 'Azure',
        model: 'openai/gpt-5.6-luna-20260709',
        status: 400,
        latencyMs: 783,
      },
      {
        provider: 'Amazon Bedrock',
        model: 'openai/gpt-5.6-luna-20260709',
        status: 200,
        latencyMs: 622,
      },
    ]);
  });

  it('gives up after the last try', async () => {
    const fetchImpl = vi.fn(async () => new Response('', { status: 404 }));
    expect(
      await fetchGenerationAttempts({
        apiKey: 'k',
        baseURL: 'https://openrouter.ai/api/v1',
        generationId: 'gen-x',
        fetch: fetchImpl,
        sleep: async () => undefined,
        delaysMs: [0, 0],
      }),
    ).toBeUndefined();
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });
});

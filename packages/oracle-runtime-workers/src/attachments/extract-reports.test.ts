/**
 * Every request the extraction lane sends to the provider is reported
 * once (`ExtractionProvider.onModelCall`): answered, refused or failed on
 * the way, purpose `attachment`, platform-paid.
 */
import { describe, expect, it } from 'vitest';
import type { ModelCallReport } from '../llm/model-call';
import { extractText } from './extract';

const scan = {
  filename: 'scan.pdf',
  mimetype: 'application/pdf',
  eventId: '$scan',
};
const bytes = new Uint8Array([1, 2, 3]);

function provider(reports: ModelCallReport[]) {
  return {
    baseURL: 'https://llm.example/v1',
    apiKey: 'k',
    headers: {},
    model: 'vision/model',
    onModelCall: (call: ModelCallReport) => reports.push(call),
  };
}

function fetchOf(replies: Array<() => Response | Promise<Response>>) {
  let n = 0;
  const fetchImpl: typeof fetch = async () => {
    const next = replies[n];
    n += 1;
    if (!next) throw new Error('no reply');
    return next();
  };
  return fetchImpl;
}

describe('extraction call reports', () => {
  it('reports an answered request with the provider usage and cost', async () => {
    const reports: ModelCallReport[] = [];
    await extractText(bytes, scan, 'document', provider(reports), {
      fetchImpl: fetchOf([
        () =>
          Response.json({
            id: 'gen-1',
            model: 'vision/model-2026',
            provider: 'Google',
            choices: [{ message: { content: 'text' }, finish_reason: 'stop' }],
            usage: {
              prompt_tokens: 900,
              completion_tokens: 40,
              cost: 0.0004,
            },
          }),
      ]),
    });
    expect(reports).toHaveLength(1);
    expect(reports[0]).toMatchObject({
      role: 'vision',
      purpose: 'attachment',
      paidBy: 'platform',
      requestedModel: 'vision/model',
      servedModel: 'vision/model-2026',
      provider: 'Google',
      generationId: 'gen-1',
      promptTokens: 900,
      outputTokens: 40,
      costUsd: 0.0004,
      ok: true,
      finishReason: 'stop',
    });
    expect(typeof reports[0]?.callId).toBe('string');
  });

  it('reports both requests when one is retried without max_tokens', async () => {
    const reports: ModelCallReport[] = [];
    await extractText(bytes, scan, 'document', provider(reports), {
      raw: { maxChars: 1_000 },
      fetchImpl: fetchOf([
        () => new Response('max_tokens is not supported', { status: 400 }),
        () =>
          Response.json({
            choices: [{ message: { content: 'text' } }],
            usage: { prompt_tokens: 10, completion_tokens: 1, cost: 0.00001 },
          }),
      ]),
    });
    expect(reports.map((r) => [r.ok, r.errorStatus, r.costUsd])).toEqual([
      [false, 400, undefined],
      [true, undefined, 0.00001],
    ]);
    expect(new Set(reports.map((r) => r.callId)).size).toBe(2);
  });

  it('reports a refused request once and a network failure once', async () => {
    const reports: ModelCallReport[] = [];
    await expect(
      extractText(bytes, scan, 'image', provider(reports), {
        fetchImpl: fetchOf([() => new Response('busy', { status: 503 })]),
      }),
    ).rejects.toThrow('AI processing failed (503)');
    await expect(
      extractText(bytes, scan, 'image', provider(reports), {
        fetchImpl: fetchOf([
          () => Promise.reject(new TypeError('network connection lost')),
        ]),
      }),
    ).rejects.toThrow('network');
    expect(reports.map((r) => [r.ok, r.errorStatus ?? null])).toEqual([
      [false, 503],
      [false, null],
    ]);
  });

  it('never reports text read locally (no provider call)', async () => {
    const reports: ModelCallReport[] = [];
    await extractText(
      new TextEncoder().encode('hello'),
      { filename: 'a.txt', mimetype: 'text/plain', eventId: '$a' },
      'document',
      provider(reports),
    );
    expect(reports).toEqual([]);
  });

  it('a provider denied for the turn sends nothing and fails with its reason', async () => {
    const reports: ModelCallReport[] = [];
    let sent = 0;
    const error = await extractText(
      bytes,
      scan,
      'document',
      {
        ...provider(reports),
        deniedReason: 'Reading this file is not available.',
      },
      {
        fetchImpl: async () => {
          sent += 1;
          return Response.json({});
        },
      },
    ).then(
      () => undefined,
      (e: unknown) => e,
    );
    expect(String(error)).toContain('Reading this file is not available.');
    expect(sent).toBe(0);
    expect(reports).toHaveLength(0);
  });
});

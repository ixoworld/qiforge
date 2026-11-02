/**
 * Raw mode of `extractText` (document ingestion): truncation by the provider,
 * block-array replies, `max_tokens`, and the bounded plain-text decode.
 */
import { describe, expect, it } from 'vitest';
import {
  extractText,
  rawMaxTokens,
  MAX_RAW_COMPLETION_TOKENS,
} from './extract';

const PROVIDER = {
  baseURL: 'https://llm.example/v1',
  apiKey: 'k',
  headers: {},
  model: 'vision/model',
};
const scan = {
  filename: 'scan.pdf',
  mimetype: 'application/pdf',
  eventId: '$scan',
};
const bytes = new Uint8Array([1, 2, 3]);

type Body = { max_tokens?: number; messages: unknown[] };

function fakeFetch(replies: Array<() => Response>) {
  const bodies: Body[] = [];
  const fetchImpl: typeof fetch = async (_input, init) => {
    bodies.push(JSON.parse(String(init?.body)));
    const next = replies[Math.min(bodies.length, replies.length) - 1];
    if (!next) throw new Error('no reply');
    return next();
  };
  return { bodies, fetchImpl };
}

const reply = (choice: Record<string, unknown>) => () =>
  Response.json({ choices: [choice] });

describe('extractText raw: model lane', () => {
  it('reports truncated when the provider stopped at its length limit', async () => {
    const { fetchImpl } = fakeFetch([
      reply({ message: { content: 'cut off mid' }, finish_reason: 'length' }),
    ]);
    const result = await extractText(bytes, scan, 'document', PROVIDER, {
      fetchImpl,
      raw: { maxChars: 10_000 },
    });
    expect(result).toMatchObject({ text: 'cut off mid', truncated: true });
  });

  it('is not truncated on a normal stop', async () => {
    const { fetchImpl } = fakeFetch([
      reply({ message: { content: 'whole' }, finish_reason: 'stop' }),
    ]);
    const result = await extractText(bytes, scan, 'document', PROVIDER, {
      fetchImpl,
      raw: { maxChars: 10_000 },
    });
    expect(result).toMatchObject({ text: 'whole', truncated: false });
  });

  it('keeps only the text blocks of an array reply, never [object Object]', async () => {
    const { fetchImpl } = fakeFetch([
      reply({
        message: {
          content: [
            { type: 'text', text: 'alpha ' },
            { type: 'image_url', image_url: { url: 'data:x' } },
            { type: 'text', text: 'beta' },
          ],
        },
      }),
    ]);
    const result = await extractText(bytes, scan, 'document', PROVIDER, {
      fetchImpl,
      raw: { maxChars: 10_000 },
    });
    expect(result.text).toBe('alpha beta');
  });

  it('sends max_tokens matching the cap, bounded', async () => {
    const small = fakeFetch([reply({ message: { content: 'x' } })]);
    await extractText(bytes, scan, 'document', PROVIDER, {
      fetchImpl: small.fetchImpl,
      raw: { maxChars: 3000 },
    });
    expect(small.bodies[0]?.max_tokens).toBe(1000);
    const large = fakeFetch([reply({ message: { content: 'x' } })]);
    await extractText(bytes, scan, 'document', PROVIDER, {
      fetchImpl: large.fetchImpl,
      raw: { maxChars: 10_000_000 },
    });
    expect(large.bodies[0]?.max_tokens).toBe(MAX_RAW_COMPLETION_TOKENS);
    expect(rawMaxTokens(900)).toBe(300);
  });

  it('retries once without max_tokens when the provider rejects it', async () => {
    const { bodies, fetchImpl } = fakeFetch([
      () =>
        new Response('{"error":"max_tokens is too large for this model"}', {
          status: 400,
        }),
      reply({ message: { content: 'fine' } }),
    ]);
    const result = await extractText(bytes, scan, 'document', PROVIDER, {
      fetchImpl,
      raw: { maxChars: 3000 },
    });
    expect(result.text).toBe('fine');
    expect(bodies).toHaveLength(2);
    expect(bodies[0]?.max_tokens).toBe(1000);
    expect(bodies[1]).not.toHaveProperty('max_tokens');
  });

  it('does not retry an unrelated 400', async () => {
    const { bodies, fetchImpl } = fakeFetch([
      () => new Response('bad file', { status: 400 }),
    ]);
    await expect(
      extractText(bytes, scan, 'document', PROVIDER, {
        fetchImpl,
        raw: { maxChars: 3000 },
      }),
    ).rejects.toThrow(/AI processing failed \(400\)/);
    expect(bodies).toHaveLength(1);
  });

  it('leaves the chat-attachment request untouched: no max_tokens, wrapped text', async () => {
    const { bodies, fetchImpl } = fakeFetch([
      reply({ message: { content: 'hello' } }),
    ]);
    const result = await extractText(bytes, scan, 'document', PROVIDER, {
      fetchImpl,
    });
    expect(bodies[0]).not.toHaveProperty('max_tokens');
    expect(result.text).toBe('[Content of scan.pdf]:\nhello');
  });
});

describe('extractText raw: plain text', () => {
  const txt = { filename: 'n.txt', mimetype: 'text/plain', eventId: '$t' };

  it('cuts at maxChars and reports it', async () => {
    const result = await extractText(
      new TextEncoder().encode('0123456789'),
      txt,
      'document',
      null,
      { raw: { maxChars: 4 } },
    );
    expect(result).toEqual({ text: '0123', truncated: true });
  });

  it('decodes only the head of a huge file yet counts a multi-byte tail as truncated', async () => {
    const body = new TextEncoder().encode('€'.repeat(50_000));
    const result = await extractText(body, txt, 'document', null, {
      raw: { maxChars: 100 },
    });
    expect(result.text).toBe('€'.repeat(100));
    expect(result.truncated).toBe(true);
  });

  it('does not report truncation when the whole file fits', async () => {
    const result = await extractText(
      new TextEncoder().encode('short'),
      txt,
      'document',
      null,
      { raw: { maxChars: 100 } },
    );
    expect(result).toEqual({ text: 'short', truncated: false });
  });

  it('keeps the chat lane decode (whole file, wrapped, 50 000-char cap)', async () => {
    const result = await extractText(
      new TextEncoder().encode('x'.repeat(60_000)),
      txt,
      'document',
      null,
    );
    expect(result.text.startsWith('[Content of n.txt]:\n')).toBe(true);
    expect(result.text.endsWith('[...truncated]')).toBe(true);
  });
});

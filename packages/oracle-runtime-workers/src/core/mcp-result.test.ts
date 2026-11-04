import { describe, expect, it } from 'vitest';
import { withoutStructuredCopy } from './mcp-result';

const payload = { nodes: [{ uuid: 'u1', name: 'Alice' }], total: 1 };
const text = JSON.stringify(payload);

describe('withoutStructuredCopy', () => {
  it('gives the text of a block whose structured value is a copy of it', () => {
    expect(
      withoutStructuredCopy({
        type: 'text',
        source_type: 'text',
        text,
        structuredContent: payload,
      }),
    ).toBe(text);
  });

  it('counts a copy whatever the order of its keys or the layout of the text', () => {
    const pretty = JSON.stringify(payload, null, 2);
    expect(
      withoutStructuredCopy({
        type: 'text',
        text: pretty,
        structuredContent: { total: 1, nodes: payload.nodes },
      }),
    ).toBe(pretty);
  });

  it.each([
    ['a text that is not JSON', { text: 'Found 1 node' }],
    ['a summary of the data', { text: JSON.stringify({ total: 1 }) }],
    [
      'a list in another order',
      { text: JSON.stringify({ nodes: [], total: 1 }) },
    ],
  ])('keeps both for %s', (_name, { text: other }) => {
    const block = { type: 'text', text: other, structuredContent: payload };
    expect(withoutStructuredCopy(block)).toEqual(block);
  });

  it('keeps `meta`, dropping only the copy', () => {
    expect(
      withoutStructuredCopy({
        type: 'text',
        text,
        structuredContent: payload,
        meta: { requestId: 'r1' },
      }),
    ).toEqual({ type: 'text', text, meta: { requestId: 'r1' } });
  });

  it.each([
    ['a string', 'plain text'],
    ['a text block with nothing else', { type: 'text', text: 'no copy' }],
    [
      'a block of another type',
      { type: 'image', text, structuredContent: payload },
    ],
    [
      'several blocks',
      [
        { type: 'text', text: 'a' },
        { type: 'text', text: 'b' },
      ],
    ],
    ['a sandbox envelope', { success: true, exitCode: 0, output: 'done' }],
    ['null', null],
  ])('passes %s through', (_name, output) => {
    expect(withoutStructuredCopy(output)).toEqual(output);
  });
});

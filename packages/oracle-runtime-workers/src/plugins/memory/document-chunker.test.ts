import { describe, expect, it } from 'vitest';
import { chunkDocument, utf8ByteLength } from './document-chunker';

const encoder = new TextEncoder();

function expectAllWithin(chunks: Array<{ content: string }>, max: number) {
  for (const c of chunks) {
    expect(encoder.encode(c.content).length).toBeLessThanOrEqual(max);
    // No replacement character means no cut inside a UTF-8 sequence.
    expect(c.content).not.toContain('�');
  }
}

describe('utf8ByteLength', () => {
  it('matches TextEncoder for ASCII, 2-, 3- and 4-byte text and lone surrogates', () => {
    for (const s of ['abc', 'é', '日本語', '😀', 'a😀b', '\ud800', 'x\udc00']) {
      expect(utf8ByteLength(s)).toBe(encoder.encode(s).length);
    }
  });
});

describe('chunkDocument', () => {
  it('returns nothing for empty or whitespace input', () => {
    expect(chunkDocument('')).toEqual({
      chunks: [],
      truncated: false,
      totalBytes: 0,
    });
    expect(chunkDocument(' \n\t \r\n ').chunks).toEqual([]);
  });

  it('keeps a short document as one part and normalises newlines', () => {
    const out = chunkDocument('Line one\r\nLine two\r\n\r\n\r\n\r\nLine three');
    expect(out.chunks).toHaveLength(1);
    expect(out.chunks[0]).toEqual({
      index: 0,
      label: 'part 1 of 1',
      content: 'Line one\nLine two\n\nLine three',
    });
    expect(out.truncated).toBe(false);
    expect(out.totalBytes).toBe(29);
  });

  it('packs paragraphs and splits between them', () => {
    const para = 'a'.repeat(40);
    const text = [para, para, para, para].join('\n\n');
    const out = chunkDocument(text, { maxChunkBytes: 90, maxChunks: 64 });
    expect(out.chunks.map((c) => c.content)).toEqual([
      `${para}\n\n${para}`,
      `${para}\n\n${para}`,
    ]);
    expect(out.chunks.map((c) => c.label)).toEqual([
      'part 1 of 2',
      'part 2 of 2',
    ]);
  });

  it('splits an oversized paragraph on lines, then sentences', () => {
    const lines = Array.from(
      { length: 6 },
      (_, i) => `row ${i} ${'x'.repeat(30)}`,
    );
    const byLine = chunkDocument(lines.join('\n'), { maxChunkBytes: 80 });
    expectAllWithin(byLine.chunks, 80);
    expect(byLine.chunks.length).toBeGreaterThan(1);
    expect(byLine.chunks.join('')).not.toBe('');

    const sentences =
      'First sentence is here. Second one follows now. Third ends it!';
    const bySentence = chunkDocument(sentences, { maxChunkBytes: 30 });
    expectAllWithin(bySentence.chunks, 30);
    expect(bySentence.chunks.map((c) => c.content)).toEqual([
      'First sentence is here.',
      'Second one follows now.',
      'Third ends it!',
    ]);
  });

  it('hard-splits text with no boundary without cutting characters', () => {
    const text = '日本語'.repeat(50) + '😀'.repeat(40);
    const out = chunkDocument(text, { maxChunkBytes: 20 });
    expectAllWithin(out.chunks, 20);
    expect(out.chunks.map((c) => c.content).join('')).toBe(text);
  });

  it('never exceeds the cap with emoji at every offset', () => {
    for (let pad = 0; pad < 4; pad += 1) {
      const text = 'a'.repeat(pad) + '😀'.repeat(30);
      const out = chunkDocument(text, { maxChunkBytes: 10 });
      expectAllWithin(out.chunks, 10);
      expect(out.chunks.map((c) => c.content).join('')).toBe(text);
    }
  });

  it('labels parts by the page markers the PDF step emits', () => {
    const text = [
      '--- page 1 ---',
      'a'.repeat(50),
      '--- page 2 ---',
      'b'.repeat(50),
      '--- page 3 ---',
      'c'.repeat(50),
    ].join('\n');
    const out = chunkDocument(text, { maxChunkBytes: 140 });
    expect(out.chunks.map((c) => c.label)).toEqual(['p. 1–2', 'p. 3']);
  });

  it('labels parts by form feed page breaks and Page N lines', () => {
    const ff = chunkDocument(`one\fTwo\fthree`, { maxChunkBytes: 5 });
    expect(ff.chunks.map((c) => [c.label, c.content])).toEqual([
      ['p. 1', 'one'],
      ['p. 2', 'Two'],
      ['p. 3', 'three'],
    ]);

    const lines = chunkDocument('Page 4\nalpha\n\nPage 5 of 9\nbeta', {
      maxChunkBytes: 20,
    });
    expect(lines.chunks.map((c) => c.label)).toEqual(['p. 4', 'p. 5']);
  });

  it('does not treat a sentence that starts with "Page 3" as a marker', () => {
    const out = chunkDocument('Page 3 of the contract says the fee is due.');
    expect(out.chunks[0]?.label).toBe('part 1 of 1');
  });

  it('flags truncation and keeps the first maxChunks parts', () => {
    const text = Array.from(
      { length: 10 },
      (_, i) => `${i}${'z'.repeat(30)}`,
    ).join('\n\n');
    const out = chunkDocument(text, { maxChunkBytes: 40, maxChunks: 3 });
    expect(out.truncated).toBe(true);
    expect(out.chunks).toHaveLength(3);
    expect(out.chunks[0]?.label).toBe('part 1 of 10');
    expect(out.totalBytes).toBe(encoder.encode(text).length);
  });

  it('rejects unusable options', () => {
    expect(() => chunkDocument('x', { maxChunkBytes: 2 })).toThrow(RangeError);
    expect(() => chunkDocument('x', { maxChunks: 0 })).toThrow(RangeError);
  });

  it('splits a long run of spaces without whitespace-only chunks', () => {
    const out = chunkDocument(`a${' '.repeat(50)}b`, { maxChunkBytes: 20 });
    expectAllWithin(out.chunks, 20);
    for (const c of out.chunks) expect(c.content.trim()).not.toBe('');
    expect(out.chunks.map((c) => c.content.replace(/\s/g, '')).join('')).toBe(
      'ab',
    );
  });

  it('handles 400 000 spaces and trailing-space lines in under 50 ms each', () => {
    const inputs = [
      `a${' '.repeat(400_000)}b`,
      ' '.repeat(400_000),
      `${'x '.repeat(100_000)}\n${' \t'.repeat(100_000)}\nend`,
    ];
    for (const input of inputs) {
      const started = performance.now();
      const out = chunkDocument(input);
      expect(performance.now() - started).toBeLessThan(50);
      expectAllWithin(out.chunks, 12_000);
      for (const c of out.chunks) expect(c.content.trim()).not.toBe('');
    }
  });

  it('keeps no chunk that only names a page', () => {
    const out = chunkDocument(
      '--- page 1 ---\nHello\n\n--- page 2 ---\n\n--- page 3 ---\nWorld',
      { maxChunkBytes: 20 },
    );
    expectAllWithin(out.chunks, 20);
    for (const c of out.chunks) {
      expect(c.content.replace(/--- page \d+ ---/g, '').trim()).not.toBe('');
    }
    expect(out.chunks.map((c) => c.content).join('\n')).toContain('Hello');
    expect(out.chunks.map((c) => c.content).join('\n')).toContain('World');
  });

  it('does not strand a page marker in front of a part that fills a whole chunk', () => {
    const big = 'w'.repeat(40);
    const out = chunkDocument(`--- page 2 ---\n${big}`, { maxChunkBytes: 40 });
    for (const c of out.chunks) {
      expect(c.content.replace(/--- page \d+ ---/g, '').trim()).not.toBe('');
    }
    expect(out.chunks.map((c) => c.content).join('')).toContain(big);
  });

  it('drops a trailing marker with nothing after it', () => {
    const out = chunkDocument('--- page 1 ---\nHello\n\n--- page 2 ---');
    expect(out.chunks).toHaveLength(1);
    expect(out.chunks[0]?.content).toContain('Hello');
  });

  it('does not treat "See p. 12" in plain notes as a page marker', () => {
    const out = chunkDocument(
      'Office: Harbour Street\n\nSee p. 12\n\nRefunds: 14 days',
      { maxChunkBytes: 30 },
    );
    expect(out.chunks.every((c) => c.label.startsWith('part '))).toBe(true);
  });

  it('splits emoji only between code points and a lone surrogate without exceeding the cap', () => {
    const emoji = chunkDocument('😀'.repeat(10), { maxChunkBytes: 6 });
    expectAllWithin(emoji.chunks, 6);
    expect(emoji.chunks.map((c) => c.content).join('')).toBe('😀'.repeat(10));
    const lone = chunkDocument('ab\ud800cd', { maxChunkBytes: 4 });
    for (const c of lone.chunks) {
      expect(utf8ByteLength(c.content)).toBeLessThanOrEqual(4);
    }
  });
});

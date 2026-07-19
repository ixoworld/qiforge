import { describe, expect, it } from 'vitest';
import { classifyAttachment } from './classify.js';

describe('classifyAttachment', () => {
  it('classifies plain text by mime or extension', () => {
    expect(
      classifyAttachment({ mimetype: 'text/plain', filename: 'a.txt' }),
    ).toBe('text');
    expect(
      classifyAttachment({ mimetype: 'text/csv', filename: 'a.csv' }),
    ).toBe('text');
    expect(
      classifyAttachment({ mimetype: 'application/json', filename: 'a.json' }),
    ).toBe('text');
    expect(
      classifyAttachment({ mimetype: 'text/markdown', filename: 'r.md' }),
    ).toBe('text');
    // generic mime → extension wins
    expect(
      classifyAttachment({
        mimetype: 'application/octet-stream',
        filename: 'data.csv',
      }),
    ).toBe('text');
  });

  it('classifies office/pdf as document', () => {
    expect(
      classifyAttachment({ mimetype: 'application/pdf', filename: 'r.pdf' }),
    ).toBe('document');
    expect(
      classifyAttachment({
        mimetype:
          'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
        filename: 'r.docx',
      }),
    ).toBe('document');
    expect(
      classifyAttachment({
        mimetype: 'application/octet-stream',
        filename: 'sheet.xlsx',
      }),
    ).toBe('document');
  });

  it('classifies images/audio/video by mime or extension', () => {
    expect(
      classifyAttachment({ mimetype: 'image/png', filename: 'p.png' }),
    ).toBe('image');
    expect(
      classifyAttachment({
        mimetype: 'application/octet-stream',
        filename: 'p.jpg',
      }),
    ).toBe('image');
    expect(
      classifyAttachment({ mimetype: 'audio/mpeg', filename: 'a.mp3' }),
    ).toBe('audio');
    expect(
      classifyAttachment({ mimetype: 'video/mp4', filename: 'v.mp4' }),
    ).toBe('video');
  });

  it('falls back to unknown for unrecognised binary', () => {
    expect(
      classifyAttachment({
        mimetype: 'application/octet-stream',
        filename: 'mystery.bin',
      }),
    ).toBe('unknown');
  });

  it('is case-insensitive on mime and extension', () => {
    expect(
      classifyAttachment({ mimetype: 'IMAGE/PNG', filename: 'P.PNG' }),
    ).toBe('image');
  });
});

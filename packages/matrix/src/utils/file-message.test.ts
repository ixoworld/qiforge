import { describe, expect, it } from 'vitest';
import { buildFileMessageContent } from './file-message.js';

describe('buildFileMessageContent', () => {
  it('builds a plain-room file event with a direct url', () => {
    const content = buildFileMessageContent({
      filename: 'response.md',
      mimetype: 'text/markdown',
      size: 1234,
      url: 'mxc://example.org/abc',
    });

    expect(content).toEqual({
      msgtype: 'm.file',
      body: 'response.md',
      filename: 'response.md',
      info: { mimetype: 'text/markdown', size: 1234 },
      'm.mentions': {},
      url: 'mxc://example.org/abc',
    });
  });

  it('builds an encrypted-room file event carrying the full encryption envelope', () => {
    const envelope = {
      url: 'mxc://example.org/enc',
      key: { alg: 'A256CTR', k: 'k' },
      iv: 'iv',
      hashes: { sha256: 'h' },
      v: 'v2',
    };
    const content = buildFileMessageContent({
      filename: 'report.html',
      mimetype: 'text/html',
      size: 42,
      encryptedFile: envelope,
    });

    expect(content.file).toEqual(envelope);
    expect(content).not.toHaveProperty('url');
    expect(content.info).toEqual({ mimetype: 'text/html', size: 42 });
  });

  it('attaches to a thread with the same relation block as text sends', () => {
    const content = buildFileMessageContent({
      filename: 'a.md',
      mimetype: 'text/markdown',
      size: 1,
      threadId: '$root',
      url: 'mxc://example.org/abc',
    });

    expect(content['m.relates_to']).toEqual({
      event_id: '$root',
      is_falling_back: true,
      'm.in_reply_to': { event_id: '$root' },
      rel_type: 'm.thread',
    });
  });

  it('uses an explicit body override when provided', () => {
    const content = buildFileMessageContent({
      filename: 'a.md',
      mimetype: 'text/markdown',
      size: 1,
      body: 'Full response attached',
      url: 'mxc://example.org/abc',
    });

    expect(content.body).toBe('Full response attached');
    expect(content.filename).toBe('a.md');
  });

  it('rejects ambiguous input: both or neither of url/encryptedFile', () => {
    expect(() =>
      buildFileMessageContent({
        filename: 'a.md',
        mimetype: 'text/markdown',
        size: 1,
      }),
    ).toThrow(/exactly one/);

    expect(() =>
      buildFileMessageContent({
        filename: 'a.md',
        mimetype: 'text/markdown',
        size: 1,
        url: 'mxc://example.org/abc',
        encryptedFile: { url: 'mxc://example.org/enc' },
      }),
    ).toThrow(/exactly one/);
  });
});

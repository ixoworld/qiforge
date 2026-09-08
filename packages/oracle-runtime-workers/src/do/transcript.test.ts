/**
 * Transcript rendering around attachment payload retention: an offloaded
 * message still lists its attachment metadata with its original text, and
 * the `view_attachment` re-attachment message never shows.
 */
import { AIMessage, HumanMessage } from '@langchain/core/messages';
import { describe, expect, it } from 'vitest';
import { ATTACHMENT_VIEW_SOURCE, offloadInlinePayloads } from '../attachments';
import { contentToText, transformTranscript } from './transcript';

const META = {
  filename: 'red.png',
  mimetype: 'image/png',
  size: 12,
  mxcUri: 'mxc://hs/red',
  category: 'image',
};
const IMAGE_BLOCK = {
  type: 'image',
  source_type: 'base64',
  mime_type: 'image/png',
  data: 'AAAA',
};

describe('transcript + attachment retention', () => {
  it('renders an offloaded message exactly like the inline one', async () => {
    const inline = new HumanMessage({
      id: 'h1',
      content: [{ type: 'text', text: 'what colour?' }, IMAGE_BLOCK],
      additional_kwargs: {
        attachment: META,
        attachments: [META],
        timestamp: 't',
      },
    });
    const offloaded = offloadInlinePayloads(inline)!;
    const before = await transformTranscript([
      inline,
      new AIMessage({ id: 'a1', content: 'red' }),
    ]);
    const after = await transformTranscript([
      offloaded,
      new AIMessage({ id: 'a1', content: 'red' }),
    ]);
    expect(after).toEqual(before);
    expect(after.messages[0]).toMatchObject({
      type: 'human',
      content: 'what colour?',
      attachment: META,
      attachments: [META],
    });
    expect(contentToText(offloaded.content)).toBe('what colour?');
  });

  it('hides the re-attachment message view_attachment adds', async () => {
    const out = await transformTranscript([
      new HumanMessage({ id: 'h2', content: 'look again' }),
      new HumanMessage({
        id: 'v1',
        content: [{ type: 'text', text: 'Re-attached "red.png"' }, IMAGE_BLOCK],
        additional_kwargs: {
          lc_source: ATTACHMENT_VIEW_SOURCE,
          attachments: [META],
        },
      }),
      new AIMessage({ id: 'a2', content: 'still red' }),
    ]);
    expect(out.messages.map((m) => [m.type, m.content])).toEqual([
      ['human', 'look again'],
      ['ai', 'still red'],
    ]);
  });
});

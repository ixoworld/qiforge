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

describe('isSummarizationMessage', () => {
  it('matches the LangChain 1.4 summary message (a tagged human message with the prefix) and the older shapes', async () => {
    const { HumanMessage, SystemMessage, AIMessage } =
      await import('@langchain/core/messages');
    const { isSummarizationMessage } = await import('./transcript');
    const { SUMMARY_PREFIX } =
      await import('../core/middlewares/summarization');
    expect(
      isSummarizationMessage(
        new HumanMessage({
          content: `${SUMMARY_PREFIX}\n\n**Active task**: …`,
          additional_kwargs: { lc_source: 'summarization' },
        }),
      ),
    ).toBe(true);
    expect(
      isSummarizationMessage(
        new HumanMessage({ content: `${SUMMARY_PREFIX} the user asked…` }),
      ),
    ).toBe(true);
    expect(
      isSummarizationMessage(
        new SystemMessage('Here is a summary of the conversation so far: …'),
      ),
    ).toBe(true);
    expect(
      isSummarizationMessage(new HumanMessage('Turn 3: call list_my_tasks')),
    ).toBe(false);
    expect(
      isSummarizationMessage(
        new AIMessage('Sure — here is a summary of the article you sent.'),
      ),
    ).toBe(false);
  });
});

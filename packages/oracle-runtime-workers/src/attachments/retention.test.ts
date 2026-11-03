/**
 * The attachment placeholder: the copy the checkpointer stores in place of a
 * message with inline bytes (`src/sqlite/inline-payloads.ts`). Pure
 * functions over LangChain messages (no platform APIs).
 */
import { AIMessage, HumanMessage } from '@langchain/core/messages';
import { describe, expect, it } from 'vitest';
import {
  ATTACHMENT_PLACEHOLDER_PREFIX,
  ATTACHMENT_VIEW_SOURCE,
  buildPlaceholderText,
  hasInlinePayload,
  isAttachmentPlaceholderText,
  isAttachmentViewMessage,
  offloadInlinePayloads,
} from './retention';

const META = {
  filename: 'red.png',
  mimetype: 'image/png',
  size: 1234,
  mxcUri: 'mxc://hs/abc',
  category: 'image',
};
const IMAGE_BLOCK = {
  type: 'image',
  source_type: 'base64',
  mime_type: 'image/png',
  data: 'AAAA',
};

function imageTurn(id: string | undefined, text: string): HumanMessage {
  return new HumanMessage({
    id,
    content: [{ type: 'text', text }, IMAGE_BLOCK],
    additional_kwargs: {
      attachment: META,
      attachments: [META],
      timestamp: 't',
    },
  });
}
const textTurn = (id: string, text: string): HumanMessage =>
  new HumanMessage({ id, content: text });
const viewMessage = (id: string): HumanMessage =>
  new HumanMessage({
    id,
    content: [{ type: 'text', text: 'Re-attached "red.png"' }, IMAGE_BLOCK],
    additional_kwargs: {
      lc_source: ATTACHMENT_VIEW_SOURCE,
      attachments: [META],
    },
  });

describe('offloadInlinePayloads / buildPlaceholderText', () => {
  it('replaces the inline block by a placeholder naming view_attachment, kwargs and the original untouched', () => {
    const message = imageTurn('h1', 'first');
    const rewritten = offloadInlinePayloads(message)!;
    expect(rewritten.type).toBe('human');
    expect(rewritten.id).toBe('h1');
    expect(hasInlinePayload(rewritten)).toBe(false);
    const blocks = rewritten.content as Array<{ type: string; text?: string }>;
    expect(blocks.map((b) => b.type)).toEqual(['text', 'text']);
    expect(blocks[0]!.text).toBe('first');
    const placeholder = blocks[1]!.text!;
    expect(isAttachmentPlaceholderText(placeholder)).toBe(true);
    expect(placeholder).toContain('not stored with the conversation');
    expect(placeholder).not.toContain('user turns');
    expect(placeholder).toContain('"red.png" (image/png, 1 KB)');
    expect(placeholder).toContain('ref: mxc://hs/abc');
    expect(placeholder).toContain('call view_attachment with its ref');
    // Metadata the transcript renders from is untouched.
    expect(rewritten.additional_kwargs).toEqual(message.additional_kwargs);
    // The original is not mutated.
    expect(hasInlinePayload(message)).toBe(true);
  });

  it('keeps the re-attachment marker and the speaker name', () => {
    const view = offloadInlinePayloads(viewMessage('v1'))!;
    expect(isAttachmentViewMessage(view)).toBe(true);
    expect(hasInlinePayload(view)).toBe(false);
    const named = offloadInlinePayloads(
      new HumanMessage({
        id: 'n',
        name: 'alice',
        content: [{ type: 'text', text: 'hi' }, IMAGE_BLOCK],
        additional_kwargs: { attachments: [META] },
      }),
    )!;
    expect(named.name).toBe('alice');
  });

  it('leaves a message that is not a human message alone', () => {
    expect(
      offloadInlinePayloads(
        new AIMessage({
          id: 'a',
          content: [{ type: 'text', text: 'x' }, IMAGE_BLOCK],
        }),
      ),
    ).toBeNull();
  });

  it('returns null for messages without an inline payload', () => {
    expect(offloadInlinePayloads(textTurn('h', 'plain'))).toBeNull();
    expect(
      offloadInlinePayloads(
        new HumanMessage({
          id: 'h',
          content: [{ type: 'text', text: 'blocks only' }],
        }),
      ),
    ).toBeNull();
  });

  it('collapses several inline blocks into one placeholder and keeps the id', () => {
    const message = new HumanMessage({
      id: 'multi',
      content: [
        { type: 'text', text: 'two files' },
        IMAGE_BLOCK,
        {
          type: 'file',
          source_type: 'base64',
          mime_type: 'application/pdf',
          data: 'BBBB',
          filename: 'doc.pdf',
        },
      ],
      additional_kwargs: {
        attachments: [
          META,
          {
            filename: 'doc.pdf',
            mimetype: 'application/pdf',
            category: 'document',
          },
        ],
      },
    });
    const rewritten = offloadInlinePayloads(message)!;
    expect(rewritten.id).toBe('multi');
    const blocks = rewritten.content as Array<{ type: string; text?: string }>;
    expect(blocks).toHaveLength(2);
    expect(blocks[1]!.text).toContain('1. "red.png"');
    expect(blocks[1]!.text).toContain(
      '2. "doc.pdf" (application/pdf) — no reference',
    );
  });

  it('explains when no metadata was recorded', () => {
    const text = buildPlaceholderText([]);
    expect(text.startsWith(ATTACHMENT_PLACEHOLDER_PREFIX)).toBe(true);
    expect(text).toContain('cannot be fetched again');
  });
});

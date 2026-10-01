/**
 * Attachment payload retention — window selection, the placeholder rewrite,
 * idempotence and the re-attachment message's turn membership. Pure
 * functions over LangChain messages (no platform APIs).
 */
import { AIMessage, HumanMessage } from '@langchain/core/messages';
import { describe, expect, it } from 'vitest';
import {
  applyAttachmentRetention,
  ATTACHMENT_PLACEHOLDER_PREFIX,
  ATTACHMENT_VIEW_SOURCE,
  buildPlaceholderText,
  hasInlinePayload,
  isAttachmentPlaceholderText,
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
const ai = (id: string): AIMessage => new AIMessage({ id, content: 'ok' });
const viewMessage = (id: string): HumanMessage =>
  new HumanMessage({
    id,
    content: [{ type: 'text', text: 'Re-attached "red.png"' }, IMAGE_BLOCK],
    additional_kwargs: {
      lc_source: ATTACHMENT_VIEW_SOURCE,
      attachments: [META],
    },
  });

describe('applyAttachmentRetention', () => {
  it('keeps the newest N user turns inline and rewrites older payloads', () => {
    const messages = [
      imageTurn('h1', 'first'),
      ai('a1'),
      imageTurn('h2', 'second'),
      ai('a2'),
      textTurn('h3', 'third'),
      ai('a3'),
    ];
    const { retainedIds, rewrites } = applyAttachmentRetention(messages, 2);
    expect([...retainedIds]).toEqual(['h2']);
    expect(rewrites.map((m) => m.id)).toEqual(['h1']);
    const rewritten = rewrites[0]!;
    expect(rewritten.type).toBe('human');
    expect(hasInlinePayload(rewritten)).toBe(false);
    expect(Array.isArray(rewritten.content)).toBe(true);
    const blocks = rewritten.content as Array<{ type: string; text?: string }>;
    expect(blocks.map((b) => b.type)).toEqual(['text', 'text']);
    expect(blocks[0]!.text).toBe('first');
    const placeholder = blocks[1]!.text!;
    expect(isAttachmentPlaceholderText(placeholder)).toBe(true);
    expect(placeholder).toContain('"red.png" (image/png, 1 KB)');
    expect(placeholder).toContain('ref: mxc://hs/abc');
    expect(placeholder).toContain('view_attachment');
    // Metadata the transcript renders from is untouched.
    expect(rewritten.additional_kwargs).toEqual(messages[0]!.additional_kwargs);
    // The original is not mutated.
    expect(hasInlinePayload(messages[0]!)).toBe(true);
  });

  it('is idempotent: a rewritten message is never selected again', () => {
    const first = applyAttachmentRetention(
      [
        imageTurn('h1', 'a'),
        ai('a1'),
        textTurn('h2', 'b'),
        ai('a2'),
        textTurn('h3', 'c'),
        ai('a3'),
      ],
      2,
    );
    expect(first.rewrites).toHaveLength(1);
    const second = applyAttachmentRetention(
      [
        first.rewrites[0]!,
        ai('a1'),
        textTurn('h2', 'b'),
        ai('a2'),
        textTurn('h3', 'c'),
        ai('a3'),
      ],
      2,
    );
    expect(second.rewrites).toHaveLength(0);
    expect(second.retainedIds.size).toBe(0);
  });

  it('counts a re-attachment message with the user turn it followed', () => {
    const base = [
      imageTurn('h1', 'first'),
      ai('a1'),
      textTurn('h2', 'look again'),
      viewMessage('v1'),
      ai('a2'),
      textTurn('h3', 'thanks'),
      ai('a3'),
    ];
    // h3 = turn 1, v1 belongs to h2 = turn 2 → still inline; h1 = turn 3 → out.
    const inWindow = applyAttachmentRetention(base, 2);
    expect([...inWindow.retainedIds]).toEqual(['v1']);
    expect(inWindow.rewrites.map((m) => m.id)).toEqual(['h1']);
    // One more user turn pushes the re-attachment out as well.
    const later = applyAttachmentRetention(
      [...base, textTurn('h4', 'more'), ai('a4')],
      2,
    );
    expect(later.retainedIds.size).toBe(0);
    expect(later.rewrites.map((m) => m.id).sort()).toEqual(['h1', 'v1']);
  });

  it('leaves messages without an id alone (they cannot be rewritten in place)', () => {
    const { retainedIds, rewrites } = applyAttachmentRetention(
      [
        imageTurn(undefined, 'x'),
        ai('a1'),
        textTurn('h2', 'y'),
        ai('a2'),
        textTurn('h3', 'z'),
      ],
      1,
    );
    expect(retainedIds.size).toBe(0);
    expect(rewrites).toHaveLength(0);
  });
});

describe('offloadInlinePayloads / buildPlaceholderText', () => {
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

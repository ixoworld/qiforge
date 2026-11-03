/**
 * Attachment recall: the images of the newest two user turns go back into
 * the request when their message was loaded with the placeholder; documents
 * never; at most four per request; one fetch per reference per run; a
 * failure leaves the placeholder; nothing for a model without image input.
 */
import {
  AIMessage,
  HumanMessage,
  type BaseMessage,
} from '@langchain/core/messages';
import { describe, expect, it, vi } from 'vitest';
import type { NativeAttachment } from '../../attachments/content-blocks';
import {
  ATTACHMENT_VIEW_SOURCE,
  hasInlinePayload,
  isAttachmentPlaceholderText,
  offloadInlinePayloads,
} from '../../attachments/retention';
import type { AttachmentMeta } from '../../sqlite/serialization';
import {
  ATTACHMENT_RECALL_MAX_IMAGES,
  createAttachmentRecaller,
  type RecallImageLoader,
} from './attachment-recall';

function image(ref: string): AttachmentMeta {
  return {
    filename: `${ref}.png`,
    mimetype: 'image/png',
    eventId: ref,
    category: 'image',
  };
}

const PDF: AttachmentMeta = {
  filename: 'report.pdf',
  mimetype: 'application/pdf',
  eventId: '$pdf',
  category: 'document',
};

/** A human turn as the checkpoint stores it (placeholder, metadata kept). */
function storedTurn(
  id: string,
  metas: AttachmentMeta[],
  extra: Record<string, unknown> = {},
): HumanMessage {
  const live = new HumanMessage({
    id,
    content: [
      { type: 'text', text: `turn ${id}` },
      ...metas.map((meta) => ({
        type: meta.category === 'image' ? 'image' : 'file',
        source_type: 'base64',
        mime_type: meta.mimetype,
        data: 'AAAA',
      })),
    ],
    additional_kwargs: { attachments: metas, ...extra },
  });
  const stored = offloadInlinePayloads(live);
  if (!stored) throw new Error('expected an inline payload');
  return stored;
}

const text = (id: string): HumanMessage =>
  new HumanMessage({ id, content: `plain ${id}` });
const reply = (id: string): AIMessage =>
  new AIMessage({ id, content: `reply ${id}` });

function native(ref: string): NativeAttachment {
  return {
    kind: 'image',
    mimeType: 'image/jpeg',
    base64: `IMG-${ref}`,
    filename: `${ref}.png`,
  };
}

function loader() {
  return vi.fn<RecallImageLoader>(async (meta) =>
    meta.eventId ? native(meta.eventId) : null,
  );
}

function logger() {
  return { log: vi.fn(), warn: vi.fn(), error: vi.fn() };
}

function blocksOf(
  message: BaseMessage | undefined,
): Array<Record<string, unknown>> {
  if (!Array.isArray(message?.content)) return [];
  const blocks: Array<Record<string, unknown>> = [];
  for (const block of message.content)
    if (typeof block === 'object' && block !== null) blocks.push({ ...block });
  return blocks;
}

function recalledData(message: BaseMessage | undefined): unknown[] {
  return blocksOf(message)
    .filter((block) => block.type === 'image')
    .map((block) => block.data);
}

function placeholderText(message: BaseMessage | undefined): string | undefined {
  const block = blocksOf(message).find(
    (b) => typeof b.text === 'string' && isAttachmentPlaceholderText(b.text),
  );
  return typeof block?.text === 'string' ? block.text : undefined;
}

describe('attachment recall', () => {
  it('re-attaches the images of the newest two user turns, not older ones, in the request only', async () => {
    const loadImage = loader();
    const recaller = createAttachmentRecaller({ loadImage, imageInput: true });
    const old = storedTurn('h1', [image('$old')]);
    const recent = storedTurn('h2', [image('$recent')]);
    const messages = [old, reply('a1'), recent, reply('a2'), text('h3')];
    const out = await recaller.recall(messages);

    expect(loadImage).toHaveBeenCalledTimes(1);
    expect(loadImage.mock.calls[0]![0]).toEqual(image('$recent'));
    expect(out).not.toBe(messages);
    expect(out[0]).toBe(old);
    expect(recalledData(out[2])).toEqual(['IMG-$recent']);
    // Every image came back: no placeholder is left on that message.
    expect(placeholderText(out[2])).toBeUndefined();
    expect(out[2]!.id).toBe('h2');
    expect(out[2]!.additional_kwargs).toEqual(recent.additional_kwargs);
    // The stored message itself is untouched.
    expect(hasInlinePayload(recent)).toBe(false);
    expect(placeholderText(recent)).toBeDefined();
  });

  it('counts a re-attachment message with the user turn before it', async () => {
    const loadImage = loader();
    const recaller = createAttachmentRecaller({ loadImage, imageInput: true });
    const view = storedTurn('v1', [image('$viewed')], {
      lc_source: ATTACHMENT_VIEW_SOURCE,
    });
    // h1 (with v1) is turn 2 → in the window; h0 is turn 3 → out.
    const messages = [
      storedTurn('h0', [image('$older')]),
      reply('a0'),
      text('h1'),
      view,
      reply('a1'),
      text('h2'),
    ];
    const out = await recaller.recall(messages);
    expect(loadImage).toHaveBeenCalledTimes(1);
    expect(recalledData(out[3])).toEqual(['IMG-$viewed']);
    expect(out[3]!.additional_kwargs.lc_source).toBe(ATTACHMENT_VIEW_SOURCE);
  });

  it('never recalls a document; its placeholder stays and lists it alone', async () => {
    const loadImage = loader();
    const recaller = createAttachmentRecaller({ loadImage, imageInput: true });
    const both = storedTurn('h1', [image('$pic'), PDF]);
    const onlyPdf = storedTurn('h2', [PDF]);
    const out = await recaller.recall([both, reply('a1'), onlyPdf]);
    expect(loadImage).toHaveBeenCalledTimes(1);
    expect(loadImage.mock.calls[0]![0]).toEqual(image('$pic'));
    expect(out[2]).toBe(onlyPdf);
    expect(recalledData(out[0])).toEqual(['IMG-$pic']);
    const left = placeholderText(out[0]);
    expect(left).toContain('"report.pdf"');
    expect(left).not.toContain('$pic.png');
  });

  it('recalls at most four images per request, newest first', async () => {
    const loadImage = loader();
    const recaller = createAttachmentRecaller({ loadImage, imageInput: true });
    const older = storedTurn('h1', [image('$1'), image('$2'), image('$3')]);
    const newer = storedTurn('h2', [image('$4'), image('$5'), image('$6')]);
    const out = await recaller.recall([older, reply('a1'), newer]);
    expect(loadImage).toHaveBeenCalledTimes(ATTACHMENT_RECALL_MAX_IMAGES);
    expect(recalledData(out[2])).toEqual(['IMG-$4', 'IMG-$5', 'IMG-$6']);
    expect(recalledData(out[0])).toEqual(['IMG-$1']);
    const left = placeholderText(out[0]);
    expect(left).toContain('$2.png');
    expect(left).toContain('$3.png');
  });

  it('fetches each image once per run across the tool loop', async () => {
    const loadImage = loader();
    const recaller = createAttachmentRecaller({ loadImage, imageInput: true });
    const turn = storedTurn('h1', [image('$pic')]);
    const first = await recaller.recall([turn]);
    const second = await recaller.recall([
      turn,
      new AIMessage({
        id: 'a1',
        content: '',
        tool_calls: [{ id: 'c1', name: 'search', args: {} }],
      }),
    ]);
    expect(loadImage).toHaveBeenCalledTimes(1);
    expect(recalledData(first[0])).toEqual(['IMG-$pic']);
    expect(recalledData(second[0])).toEqual(['IMG-$pic']);
  });

  it('leaves the placeholder when the fetch fails or finds nothing, and logs once per reference', async () => {
    const log = logger();
    const loadImage = vi.fn<RecallImageLoader>(async (meta) => {
      if (meta.eventId === '$gone') return null;
      throw new Error('gateway unreachable');
    });
    const recaller = createAttachmentRecaller({
      loadImage,
      imageInput: true,
      logger: log,
    });
    const messages = [
      storedTurn('h1', [image('$gone')]),
      reply('a1'),
      storedTurn('h2', [image('$broken')]),
    ];
    expect(await recaller.recall(messages)).toBe(messages);
    expect(await recaller.recall(messages)).toBe(messages);
    expect(loadImage).toHaveBeenCalledTimes(2);
    expect(log.warn).toHaveBeenCalledTimes(2);
    expect(log.warn.mock.calls.map(([line]) => String(line))).toEqual(
      expect.arrayContaining([
        expect.stringContaining('$broken failed (gateway unreachable)'),
        expect.stringContaining('$gone is not available'),
      ]),
    );
  });

  it('gives every fetch a deadline', async () => {
    const loadImage = vi.fn<RecallImageLoader>(
      (_meta, signal) =>
        new Promise((_resolve, reject) => {
          signal.addEventListener('abort', () => reject(signal.reason));
        }),
    );
    const recaller = createAttachmentRecaller({
      loadImage,
      imageInput: true,
      timeoutMs: 20,
    });
    const messages = [storedTurn('h1', [image('$slow')])];
    expect(await recaller.recall(messages)).toBe(messages);
    expect(loadImage.mock.calls[0]![1].aborted).toBe(true);
  });

  it('does nothing for a model without image input, or a message still holding its bytes', async () => {
    const loadImage = loader();
    const messages = [storedTurn('h1', [image('$pic')])];
    const textOnly = createAttachmentRecaller({
      loadImage,
      imageInput: false,
    });
    expect(await textOnly.recall(messages)).toBe(messages);

    const live = new HumanMessage({
      id: 'h2',
      content: [
        { type: 'text', text: 'this turn' },
        {
          type: 'image',
          source_type: 'base64',
          mime_type: 'image/png',
          data: 'AAAA',
        },
      ],
      additional_kwargs: { attachments: [image('$live')] },
    });
    const vision = createAttachmentRecaller({ loadImage, imageInput: true });
    const current = [live];
    expect(await vision.recall(current)).toBe(current);
    expect(loadImage).not.toHaveBeenCalled();
  });
});

/**
 * Attachment recall: the images of the newest two user turns go back into
 * the request when their message was loaded with the placeholder; documents
 * never; at most four per request, fetched one at a time, newest first,
 * within a per-image and a per-request size cap; never an image the request
 * already holds as bytes or the same file twice; finished images come from
 * the shared LRU on later runs; a failure leaves the placeholder; a provider
 * refusal is retried once without the images; nothing for a model without
 * image input.
 */
import {
  AIMessage,
  HumanMessage,
  type BaseMessage,
} from '@langchain/core/messages';
import type { AgentMiddleware } from 'langchain';
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
  ATTACHMENT_RECALL_MAX_IMAGE_BYTES,
  ATTACHMENT_RECALL_MAX_IMAGES,
  createAttachmentRecaller,
  createAttachmentRecallMiddleware,
  RecalledImageCache,
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
    const { messages: out } = await recaller.recall(messages);

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
    const { messages: out } = await recaller.recall(messages);
    expect(loadImage).toHaveBeenCalledTimes(1);
    expect(recalledData(out[3])).toEqual(['IMG-$viewed']);
    expect(out[3]!.additional_kwargs.lc_source).toBe(ATTACHMENT_VIEW_SOURCE);
  });

  it('never recalls a document; its placeholder stays and lists it alone', async () => {
    const loadImage = loader();
    const recaller = createAttachmentRecaller({ loadImage, imageInput: true });
    const both = storedTurn('h1', [image('$pic'), PDF]);
    const onlyPdf = storedTurn('h2', [PDF]);
    const { messages: out } = await recaller.recall([
      both,
      reply('a1'),
      onlyPdf,
    ]);
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
    const { messages: out } = await recaller.recall([
      older,
      reply('a1'),
      newer,
    ]);
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
    const { messages: first } = await recaller.recall([turn]);
    const { messages: second } = await recaller.recall([
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
    expect((await recaller.recall(messages)).messages).toBe(messages);
    expect((await recaller.recall(messages)).messages).toBe(messages);
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
      (_meta, { signal }) =>
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
    expect((await recaller.recall(messages)).messages).toBe(messages);
    expect(loadImage.mock.calls[0]![1].signal.aborted).toBe(true);
  });

  it('does nothing for a model without image input, or a message still holding its bytes', async () => {
    const loadImage = loader();
    const messages = [storedTurn('h1', [image('$pic')])];
    const textOnly = createAttachmentRecaller({
      loadImage,
      imageInput: false,
    });
    expect((await textOnly.recall(messages)).messages).toBe(messages);

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
    expect((await vision.recall(current)).messages).toBe(current);
    expect(loadImage).not.toHaveBeenCalled();
  });
});

describe('attachment recall limits', () => {
  it('skips an image whose recorded size is over the cap without fetching it, and caps a download of unknown size', async () => {
    const log = logger();
    const loadImage = loader();
    const recaller = createAttachmentRecaller({
      loadImage,
      imageInput: true,
      logger: log,
    });
    const big = {
      ...image('$big'),
      size: ATTACHMENT_RECALL_MAX_IMAGE_BYTES + 1,
    };
    const unknown = image('$unknown');
    const { messages: out, recalled } = await recaller.recall([
      storedTurn('h1', [big, unknown]),
    ]);
    expect(recalled).toEqual(['$unknown']);
    expect(loadImage).toHaveBeenCalledTimes(1);
    expect(loadImage.mock.calls[0]![0]).toEqual(unknown);
    expect(loadImage.mock.calls[0]![1].maxBytes).toBe(
      ATTACHMENT_RECALL_MAX_IMAGE_BYTES,
    );
    expect(placeholderText(out[0])).toContain('$big.png');
    expect(log.warn).toHaveBeenCalledWith(
      expect.stringContaining('$big is 5242881 bytes, over the'),
    );
  });

  it('holds the recalled base64 of one request under the total cap, newest first', async () => {
    const loadImage = vi.fn<RecallImageLoader>(async (meta) => ({
      ...native(meta.eventId ?? ''),
      base64: 'x'.repeat(meta.eventId === '$small' ? 10 : 40),
    }));
    const recaller = createAttachmentRecaller({
      loadImage,
      imageInput: true,
      maxTotalBytes: 90,
    });
    const older = storedTurn('h1', [image('$a'), image('$small')]);
    const newer = storedTurn('h2', [image('$b'), image('$c')]);
    const { recalled } = await recaller.recall([older, reply('a1'), newer]);
    // $b + $c = 80; $a (40) would pass 90, $small (10) still fits.
    expect(recalled).toEqual(['$b', '$c', '$small']);
    expect(loadImage).toHaveBeenCalledTimes(4);
  });

  it('fetches one image at a time, newest first', async () => {
    const order: string[] = [];
    let inFlight = 0;
    let most = 0;
    const loadImage = vi.fn<RecallImageLoader>(async (meta) => {
      inFlight += 1;
      most = Math.max(most, inFlight);
      order.push(meta.eventId ?? '');
      await new Promise((resolve) => setTimeout(resolve, 5));
      inFlight -= 1;
      return native(meta.eventId ?? '');
    });
    const recaller = createAttachmentRecaller({ loadImage, imageInput: true });
    await recaller.recall([
      storedTurn('h1', [image('$1'), image('$2')]),
      reply('a1'),
      storedTurn('h2', [image('$3'), image('$4')]),
    ]);
    expect(most).toBe(1);
    expect(order).toEqual(['$3', '$4', '$1', '$2']);
  });

  it('takes a finished image from the shared cache on the next run, without fetching it again', async () => {
    const loadImage = loader();
    const cache = new RecalledImageCache();
    const turn = storedTurn('h1', [image('$pic')]);
    const firstRun = createAttachmentRecaller({
      loadImage,
      imageInput: true,
      cache,
    });
    await firstRun.recall([turn]);
    const nextRun = createAttachmentRecaller({
      loadImage,
      imageInput: true,
      cache,
    });
    const { messages: out } = await nextRun.recall([turn, reply('a1')]);
    expect(loadImage).toHaveBeenCalledTimes(1);
    expect(recalledData(out[0])).toEqual(['IMG-$pic']);
  });

  it('bounds the cache by entries and by base64 characters, least recently used out first', () => {
    const entry = (ref: string, chars: number): NativeAttachment => ({
      ...native(ref),
      base64: 'x'.repeat(chars),
    });
    const cache = new RecalledImageCache(2, 100);
    cache.set('$a', entry('$a', 10));
    cache.set('$b', entry('$b', 10));
    expect(cache.get('$a')).toBeDefined();
    cache.set('$c', entry('$c', 10));
    expect(cache.get('$b')).toBeUndefined();
    expect(cache.get('$a')).toBeDefined();
    expect(cache.get('$c')).toBeDefined();
    cache.set('$d', entry('$d', 95));
    expect(cache.size).toBe(1);
    expect(cache.get('$d')).toBeDefined();
    // Larger than the whole cache: not kept.
    cache.set('$e', entry('$e', 101));
    expect(cache.get('$e')).toBeUndefined();
    expect(cache.get('$d')).toBeDefined();
  });

  it('never recalls an image the request still holds as bytes', async () => {
    const loadImage = loader();
    const recaller = createAttachmentRecaller({ loadImage, imageInput: true });
    // The newest message re-attached $pic inline (view_attachment); the user
    // turn before it holds the placeholder of the same file.
    const live = new HumanMessage({
      id: 'v1',
      content: [
        { type: 'text', text: 'Re-attached' },
        {
          type: 'image',
          source_type: 'base64',
          mime_type: 'image/png',
          data: 'AAAA',
        },
      ],
      additional_kwargs: {
        lc_source: ATTACHMENT_VIEW_SOURCE,
        attachments: [image('$pic')],
      },
    });
    const stored = storedTurn('h1', [image('$pic'), image('$other')]);
    const { recalled } = await recaller.recall([stored, live]);
    expect(recalled).toEqual(['$other']);
    expect(loadImage).toHaveBeenCalledTimes(1);
  });

  it('recalls a channel photo sent twice once, by its channel reference', async () => {
    const loadImage = loader();
    const recaller = createAttachmentRecaller({ loadImage, imageInput: true });
    const photo = (eventId: string): AttachmentMeta => ({
      ...image(eventId),
      channelRef: 'chan-photo-1',
    });
    const { messages: out, recalled } = await recaller.recall([
      storedTurn('h1', [photo('$first')]),
      reply('a1'),
      storedTurn('h2', [photo('$again')]),
    ]);
    expect(recalled).toEqual(['$again']);
    expect(placeholderText(out[0])).toContain('$first.png');
  });
});

describe('attachment recall middleware', () => {
  function refusal(status: number, message = `${status} bad request`) {
    return Object.assign(new Error(message), { status });
  }

  function wrapped(
    loadImage: RecallImageLoader,
    log = logger(),
  ): NonNullable<AgentMiddleware['wrapModelCall']> {
    const mw = createAttachmentRecallMiddleware({
      loadImage,
      imageInput: true,
      logger: log,
    });
    if (!mw.wrapModelCall) throw new Error('wrapModelCall missing');
    return mw.wrapModelCall;
  }

  function sentMessages(
    handler: ReturnType<typeof vi.fn>,
    call: number,
  ): BaseMessage[] {
    const request: unknown = handler.mock.calls[call]?.[0];
    const messages: unknown =
      typeof request === 'object' && request !== null
        ? Reflect.get(request, 'messages')
        : undefined;
    return Array.isArray(messages)
      ? messages.filter((m): m is BaseMessage => m instanceof HumanMessage)
      : [];
  }

  it('retries once with the request as it came in when the provider refuses the recalled images, and recalls them no more this run', async () => {
    const log = logger();
    const loadImage = loader();
    const wrap = wrapped(loadImage, log);
    const messages = [storedTurn('h1', [image('$pic')])];
    const handler = vi
      .fn()
      .mockRejectedValueOnce(
        Object.assign(new Error('wrapped'), { cause: refusal(400) }),
      )
      .mockResolvedValue({ ok: true });
    await expect(
      wrap({ messages } as never, handler as never),
    ).resolves.toEqual({ ok: true });
    expect(handler).toHaveBeenCalledTimes(2);
    expect(recalledData(sentMessages(handler, 0)[0])).toEqual(['IMG-$pic']);
    expect(sentMessages(handler, 1)[0]).toBe(messages[0]);
    expect(log.warn).toHaveBeenCalledTimes(1);
    expect(log.warn.mock.calls[0]![0]).toMatch(
      /refused a request with 1 recalled image\(s\) \(400: .*retrying once without them.*\$pic/,
    );

    // The next model call of the run: no recall of the refused image.
    await wrap({ messages } as never, handler as never);
    expect(handler).toHaveBeenCalledTimes(3);
    expect(sentMessages(handler, 2)[0]).toBe(messages[0]);
    expect(loadImage).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['a rate limit', refusal(429)],
    ['a credential refusal', refusal(401)],
    ['a server error', refusal(500)],
    [
      'a context overflow',
      refusal(400, 'This model maximum context length is 128000 tokens'),
    ],
    ['an error without a status', new Error('socket hang up')],
  ])('does not retry on %s', async (_label, error) => {
    const wrap = wrapped(loader());
    const handler = vi.fn().mockRejectedValue(error);
    await expect(
      wrap(
        { messages: [storedTurn('h1', [image('$pic')])] } as never,
        handler as never,
      ),
    ).rejects.toBe(error);
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it('does not retry a refusal when nothing was recalled', async () => {
    const wrap = wrapped(loader());
    const error = refusal(400);
    const handler = vi.fn().mockRejectedValue(error);
    const messages = [text('h1')];
    await expect(wrap({ messages } as never, handler as never)).rejects.toBe(
      error,
    );
    expect(handler).toHaveBeenCalledTimes(1);
  });
});

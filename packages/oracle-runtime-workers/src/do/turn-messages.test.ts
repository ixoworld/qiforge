import { AIMessage, HumanMessage } from '@langchain/core/messages';
import { describe, expect, it } from 'vitest';

import type { ExtractedAttachment } from '../attachments';
import { assembleTurnMessages } from './turn-messages';

const meta = (ref: string) => ({
  eventId: ref,
  filename: `${ref}.pdf`,
  mimetype: 'application/pdf',
  mxcUri: `mxc://x/${ref}`,
  category: 'document',
});

const note = (ref: string): ExtractedAttachment => ({
  text: `[source: eventId="${ref}"] note`,
  meta: meta(ref),
});

describe('assembleTurnMessages', () => {
  const human = new HumanMessage({ content: 'please store this' });
  const now = () => new Date('2026-10-26T00:00:00.000Z');

  it('puts native notes before the HumanMessage so the turn ends on it', () => {
    const out = assembleTurnMessages({
      human,
      extracted: [],
      nativeNotes: [note('$a'), note('$b')],
      matrixRoom: true,
      now,
    });
    expect(out).toHaveLength(3);
    expect(out[out.length - 1]).toBe(human);
    expect(out[0]).toBeInstanceOf(AIMessage);
    expect(out[1]).toBeInstanceOf(AIMessage);
    expect(out[0]?.content).toContain('$a');
    expect(out[1]?.content).toContain('$b');
  });

  it('keeps notes hidden: attachment kwarg, room flag and timestamp', () => {
    const [first] = assembleTurnMessages({
      human,
      extracted: [],
      nativeNotes: [note('$a')],
      matrixRoom: true,
      now,
    });
    expect(first?.additional_kwargs).toMatchObject({
      attachment: meta('$a'),
      msgFromMatrixRoom: true,
      timestamp: '2026-10-26T00:00:00.000Z',
    });
  });

  it('leaves the extract lane after the HumanMessage', () => {
    const out = assembleTurnMessages({
      human,
      extracted: [note('$e')],
      nativeNotes: [],
      matrixRoom: false,
      now,
    });
    expect(out[0]).toBe(human);
    expect(out[1]?.content).toContain('$e');
    expect(out).toHaveLength(2);
  });

  it('mixes both lanes: native notes, human, extracted', () => {
    const out = assembleTurnMessages({
      human,
      extracted: [note('$e')],
      nativeNotes: [note('$n')],
      matrixRoom: false,
      now,
    });
    expect(out.map((m) => m.content)).toEqual([
      expect.stringContaining('$n'),
      'please store this',
      expect.stringContaining('$e'),
    ]);
  });

  it('is just the HumanMessage without attachments', () => {
    expect(
      assembleTurnMessages({
        human,
        extracted: [],
        nativeNotes: [],
        matrixRoom: false,
      }),
    ).toEqual([human]);
  });
});

import type { MessageContent } from '@langchain/core/messages';
import { describe, expect, it } from 'vitest';
import { stripTurnTimeNote, withTurnTimeNote } from './turn-time-note';

const NOTE = 'Current time: Saturday, 2026-10-03 14:05 (Europe/Berlin)';

describe('turn time note', () => {
  it('puts the note in front of a text message and takes it off again', () => {
    const sent = withTurnTimeNote('What is due today?', NOTE);
    expect(sent).toBe(`${NOTE}\n\nWhat is due today?`);
    expect(stripTurnTimeNote(sent, NOTE)).toBe('What is due today?');
  });

  it('leads block content with a text block and removes exactly that block', () => {
    const blocks: MessageContent = [
      { type: 'text', text: 'Look at this' },
      { type: 'image_url', image_url: { url: 'https://example.test/a.png' } },
    ];
    const sent = withTurnTimeNote(blocks, NOTE);
    expect(sent).toEqual([{ type: 'text', text: NOTE }, ...blocks]);
    expect(stripTurnTimeNote(sent, NOTE)).toEqual(blocks);
  });

  it('keeps an empty message empty after the round trip', () => {
    expect(stripTurnTimeNote(withTurnTimeNote('', NOTE), NOTE)).toBe('');
    expect(stripTurnTimeNote(withTurnTimeNote([], NOTE), NOTE)).toEqual([]);
  });

  it('leaves content alone when no note was recorded', () => {
    const typed = `${NOTE}\n\nI typed that line myself`;
    for (const recorded of [undefined, null, '', 42, { note: NOTE }])
      expect(stripTurnTimeNote(typed, recorded)).toBe(typed);
  });

  it('leaves content alone when it does not start with the recorded note', () => {
    expect(stripTurnTimeNote('Edited since', NOTE)).toBe('Edited since');
    // The note without its separator is the user's own text, not ours.
    expect(stripTurnTimeNote(`${NOTE} and more`, NOTE)).toBe(
      `${NOTE} and more`,
    );
    const blocks: MessageContent = [{ type: 'text', text: `${NOTE} and more` }];
    expect(stripTurnTimeNote(blocks, NOTE)).toBe(blocks);
    const imageFirst: MessageContent = [
      { type: 'image_url', image_url: { url: 'https://example.test/a.png' } },
      { type: 'text', text: NOTE },
    ];
    expect(stripTurnTimeNote(imageFirst, NOTE)).toBe(imageFirst);
  });

  it('removes one note only, so a quoted note in the text survives', () => {
    const sent = withTurnTimeNote(`${NOTE}\n\nquoted`, NOTE);
    expect(stripTurnTimeNote(sent, NOTE)).toBe(`${NOTE}\n\nquoted`);
  });
});

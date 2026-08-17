import { describe, expect, it } from 'vitest';
import {
  buildTitlePrompt,
  fallbackTitle,
  getSessionTitleModel,
  hasEnoughContextForTitle,
  needsTitle,
  sanitizeTitle,
  type SessionTitleMessage,
} from './session-title.js';

const EXCHANGE: SessionTitleMessage[] = [
  { type: 'human', content: 'my care visit ran over, what should I log?' },
  {
    type: 'ai',
    content:
      'If the client is unsafe, end the visit and leave, contact a supervisor, then log the incident.',
  },
];

describe('needsTitle', () => {
  it.each([undefined, null, '', '   ', 'Untitled', 'untitled', ' UNTITLED '])(
    'treats %j as still needing a title',
    (title) => {
      expect(needsTitle(title)).toBe(true);
    },
  );

  it('treats a real title as final', () => {
    expect(needsTitle('Care Visit Logging')).toBe(false);
  });
});

describe('hasEnoughContextForTitle', () => {
  it('requires both a user and an assistant turn', () => {
    expect(hasEnoughContextForTitle(EXCHANGE)).toBe(true);
  });

  it('rejects an empty conversation', () => {
    expect(hasEnoughContextForTitle([])).toBe(false);
  });

  it('rejects a user turn with no answer yet', () => {
    expect(
      hasEnoughContextForTitle([{ type: 'human', content: 'hello?' }]),
    ).toBe(false);
  });

  it('ignores tool-only assistant turns, which carry empty content', () => {
    expect(
      hasEnoughContextForTitle([
        { type: 'human', content: 'check the weather' },
        { type: 'ai', content: '   ' },
      ]),
    ).toBe(false);
  });

  it('falls back to a plain count for role-less legacy input', () => {
    expect(hasEnoughContextForTitle(['hello', 'hi there'])).toBe(true);
    expect(hasEnoughContextForTitle(['hello'])).toBe(false);
  });
});

describe('buildTitlePrompt', () => {
  it('labels speakers so the namer can tell ask from answer', () => {
    const prompt = buildTitlePrompt(EXCHANGE);

    expect(prompt).toContain('User: my care visit ran over');
    expect(prompt).toContain('Assistant: If the client is unsafe');
  });

  it('caps the transcript to the opening turns', () => {
    const many: SessionTitleMessage[] = Array.from({ length: 12 }, (_, i) => ({
      type: i % 2 === 0 ? 'human' : 'ai',
      content: `turn-${i}`,
    }));

    const prompt = buildTitlePrompt(many);

    expect(prompt).toContain('turn-5');
    expect(prompt).not.toContain('turn-6');
  });

  it('truncates an oversized single message', () => {
    const prompt = buildTitlePrompt([
      { type: 'human', content: 'x'.repeat(2_000) },
      { type: 'ai', content: 'ok' },
    ]);

    expect(prompt).toContain(`${'x'.repeat(600)}…`);
    expect(prompt).not.toContain('x'.repeat(601));
  });
});

describe('sanitizeTitle', () => {
  it('keeps a well-formed title', () => {
    expect(sanitizeTitle('Care Visit Logging')).toBe('Care Visit Logging');
  });

  it('strips quotes, markdown and a "Title:" label', () => {
    expect(sanitizeTitle('## Title: **"Password Reset Help"**')).toBe(
      'Password Reset Help',
    );
  });

  it('strips a reasoning block and keeps the answer', () => {
    expect(
      sanitizeTitle('<think>the user wants…</think>\nStore Opening Hours'),
    ).toBe('Store Opening Hours');
  });

  it('drops trailing punctuation', () => {
    expect(sanitizeTitle('New Dashboard Feedback.')).toBe(
      'New Dashboard Feedback',
    );
  });

  it('rejects a conversational preamble', () => {
    expect(
      sanitizeTitle("Sure! Here's a title for the conversation"),
    ).toBeNull();
  });

  it('rejects a sentence rather than clipping it mid-way', () => {
    expect(
      sanitizeTitle(
        'The user asks what they should do when a care visit runs over time',
      ),
    ).toBeNull();
  });

  it('rejects a title copied verbatim out of the transcript', () => {
    expect(
      sanitizeTitle('end the visit and leave, contact a supervisor', EXCHANGE),
    ).toBeNull();
  });

  it('allows a short title that happens to echo the wording', () => {
    expect(sanitizeTitle('Care Visit Logging', EXCHANGE)).toBe(
      'Care Visit Logging',
    );
  });

  it('rejects empty and near-empty output', () => {
    expect(sanitizeTitle('')).toBeNull();
    expect(sanitizeTitle('  "" ')).toBeNull();
    expect(sanitizeTitle('AI')).toBeNull();
  });

  it('caps a long-but-valid title at a word boundary', () => {
    const title = sanitizeTitle(
      'Supervision Escalation Reporting Documentation Requirements Overview',
    );

    expect(title).toBe(
      'Supervision Escalation Reporting Documentation Requirements',
    );
    expect(title!.length).toBeLessThanOrEqual(60);
  });
});

describe('fallbackTitle', () => {
  it('derives from the user turn, not the assistant answer', () => {
    expect(fallbackTitle(EXCHANGE)).toBe('My care visit ran over');
  });

  it('clips to whole words when there is no clause boundary', () => {
    expect(
      fallbackTitle([
        {
          type: 'human',
          content: 'help me plan the quarterly supervision rota for my team',
        },
        { type: 'ai', content: 'Happy to help.' },
      ]),
    ).toBe('Help me plan the quarterly supervision');
  });

  it('keeps only the first sentence', () => {
    expect(
      fallbackTitle([
        { type: 'human', content: 'Reset my password. It expired yesterday.' },
        { type: 'ai', content: 'Sure.' },
      ]),
    ).toBe('Reset my password');
  });

  it('returns null when there is nothing to name', () => {
    expect(fallbackTitle([])).toBeNull();
    expect(fallbackTitle([{ type: 'ai', content: '' }])).toBeNull();
  });
});

describe('getSessionTitleModel', () => {
  it('honours the SESSION_TITLE_MODEL override', () => {
    const previous = process.env.SESSION_TITLE_MODEL;
    process.env.SESSION_TITLE_MODEL = 'vendor/custom-namer';
    try {
      expect(getSessionTitleModel()).toBe('vendor/custom-namer');
    } finally {
      if (previous === undefined) delete process.env.SESSION_TITLE_MODEL;
      else process.env.SESSION_TITLE_MODEL = previous;
    }
  });
});

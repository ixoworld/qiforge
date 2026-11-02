import { describe, expect, it } from 'vitest';
import { resolveDeliveryProfile } from './profile';
import { shapeStep, splitText, type StepShape } from './shaper';
import type { ChatLimits } from './types';

function whatsappLimits(): ChatLimits {
  const profile = resolveDeliveryProfile({
    client: 'channel',
    channel: {
      provider: 'whatsapp',
      bindingId: 'chb_x',
      remoteMessageRef: 'hmac:x',
    },
  });
  if (profile.kind !== 'chat') throw new Error('expected a chat profile');
  return profile.limits;
}

/**
 * `shapeStep`, checking the contract every shape keeps: no message, lead or
 * closing is longer than `bubbleMax`. Every test in this file goes through it.
 */
function shaped(
  markdown: string,
  limits: ChatLimits = whatsappLimits(),
  canSpill = true,
): StepShape {
  const shape = shapeStep(markdown, limits, canSpill);
  const texts =
    shape.kind === 'messages'
      ? shape.messages
      : [shape.spill.lead, shape.spill.closing ?? ''];
  for (const text of texts)
    expect(text.length).toBeLessThanOrEqual(limits.bubbleMax);
  return shape;
}

const WEEK_PLAN = `## Your week at a glance

You have **14 meetings** this week, with Tuesday and Wednesday the heaviest (5 each). Three deadlines land before Friday.

### Deadlines
| Item | Due | Status |
|---|---|---|
| Board deck | Wed 1 Oct | Draft 60% |
| Grant report | Thu 2 Oct | Not started |
| Invoices | Fri 3 Oct | 4 of 9 sent |

### Suggested plan
1. **Monday 08:00–10:00**: focus block for the board deck.
2. **Tuesday**: move the 1:1 with Sam to Thursday.
3. **Wednesday**: send the deck by 12:00.

Want me to add the focus blocks and move the 1:1 with Sam?`;

const RESTAURANTS = `Here are ten well-reviewed places near you open tonight:

1. **Tasca do Chico**, fado and petiscos
2. **Cervejaria Ramiro**, seafood
3. **A Cevicheria**, Peruvian
4. **Taberna da Rua das Flores**, small plates
5. **Prado**, seasonal
6. **Zé da Mouraria**, huge portions
7. **O Velho Eurico**, Portuguese classics
8. **Sacramento**, good for groups
9. **Pizzeria Romana**, quick and cheap
10. **Time Out Market**, lots of choice

Should I book one of these?`;

function messagesOf(markdown: string, canSpill = true): string[] {
  const shape = shaped(markdown, whatsappLimits(), canSpill);
  if (shape.kind !== 'messages')
    throw new Error(`expected messages, got a spill`);
  return shape.messages;
}

describe('shapeStep', () => {
  it('keeps a short answer as one message per paragraph', () => {
    expect(
      messagesOf(
        'Your flight to Lisbon leaves at **07:40** from Terminal 2. Check-in closes at 06:55.\n\nTraffic looks light, so leaving by 05:45 gives you a comfortable margin. Want a reminder at 05:15?',
      ),
    ).toEqual([
      'Your flight to Lisbon leaves at **07:40** from Terminal 2. Check-in closes at 06:55.',
      'Traffic looks light, so leaving by 05:45 gives you a comfortable margin. Want a reminder at 05:15?',
    ]);
  });

  it('keeps a lead-in with its list and merges tiny fragments forward', () => {
    expect(
      messagesOf(
        'Done.\n\nTwo things to note:\n\n- They asked for **net 30**, so payment is due 25 Oct.\n- Their PO number is now on the invoice.',
      ),
    ).toEqual([
      'Done.\n\nTwo things to note:\n\n- They asked for **net 30**, so payment is due 25 Oct.\n- Their PO number is now on the invoice.',
    ]);
  });

  it('turns a heading into a bold line on the block that follows it', () => {
    expect(
      messagesOf(
        '# Travel plan\n\nYou land at 14:10 and the hotel is 20 minutes away by taxi, so check-in by 15:00 is realistic.',
      ),
    ).toEqual([
      '**Travel plan**\n\nYou land at 14:10 and the hotel is 20 minutes away by taxi, so check-in by 15:00 is realistic.',
    ]);
  });

  it('keeps a reply with a table in chat: the table as one line per row', () => {
    // Four blocks over the preferred three, all within `bubbleTarget`
    // together: filled into one message.
    expect(messagesOf(WEEK_PLAN)).toEqual([
      [
        '**Your week at a glance**\n\nYou have **14 meetings** this week, with Tuesday and Wednesday the heaviest (5 each). Three deadlines land before Friday.',
        '**Deadlines**\n\n- **Board deck** · Due: Wed 1 Oct · Status: Draft 60%\n- **Grant report** · Due: Thu 2 Oct · Status: Not started\n- **Invoices** · Due: Fri 3 Oct · Status: 4 of 9 sent',
        '**Suggested plan**\n\n1. **Monday 08:00–10:00**: focus block for the board deck.\n2. **Tuesday**: move the 1:1 with Sam to Thursday.\n3. **Wednesday**: send the deck by 12:00.',
        'Want me to add the focus blocks and move the 1:1 with Sam?',
      ].join('\n\n'),
    ]);
  });

  it('keeps a ten-item list in chat with its lead-in', () => {
    expect(messagesOf(RESTAURANTS)).toEqual([
      RESTAURANTS.replace('\n\nShould I book one of these?', ''),
      'Should I book one of these?',
    ]);
  });

  it('previews a long list by its lead-in and first items', () => {
    const long = RESTAURANTS.replace('ten', 'twenty').replace(
      '\n\nShould',
      Array.from(
        { length: 10 },
        (_, i) => `\n${i + 11}. **Place ${i + 11}**, nearby`,
      ).join('') + '\n\nShould',
    );
    const shape = shaped(long, whatsappLimits(), true);
    if (shape.kind !== 'spill') throw new Error('expected a spill');
    expect(shape.spill.lead).toBe(
      'Here are twenty well-reviewed places near you open tonight:\n\n1. **Tasca do Chico**, fado and petiscos\n2. **Cervejaria Ramiro**, seafood\n3. **A Cevicheria**, Peruvian\n…and 17 more',
    );
    expect(shape.spill.title).toBe(
      'Here are twenty well-reviewed places near you open tonight',
    );
    expect(shape.spill.closing).toBe('Should I book one of these?');
  });

  it('never drops content when artefacts are unavailable: tables become lists', () => {
    const messages = messagesOf(WEEK_PLAN, false);
    const joined = messages.join('\n\n');
    expect(joined).not.toMatch(/^\|/m);
    expect(joined).not.toMatch(/^#/m);
    expect(joined).toContain(
      '- **Board deck** · Due: Wed 1 Oct · Status: Draft 60%',
    );
    expect(joined).toContain('Want me to add the focus blocks');
    for (const message of messages)
      expect(message.length).toBeLessThanOrEqual(whatsappLimits().bubbleMax);
  });

  it('splits a long paragraph at sentence boundaries under the hard size', () => {
    const sentence = 'This sentence is part of a long answer about budgets. ';
    const messages = messagesOf(sentence.repeat(40).trim(), false);
    expect(messages.length).toBeGreaterThan(1);
    for (const message of messages) {
      expect(message.length).toBeLessThanOrEqual(whatsappLimits().bubbleMax);
      expect(message.endsWith('budgets.')).toBe(true);
    }
  });

  it('re-fences a code block that is split across messages', () => {
    const code = Array.from(
      { length: 200 },
      (_, i) => `const line${i} = ${i};`,
    ).join('\n');
    const messages = messagesOf('```ts\n' + code + '\n```', false);
    expect(messages.length).toBeGreaterThan(1);
    for (const message of messages) {
      expect(message.startsWith('```ts\n')).toBe(true);
      expect(message.endsWith('\n```')).toBe(true);
    }
  });

  it('strips HTML tags but leaves comparisons alone', () => {
    expect(
      messagesOf('Use <b>this</b> one<br>when a < b and c > d holds.'),
    ).toEqual(['Use this one\nwhen a < b and c > d holds.']);
  });

  it('keeps angle brackets in inline code, code blocks and generic types', () => {
    expect(
      messagesOf(
        'Wrap it in `<div>` and return `Promise<string>`, or a Promise<string> <b>now</b>.',
      ),
    ).toEqual([
      'Wrap it in `<div>` and return `Promise<string>`, or a Promise<string> now.',
    ]);
    expect(
      messagesOf('- render `<span>` here <i>first</i>\n- then <br> next'),
    ).toEqual(['- render `<span>` here first\n- then \n next']);
    const fenced = '```html\n<div class="x">hi</div>\n```';
    expect(messagesOf(`Example:\n\n${fenced}`)).toEqual([
      `Example:\n\n${fenced}`,
    ]);
  });

  it('writes reference links inline, since their definitions are not sent', () => {
    expect(
      messagesOf(
        'Read the [setup guide][1] and [FAQ].\n\n[1]: https://docs.test/setup "Setup"\n[FAQ]: https://docs.test/faq',
      ),
    ).toEqual([
      'Read the [setup guide](https://docs.test/setup "Setup") and [FAQ](https://docs.test/faq).',
    ]);
  });

  it('titles a spill that opens with a table generically and previews its rows', () => {
    const rows = Array.from(
      { length: 80 },
      (_, i) => `| Item ${i} | ${'a long cell value '.repeat(3).trim()} |`,
    );
    const table = `| A | B |\n|---|---|\n${rows.join('\n')}`;
    const shape = shaped(table, whatsappLimits(), true);
    if (shape.kind !== 'spill') throw new Error('expected a spill');
    expect(shape.spill.title).toBe('Details');
    const cell = 'B: a long cell value a long cell value a long cell value';
    expect(shape.spill.lead).toBe(
      `- **Item 0** · ${cell}\n- **Item 1** · ${cell}\n- **Item 2** · ${cell}\n…and 77 more`,
    );
  });

  it('spills a table over `maxListItems` rows with a preview, and keeps a small one in chat', () => {
    const table = (count: number) =>
      [
        'Monthly rainfall by district:',
        '',
        '| District | Rain |',
        '|---|---|',
        ...Array.from(
          { length: count },
          (_, i) => `| District ${i + 1} | ${i + 10} mm |`,
        ),
      ].join('\n');
    const spill = spillOfStep(table(40));
    expect(spill.lead).toBe(
      'Monthly rainfall by district:\n\n- **District 1** · Rain: 10 mm\n- **District 2** · Rain: 11 mm\n- **District 3** · Rain: 12 mm\n…and 37 more',
    );
    expect(messagesOf(table(15))).toHaveLength(1);
  });

  it('renders a header-only table as its header line, and an empty first cell without bold', () => {
    expect(messagesOf('| Plan | Price |\n|---|---|')).toEqual([
      '- **Plan** · Price',
    ]);
    expect(
      messagesOf('| Plan | Price |\n|---|---|\n|  | $5 |\n| Plus | $9 |'),
    ).toEqual(['- Price: $5\n- **Plus** · Price: $9']);
  });

  it('never makes a message longer than `bubbleMax` from a lead-in or headings', () => {
    // A long lead-in ending in ":" before a list.
    const leadIn = `${paragraph(1, 59)} Here they are:`;
    expect(leadIn.length).toBeGreaterThan(4200);
    const withList = messagesOf(`${leadIn}\n\n- a\n- b`);
    expect(withList.length).toBeGreaterThan(1);
    expect(normalised(withList.join(' '))).toBe(
      normalised(`${leadIn} - a - b`),
    );
    // Thirty headings in a row before a paragraph just under `bubbleMax`.
    const headings = Array.from(
      { length: 30 },
      (_, i) => `## Section ${i + 1} heading`,
    );
    const body = 'x '.repeat(745).trim();
    expect(body.length).toBe(1489);
    const messages = messagesOf([...headings, body].join('\n\n'));
    // The headings ride on the first piece of the body, split to the room left.
    expect(messages[0]).toMatch(/^\*\*Section 1 heading\*\*/);
    expect(messages[0]).toContain('**Section 30 heading**\n\nx x');
    expect(normalised(messages.join(' '))).toBe(
      normalised(
        [...headings.map((h) => h.replace('## ', '**') + '**'), body].join(' '),
      ),
    );
  });
});

/** Whitespace collapsed: messages are compared with the text they came from. */
const normalised = (text: string): string => text.replace(/\s+/g, ' ').trim();

/** A paragraph of `sentences` distinct sentences, `n` its number. */
function paragraph(n: number, sentences: number): string {
  return Array.from(
    { length: sentences },
    (_, i) =>
      `Point ${n}.${i + 1} explains one part of the answer in plain words for the reader.`,
  ).join(' ');
}

function spillOfStep(markdown: string) {
  const shape = shaped(markdown, whatsappLimits(), true);
  if (shape.kind !== 'spill') throw new Error('expected a spill');
  return shape.spill;
}

describe('shapeStep on WhatsApp: ordinary answers stay in chat', () => {
  it('keeps a normal short answer as one or two messages', () => {
    const messages = messagesOf(
      'Your clinic appointment is on **Tuesday at 10:30**.\n\nBring your ID card and the referral letter.',
    );
    expect(messages.length).toBeGreaterThanOrEqual(1);
    expect(messages.length).toBeLessThanOrEqual(2);
  });

  it('keeps a 3,000-character answer in chat, in order, with nothing lost', () => {
    const answer = Array.from({ length: 10 }, (_, i) =>
      paragraph(i + 1, 4),
    ).join('\n\n');
    expect(answer.length).toBeGreaterThan(1800);
    expect(answer.length).toBeLessThan(4500);
    const limits = whatsappLimits();
    const messages = messagesOf(answer);
    for (const message of messages)
      expect(message.length).toBeLessThanOrEqual(limits.bubbleMax);
    expect(normalised(messages.join('\n\n'))).toBe(normalised(answer));
  });

  it('keeps a single 3,000-character paragraph in chat, split at sentences', () => {
    const answer = paragraph(1, 36);
    expect(answer.length).toBeGreaterThan(1800);
    expect(answer.length).toBeLessThan(4500);
    const messages = messagesOf(answer);
    expect(messages.length).toBeGreaterThan(1);
    for (const message of messages) {
      expect(message.length).toBeLessThanOrEqual(whatsappLimits().bubbleMax);
      expect(message.endsWith('reader.')).toBe(true);
    }
    expect(normalised(messages.join(' '))).toBe(normalised(answer));
  });

  it('groups five moderate paragraphs into the preferred three messages', () => {
    const paragraphs = Array.from({ length: 5 }, (_, i) => paragraph(i + 1, 3));
    for (const p of paragraphs) expect(p.length).toBeGreaterThan(200);
    const [p1, p2, p3, p4, p5] = paragraphs;
    // Smallest pair first, leftmost on a tie: (1, 2), then (3, 4).
    expect(messagesOf(paragraphs.join('\n\n'))).toEqual([
      `${p1}\n\n${p2}`,
      `${p3}\n\n${p4}`,
      p5,
    ]);
  });

  it("keeps the model's message breaks when a step is already within the preference", () => {
    const paragraphs = Array.from({ length: 3 }, (_, i) => paragraph(i + 1, 1));
    expect(messagesOf(paragraphs.join('\n\n'))).toEqual(paragraphs);
  });

  it('never merges a code block into a neighbouring message', () => {
    // Over `minBubble`, so it is not merged forward as a fragment.
    const fence =
      '```ts\nconst total = price * quantity;\nconst tax = total * rate;\n```';
    const [p1, p2, p3] = [1, 2, 3].map((n) => paragraph(n, 1));
    expect(messagesOf([p1, fence, p2, p3].join('\n\n'))).toEqual([
      p1,
      fence,
      `${p2}\n\n${p3}`,
    ]);
    // Nothing else may merge: the step keeps more messages than preferred.
    expect(
      shaped(
        [p1, fence, p2].join('\n\n'),
        { ...whatsappLimits(), maxBubbles: 1 },
        true,
      ),
    ).toEqual({ kind: 'messages', messages: [p1, fence, p2] });
  });

  it('keeps more messages than preferred when merging would pass the hard size', () => {
    const paragraphs = Array.from({ length: 4 }, (_, i) =>
      paragraph(i + 1, 12),
    );
    for (const p of paragraphs)
      expect(p.length * 2 + 2).toBeGreaterThan(whatsappLimits().bubbleMax);
    expect(messagesOf(paragraphs.join('\n\n'))).toEqual(paragraphs);
  });

  it('keeps an eight-item list in chat with its lead-in', () => {
    const items = Array.from(
      { length: 8 },
      (_, i) =>
        `${i + 1}. Step ${i + 1}: fill in section ${i + 1} of the form.`,
    );
    const list = `To register the land, do this:\n\n${items.join('\n')}`;
    const messages = messagesOf(list);
    expect(messages).toEqual([list]);
    for (const item of items) expect(messages[0]).toContain(item);
  });

  it('keeps a small comparison table in chat, one line per row', () => {
    const comparison = [
      'Here is how the three plans compare:',
      '',
      '| Plan | Price | Data |',
      '|---|---|---|',
      '| Basic | $5 | 1 GB |',
      '| Plus | $9 | 5 GB |',
      '| Max | $15 | 20 GB |',
    ].join('\n');
    expect(messagesOf(comparison)).toEqual([
      'Here is how the three plans compare:\n\n- **Basic** · Price: $5 · Data: 1 GB\n- **Plus** · Price: $9 · Data: 5 GB\n- **Max** · Price: $15 · Data: 20 GB',
    ]);
  });

  it('keeps a 30-line code block in chat, re-fenced where it is split', () => {
    const code = Array.from(
      { length: 30 },
      (_, i) => `const setting${i} = readSetting('section-${i}', 'default');`,
    ).join('\n');
    expect(code.length).toBeGreaterThan(whatsappLimits().bubbleMax);
    const messages = messagesOf('```ts\n' + code + '\n```');
    expect(messages.length).toBeGreaterThan(1);
    for (const message of messages) {
      expect(message.startsWith('```ts\n')).toBe(true);
      expect(message.endsWith('\n```')).toBe(true);
    }
  });
});

describe('shapeStep on WhatsApp: document-length steps spill', () => {
  it('spills a 5,000-character step, keeping the first and last paragraphs in chat', () => {
    const first = paragraph(1, 10);
    const last =
      'Next step: take the signed form to the district office before Friday.';
    expect(first.length).toBeGreaterThan(whatsappLimits().bubbleTarget);
    expect(first.length).toBeLessThanOrEqual(whatsappLimits().bubbleMax);
    const step = [
      '## Land registration options',
      first,
      ...Array.from({ length: 15 }, (_, i) => paragraph(i + 2, 4)),
      last,
    ].join('\n\n');
    expect(step.length).toBeGreaterThan(5000);
    // The last paragraph has no question mark; the one before it joins it.
    expect(spillOfStep(step)).toEqual({
      title: 'Land registration options',
      markdown: step,
      lead: first,
      closing: `${paragraph(16, 4)}\n\n${last}`,
    });
  });

  it('cuts a lead paragraph over the hard size at a sentence boundary', () => {
    const first = paragraph(1, 30);
    expect(first.length).toBeGreaterThan(whatsappLimits().bubbleMax);
    const spill = spillOfStep(
      [
        first,
        ...Array.from({ length: 12 }, (_, i) => paragraph(i + 2, 4)),
      ].join('\n\n'),
    );
    expect(spill.lead.length).toBeLessThanOrEqual(whatsappLimits().bubbleMax);
    expect(first.startsWith(spill.lead)).toBe(true);
    expect(spill.lead.endsWith('reader.')).toBe(true);
    expect(spill.title).toBe(
      'Point 1.1 explains one part of the answer in plain words…',
    );
  });

  it('spills a 20-item list with a three-item preview', () => {
    const list = Array.from(
      { length: 20 },
      (_, i) => `- Village ${i + 1}`,
    ).join('\n');
    expect(spillOfStep(list).lead).toBe(
      '- Village 1\n- Village 2\n- Village 3\n…and 17 more',
    );
  });

  it('spills eight paragraphs totalling 5,000 characters on length, not on count', () => {
    const paragraphs = Array.from({ length: 8 }, (_, i) => paragraph(i + 1, 9));
    const step = paragraphs.join('\n\n');
    expect(step.length).toBeGreaterThan(5000);
    expect(step.length).toBeLessThan(5600);
    expect(shaped(step, whatsappLimits(), true).kind).toBe('spill');
    // The same step under the length limit stays in chat.
    expect(
      shaped(step, { ...whatsappLimits(), spillChars: 6000 }, true).kind,
    ).toBe('messages');
  });

  it('spills a 60-line code block', () => {
    const code = Array.from(
      { length: 60 },
      (_, i) => `const line${i} = ${i};`,
    ).join('\n');
    expect(
      shaped('```ts\n' + code + '\n```', whatsappLimits(), true).kind,
    ).toBe('spill');
  });
});

/** Exactly `n` characters of plain words, `seed` making it distinct. */
function exactly(n: number, seed: string): string {
  let text = '';
  while (text.length < n) text += `${seed} words in a plain sentence. `;
  text = text.slice(0, n);
  return /\s$/.test(text) ? `${text.slice(0, -1)}x` : text;
}

describe('shapeStep on WhatsApp: boundaries, closings and grouping', () => {
  it('keeps a step of exactly `spillChars` in chat and spills one character more', () => {
    expect(exactly(4500, 'a')).toHaveLength(4500);
    expect(shaped(exactly(4500, 'a')).kind).toBe('messages');
    expect(shaped(exactly(4501, 'a')).kind).toBe('spill');
    // Blocks count with the blank line between them, not two per block.
    const two = `${exactly(2249, 'b')}\n\n${exactly(2249, 'c')}`;
    expect(two).toHaveLength(4500);
    expect(shaped(two).kind).toBe('messages');
  });

  it('keeps a closing list of next steps, previewed, after the link', () => {
    const step = [
      paragraph(1, 3),
      ...Array.from({ length: 15 }, (_, i) => paragraph(i + 2, 4)),
      'Next steps:',
      '- Sign the form\n- Take it to the office\n- Pay the fee\n- Collect the title\n- Register it',
    ].join('\n\n');
    expect(step.length).toBeGreaterThan(4500);
    expect(spillOfStep(step).closing).toBe(
      'Next steps:\n\n- Sign the form\n- Take it to the office\n- Pay the fee\n…and 2 more',
    );
  });

  it('keeps the conclusion with the closing question', () => {
    const conclusion = 'So the cheapest option is the district office.';
    const question = 'Want me to book a slot there?';
    const step = [
      paragraph(1, 3),
      ...Array.from({ length: 15 }, (_, i) => paragraph(i + 2, 4)),
      conclusion,
      question,
    ].join('\n\n');
    expect(spillOfStep(step).closing).toBe(`${conclusion}\n\n${question}`);
  });

  it('never repeats the lead as the closing', () => {
    const list = Array.from({ length: 20 }, (_, i) => `- Item ${i + 1}`);
    const spill = spillOfStep(`Here they are:\n\n${list.join('\n')}`);
    expect(spill.lead).toContain('Here they are:');
    expect(spill.closing).toBeUndefined();
  });

  it('groups ten 432-character paragraphs into four messages', () => {
    const paragraphs = Array.from({ length: 10 }, (_, i) =>
      exactly(432, `Part ${i}`),
    );
    const messages = messagesOf(paragraphs.join('\n\n'));
    // Pairs pass `bubbleTarget`, so they are filled up to `bubbleMax`: 3+3+3+1.
    expect(messages).toEqual([
      paragraphs.slice(0, 3).join('\n\n'),
      paragraphs.slice(3, 6).join('\n\n'),
      paragraphs.slice(6, 9).join('\n\n'),
      paragraphs[9],
    ]);
  });
});

describe('shapeStep: second review', () => {
  it('never puts the code block that caused a spill in the lead', () => {
    const yaml = Array.from({ length: 45 }, (_, i) => `k${i}: on`).join('\n');
    const step = '```yaml\n' + yaml + '\n```\n\nWant me to apply it?';
    const spill = spillOfStep(step);
    // The question is the only prose: it follows the link as the closing.
    expect(spill.lead).toBe('');
    expect(spill.closing).toBe('Want me to apply it?');
    expect(spill.markdown).toContain(yaml);
    // With no paragraph after it, there is no lead at all.
    expect(spillOfStep('```yaml\n' + yaml + '\n```').lead).toBe('');
  });

  it('starts the message that holds a body with its heading', () => {
    const body = exactly(1490, 'Price');
    const alone = messagesOf(`## Pricing\n\n${body}`);
    expect(alone[0]!.startsWith('**Pricing**\n\nPrice words')).toBe(true);
    expect(alone).not.toContain('**Pricing**');
    expect(normalised(alone.join(' '))).toBe(normalised(`**Pricing** ${body}`));
    const short = [1, 2, 3, 4].map((n) => exactly(70, `Short ${n}`));
    const after = messagesOf([...short, '## Details', body].join('\n\n'));
    for (const message of after)
      expect(message.endsWith('**Details**')).toBe(false);
    const holder = after.find((m) => m.includes('**Details**'));
    expect(holder?.startsWith('**Details**\n\nPrice words')).toBe(true);
  });

  it('keeps the "…and N more" trailer when a closing preview must shrink', () => {
    const items = Array.from(
      { length: 20 },
      (_, i) => `- Step ${i + 1}: ${exactly(600, `Do ${i + 1}`)}`,
    );
    const step = [
      paragraph(1, 3),
      paragraph(2, 4),
      'Next steps:',
      items.join('\n'),
    ].join('\n\n');
    expect(spillOfStep(step).closing).toBe(
      `Next steps:\n\n${items[0]}\n${items[1]}\n…and 18 more`,
    );
  });

  it('keeps one item and the trailer when the lead-in itself is too long', () => {
    const leadIn = `${paragraph(1, 26)} These are the options:`;
    expect(leadIn.length).toBeGreaterThan(1900);
    const list = Array.from({ length: 20 }, (_, i) => `- Option ${i + 1}`);
    const spill = spillOfStep(`${leadIn}\n\n${list.join('\n')}`);
    expect(spill.lead.endsWith('\n\n- Option 1\n…and 19 more')).toBe(true);
    expect(leadIn.startsWith(spill.lead.split('\n\n')[0]!)).toBe(true);
  });

  it('cuts a lead and a title without splitting an emoji', () => {
    const spill = spillOfStep('😀'.repeat(3000));
    expect(spill.lead.replace(/😀/gu, '')).toBe('…');
    expect(spill.title.replace(/😀/gu, '')).toBe('…');
  });

  it('keeps the trailing sentences of a last paragraph over `bubbleMax`', () => {
    const last = `${paragraph(99, 25)} Shall I file it for you?`;
    expect(last.length).toBeGreaterThan(whatsappLimits().bubbleMax);
    const step = [
      paragraph(1, 3),
      ...Array.from({ length: 12 }, (_, i) => paragraph(i + 2, 4)),
      last,
    ].join('\n\n');
    const closing = spillOfStep(step).closing ?? '';
    expect(closing.endsWith('Shall I file it for you?')).toBe(true);
    expect(last.endsWith(closing)).toBe(true);
    expect(closing.length).toBeGreaterThan(1000);
  });
});

describe('splitText', () => {
  it('never cuts an emoji or another grapheme in two', () => {
    const text = '😀👍🏽🇵🇹'.repeat(4);
    for (const size of [1, 2, 3, 5]) {
      const pieces = splitText(text, size);
      expect(pieces.join('')).toBe(text);
      // Every piece is whole graphemes: nothing is left once they are removed.
      for (const piece of pieces)
        expect(piece.replace(/😀|👍🏽|🇵🇹/gu, '')).toBe('');
    }
  });

  it('splits CJK text at sentence boundaries', () => {
    const text = '今天的会议很长。我们讨论了预算和时间表。下周再见。'.repeat(
      10,
    );
    const pieces = splitText(text, 60);
    expect(pieces.length).toBeGreaterThan(1);
    for (const piece of pieces) {
      expect(piece.length).toBeLessThanOrEqual(60);
      expect(piece.endsWith('。')).toBe(true);
    }
  });

  it('cuts a single unbroken token at the hard size', () => {
    expect(splitText('x'.repeat(25), 10)).toEqual([
      'x'.repeat(10),
      'x'.repeat(10),
      'x'.repeat(5),
    ]);
  });

  it('finishes for a size below one character', () => {
    expect(splitText('abc', 0)).toEqual(['a', 'b', 'c']);
    expect(splitText('abc', -4)).toEqual(['a', 'b', 'c']);
    expect(splitText('abc', Number.NaN)).toEqual(['a', 'b', 'c']);
  });

  it('splits a code block without re-fencing when the fence leaves no room', () => {
    const shape = shaped(
      '```ts\nconst a = 1;\n```',
      { ...whatsappLimits(), bubbleMax: 5, minBubble: 1 },
      false,
    );
    expect(shape).toEqual({
      kind: 'messages',
      messages: ['```ts', 'const', 'a =', '1;', '```'],
    });
  });
});

describe('splitText limits', () => {
  it('never exceeds the size and keeps every word, in order, for mixed text at many sizes', () => {
    const text = [
      'First paragraph. It has two sentences!',
      'Second one\nwith a line break and a verylongtokenwithoutanyspacesatall.',
      '第三段。中文句子。',
      'x'.repeat(57),
    ].join('\n\n');
    const words = (s: string) => s.split(/\s+/).filter(Boolean).join('');
    for (const max of [1, 3, 7, 16, 40, 80, 500]) {
      const pieces = splitText(text, max);
      for (const piece of pieces)
        expect(piece.length, `max ${max}`).toBeLessThanOrEqual(max);
      expect(words(pieces.join('')), `max ${max}`).toBe(words(text));
    }
  });
});

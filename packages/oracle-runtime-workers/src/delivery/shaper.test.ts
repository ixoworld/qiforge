import { describe, expect, it } from 'vitest';
import { resolveDeliveryProfile } from './profile';
import { shapeStep, splitText } from './shaper';
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
  const shape = shapeStep(markdown, whatsappLimits(), canSpill);
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

  it('moves a reply with a table to an artefact: lead, then the closing question', () => {
    const shape = shapeStep(WEEK_PLAN, whatsappLimits(), true);
    expect(shape).toEqual({
      kind: 'spill',
      spill: {
        title: 'Your week at a glance',
        markdown: WEEK_PLAN,
        lead: 'You have **14 meetings** this week, with Tuesday and Wednesday the heaviest (5 each). Three deadlines land before Friday.',
        closing: 'Want me to add the focus blocks and move the 1:1 with Sam?',
      },
    });
  });

  it('previews a long list by its lead-in and first items', () => {
    const shape = shapeStep(RESTAURANTS, whatsappLimits(), true);
    if (shape.kind !== 'spill') throw new Error('expected a spill');
    expect(shape.spill.lead).toBe(
      'Here are ten well-reviewed places near you open tonight:\n\n1. **Tasca do Chico**, fado and petiscos\n2. **Cervejaria Ramiro**, seafood\n3. **A Cevicheria**, Peruvian\n…and 7 more',
    );
    expect(shape.spill.title).toBe(
      'Here are ten well-reviewed places near you open tonight',
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

  it('titles a spill that opens with a table generically', () => {
    const table = `| A | B |\n|---|---|\n| 1 | 2 |`;
    const shape = shapeStep(table, whatsappLimits(), true);
    if (shape.kind !== 'spill') throw new Error('expected a spill');
    expect(shape.spill.title).toBe('Details');
    expect(shape.spill.lead).toBe('');
  });
});

describe('splitText', () => {
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
});

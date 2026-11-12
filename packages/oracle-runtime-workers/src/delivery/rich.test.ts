import { env, runInDurableObject } from 'cloudflare:test';
import {
  AIMessage,
  HumanMessage,
  ToolMessage,
  type BaseMessage,
} from '@langchain/core/messages';
import { describe, expect, it } from 'vitest';
import { ChannelChoices, CHOICE_TTL_MS } from '../channels/choices';
import { DoSqliteDatabase } from '../sqlite/database';
import { makeRuntimeContext } from '../core/test-fixtures';
import type { PluginTool } from '../plugin-api/types';
import { draftReplyPlan, materializeReplyPlan, turnSteps } from './plan';
import { resolveDeliveryProfile } from './profile';
import { renderRichSection, renderSurfaceSection } from './prompt';
import {
  cardsPart,
  cardsText,
  choicesPart,
  chooseFormat,
  choicesText,
  linkButtonPart,
  displayLink,
  linkButtonText,
  safeHttpsUrl,
  parseChoiceId,
  renderCapabilityOf,
  richPartsOf,
  withRichParts,
} from './rich';
import {
  buildRichMessageTools,
  OFFER_CHOICES_TOOL,
  SEND_CARDS_TOOL,
  SEND_LINK_BUTTON_TOOL,
} from './rich-tools';
import { parseReplyPlan, planText, planTextForModel } from './schema';
import { withStandaloneMessages } from './standalone';
import type {
  CardItem,
  ChatLimits,
  RenderCapability,
  ReplyPlan,
} from './types';

const ALL: RenderCapability = {
  kinds: ['reply_buttons', 'list', 'link_button', 'card', 'carousel'],
  linkLabels: [
    'open',
    'allow',
    'start_check',
    'sign_in',
    'view',
    'register',
    'continue',
  ],
  linkOrigins: ['https://dev.self.ixo.earth', 'https://yoma.world'],
};

const s = (n: number, c = 'a') => c.repeat(n);

/** A tool's result, which must be a `ToolMessage`. */
function toolMessage(value: unknown): ToolMessage {
  if (!(value instanceof ToolMessage))
    throw new Error('expected a ToolMessage');
  return value;
}
const opts = (...titles: string[]) => titles.map((title) => ({ title }));

function limits(): ChatLimits {
  const profile = resolveDeliveryProfile({
    client: 'channel',
    channel: {
      provider: 'whatsapp',
      bindingId: 'chb_x',
      remoteMessageRef: 'hmac:x',
    },
  });
  if (profile.kind !== 'chat') throw new Error('expected chat');
  return profile.limits;
}

async function planOf(messages: BaseMessage[]): Promise<ReplyPlan> {
  const { steps, toolResults, toolArtifacts } = turnSteps(messages);
  return materializeReplyPlan(
    draftReplyPlan({
      steps,
      toolResults,
      toolArtifacts,
      limits: limits(),
      canSpill: false,
    }),
    {
      limits: limits(),
      createSpill: () => Promise.reject(new Error('no spill')),
    },
  );
}

describe('renderCapabilityOf', () => {
  it('keeps only known kinds and labels and exact https origins', () => {
    expect(
      renderCapabilityOf({
        v: 1,
        kinds: ['list', 'flow', 'reply_buttons'],
        linkLabels: ['allow', 'pay'],
        linkOrigins: [
          'https://dev.self.ixo.earth',
          'https://dev.self.ixo.earth/',
          'http://plain.example',
          'https://a.example/path',
          'not a url',
          'https://dev.self.ixo.earth',
        ],
      }),
    ).toEqual({
      kinds: ['reply_buttons', 'list'],
      linkLabels: ['allow'],
      linkOrigins: ['https://dev.self.ixo.earth'],
    });
  });
});

describe('chooseFormat', () => {
  it.each([
    ['2 short options', opts('Yes', 'No'), 'buttons'],
    ['3 options of exactly 20', opts(s(20), s(20, 'b'), s(20, 'c')), 'buttons'],
    ['a title of 21 → list', opts(s(21), 'No'), 'list'],
    ['a title of 24 → list', opts(s(24), 'No'), 'list'],
    ['a title of 25 → text', opts(s(25), 'No'), 'text'],
    ['4 options → list', opts('A', 'B', 'C', 'D'), 'list'],
    ['10 options → list', opts(...'ABCDEFGHIJ'.split('')), 'list'],
    ['11 options → text', opts(...'ABCDEFGHIJK'.split('')), 'text'],
    ['1 option → text', opts('Only'), 'text'],
    ['a line break → text', opts('Yes\nplease', 'No'), 'text'],
  ])('%s', (_name, options, format) => {
    expect(chooseFormat(options, ALL)).toBe(format);
  });

  it('a description moves 2–3 options to a list; one over 72 to text', () => {
    expect(
      chooseFormat(
        [{ title: 'Yes', description: s(72) }, { title: 'No' }],
        ALL,
      ),
    ).toBe('list');
    expect(
      chooseFormat(
        [{ title: 'Yes', description: s(73) }, { title: 'No' }],
        ALL,
      ),
    ).toBe('text');
  });

  it('falls through to what the gateway supports', () => {
    const lists = { ...ALL, kinds: ['list' as const] };
    const buttons = { ...ALL, kinds: ['reply_buttons' as const] };
    expect(chooseFormat(opts('Yes', 'No'), lists)).toBe('list');
    expect(chooseFormat(opts('A', 'B', 'C', 'D'), buttons)).toBe('text');
    expect(chooseFormat(opts('Yes', 'No'), { ...ALL, kinds: [] })).toBe('text');
    expect(chooseFormat(opts('Yes', 'No'), undefined)).toBe('text');
  });
});

describe('choicesPart', () => {
  it('builds buttons with oc: ids and the text version', () => {
    const built = choicesPart(
      {
        body: 'Which size?',
        options: [{ key: 'small', title: 'Small' }, { title: 'Large' }],
      },
      ALL,
      '3f9a01c2',
    );
    expect(built.format).toBe('buttons');
    expect(built.part).toEqual({
      kind: 'choices',
      text: 'Which size?\n\n1. Small\n2. Large',
      choices: {
        body: 'Which size?',
        style: 'buttons',
        options: [
          { id: 'oc:3f9a01c2:small', title: 'Small' },
          { id: 'oc:3f9a01c2:2', title: 'Large' },
        ],
      },
    });
    expect(parseChoiceId('oc:3f9a01c2:small')).toEqual({
      offerId: '3f9a01c2',
      key: 'small',
    });
    expect(parseChoiceId('ab12cd34.t3')).toBeNull();
  });

  it('a list carries its menu label (default Choose) and descriptions', () => {
    const built = choicesPart(
      {
        body: 'Pick a plan',
        options: [
          { title: 'Basic', description: 'R50 a month' },
          { title: 'Pro' },
        ],
      },
      ALL,
      'aaaaaaaa',
    );
    expect(built.part).toMatchObject({
      kind: 'choices',
      text: 'Pick a plan\n\n1. Basic — R50 a month\n2. Pro',
      choices: { style: 'list', button: 'Choose' },
    });
    expect(
      choicesPart(
        {
          ...{ body: 'x', options: opts('A', 'B', 'C', 'D') },
          menuLabel: 'See plans',
        },
        ALL,
      ).part,
    ).toMatchObject({ choices: { button: 'See plans' } });
  });

  it('too many options: a text part with the numbered list, never cut', () => {
    const many = opts(...'ABCDEFGHIJKL'.split(''));
    const built = choicesPart({ body: 'Which?', options: many }, ALL);
    expect(built.format).toBe('text');
    expect(built.part).toEqual({
      kind: 'text',
      text: choicesText('Which?', many),
    });
    expect(built.part.text).toContain('12. L');
  });

  it('refuses what no format can carry', () => {
    expect(() => choicesPart({ body: 'x', options: opts('A') }, ALL)).toThrow(
      TypeError,
    );
    expect(() =>
      choicesPart({ body: ' ', options: opts('A', 'B') }, ALL),
    ).toThrow(TypeError);
    expect(() =>
      choicesPart({ body: s(1025), options: opts('A', 'B') }, ALL),
    ).toThrow(TypeError);
    expect(() =>
      choicesPart({ body: 'x', options: opts('A', 'a') }, ALL),
    ).toThrow(TypeError);
    expect(() =>
      choicesPart(
        {
          body: 'x',
          options: [
            { key: 'k', title: 'A' },
            { key: 'k', title: 'B' },
          ],
        },
        ALL,
      ),
    ).toThrow(TypeError);
    expect(() =>
      choicesPart(
        { body: 'x', options: opts('A', 'B'), menuLabel: s(21) },
        ALL,
      ),
    ).toThrow(TypeError);
  });
});

describe('linkButtonPart', () => {
  const input = {
    body: 'Open your check.',
    url: 'https://dev.self.ixo.earth/l/abc',
    label: 'start_check',
  };

  it('is a link button on an approved origin with a known label', () => {
    expect(linkButtonPart(input, ALL)).toEqual({
      reason: null,
      part: {
        kind: 'link_button',
        text: 'Open your check.\n\nStart check: https://dev.self.ixo.earth/l/abc',
        link: {
          body: 'Open your check.',
          url: input.url,
          label: 'start_check',
        },
      },
    });
  });

  it.each([
    [
      'an unapproved origin',
      { url: 'https://evil.example/x' },
      'approved site',
    ],
    ['an http link', { url: 'http://dev.self.ixo.earth/l' }, 'https'],
    ['an unknown label', { label: 'pay' }, 'fixed labels'],
    ['a non-https image', { imageUrl: 'http://img.example/a.jpg' }, 'image'],
    ['a body over 1024', { body: s(1025) }, '1024'],
  ])('falls back on %s', (_name, change, reason) => {
    const built = linkButtonPart({ ...input, ...change }, ALL);
    expect(built.part).toBeNull();
    expect(built.reason).toContain(reason);
  });

  it('falls back without render or the link_button kind', () => {
    expect(linkButtonPart(input, undefined).part).toBeNull();
    expect(linkButtonPart(input, { ...ALL, kinds: ['list'] }).part).toBeNull();
  });

  it('the text version names the image and the label; a plugin may give its own', () => {
    expect(
      linkButtonText({ ...input, imageUrl: 'https://img.example/a.jpg' }),
    ).toBe(
      'Open your check.\n\nImage: https://img.example/a.jpg\n\nStart check: https://dev.self.ixo.earth/l/abc',
    );
    expect(linkButtonText({ ...input, label: 'pay' })).toBe(
      'Open your check.\n\nhttps://dev.self.ixo.earth/l/abc',
    );
    expect(
      linkButtonPart({ ...input, fallback: 'Exactly this: https://x' }, ALL)
        .part?.text,
    ).toBe('Exactly this: https://x');
  });
});

describe('link safety: parse once, check the parsed URL, send its href', () => {
  const AUTH: RenderCapability = {
    ...ALL,
    linkOrigins: ['https://dev.auth.ixo.earth', 'https://img.example'],
  };
  const button = (url: string, imageUrl?: string) =>
    linkButtonPart(
      {
        body: 'Allow this.',
        url,
        label: 'allow',
        ...(imageUrl ? { imageUrl } : {}),
      },
      AUTH,
    );
  const fallbackOf = (url: string) =>
    linkButtonText({ body: 'Allow this.', url, label: 'allow' });

  it('a backslash host trick is refused; the text shows the WHATWG href, never the raw string', () => {
    const raw = 'https://dev.auth.ixo.earth\\@evil.example/';
    // WHATWG reads it as a path on the approved host; another parser may
    // read userinfo + evil.example. The raw string never goes out.
    expect(new URL(raw).origin).toBe('https://dev.auth.ixo.earth');
    expect(button(raw)).toEqual({
      part: null,
      reason: 'the link is not a plain https link',
    });
    expect(fallbackOf(raw)).toBe(
      'Allow this.\n\nAllow: https://dev.auth.ixo.earth/@evil.example/',
    );
    expect(fallbackOf(raw)).not.toContain('\\');
  });

  it('userinfo is refused; the text shows where the link really goes, without it', () => {
    const raw = 'https://dev.auth.ixo.earth@evil.example/';
    expect(button(raw).part).toBeNull();
    expect(fallbackOf(raw)).toBe('Allow this.\n\nAllow: https://evil.example/');
    expect(button('https://user:pass@dev.auth.ixo.earth/').part).toBeNull();
  });

  it.each([
    ['a tab', 'https://dev.auth.ixo.earth/a\tb'],
    ['a newline', 'https://dev.auth.ixo.earth/a\nb'],
    ['a space', 'https://dev.auth.ixo.earth/a b'],
    ['a leading space', ' https://dev.auth.ixo.earth/'],
    ['a NUL', 'https://dev.auth.ixo.earth/\u0000'],
    ['a right-to-left override', 'https://dev.auth.ixo.earth/\u202e'],
    ['a zero-width space', 'https://dev\u200b.auth.ixo.earth/'],
    ['a no-break space', 'https://dev.auth.ixo.earth/\u00a0'],
  ])('%s is refused', (_name, raw) => {
    expect(safeHttpsUrl(raw)).toBeNull();
    expect(button(raw).part).toBeNull();
  });

  it('mixed case and a default port are approved and sent as the normalised href', () => {
    const built = button(
      'HTTPS://DEV.Auth.IXO.earth:443/Path?q=1',
      'HTTPS://IMG.example/A.jpg',
    );
    expect(built.part).toMatchObject({
      kind: 'link_button',
      text: 'Allow this.\n\nImage: https://img.example/A.jpg\n\nAllow: https://dev.auth.ixo.earth/Path?q=1',
      link: {
        url: 'https://dev.auth.ixo.earth/Path?q=1',
        imageUrl: 'https://img.example/A.jpg',
      },
    });
  });

  it('a trailing-dot host and an IDN look-alike are not the approved origin', () => {
    expect(button('https://dev.auth.ixo.earth./x').reason).toBe(
      'the link is not on an approved site',
    );
    // Cyrillic "е": the parsed ASCII origin is punycode.
    const lookAlike = 'https://d\u0435v.auth.ixo.earth/x';
    expect(safeHttpsUrl(lookAlike)?.origin).toMatch(/^https:\/\/xn--/);
    expect(button(lookAlike).reason).toBe(
      'the link is not on an approved site',
    );
  });

  it.each([
    [
      'http',
      'http://dev.auth.ixo.earth/x',
      'Allow this.\n\nAllow: http://dev.auth.ixo.earth/x',
    ],
    ['javascript:', 'javascript:alert(1)', 'Allow this.'],
    ['data:', 'data:text/html,<b>x</b>', 'Allow this.'],
    ['ftp', 'ftp://dev.auth.ixo.earth/x', 'Allow this.'],
  ])(
    '%s is refused; the text shows an http(s) href only',
    (_name, raw, text) => {
      expect(button(raw).part).toBeNull();
      expect(fallbackOf(raw)).toBe(text);
      expect(displayLink(raw)).toBe(raw.startsWith('http:') ? raw : null);
    },
  );

  it('an image link with whitespace or another scheme is refused', () => {
    expect(
      button('https://dev.auth.ixo.earth/x', 'https://img.example/a b.jpg')
        .reason,
    ).toContain('image');
    expect(
      button('https://dev.auth.ixo.earth/x', 'data:image/png;base64,AAAA')
        .reason,
    ).toContain('image');
  });

  it('cards: links and images are checked the same way and sent as hrefs', () => {
    const item = (url: string, imageUrl: string): CardItem => ({
      title: 'One',
      body: 'Text',
      imageUrl,
      link: { url, label: 'view' },
    });
    const ok = cardsPart(
      {
        body: 'Look:',
        items: [
          item('HTTPS://Dev.Auth.ixo.earth/a', 'HTTPS://IMG.example/1.jpg'),
        ],
      },
      AUTH,
    );
    expect(ok.part).toMatchObject({
      kind: 'cards',
      cards: {
        items: [
          {
            imageUrl: 'https://img.example/1.jpg',
            link: { url: 'https://dev.auth.ixo.earth/a' },
          },
        ],
      },
    });
    expect(ok.part.text).toContain('View: https://dev.auth.ixo.earth/a');
    for (const [url, image] of [
      [
        'https://dev.auth.ixo.earth\\@evil.example/',
        'https://img.example/1.jpg',
      ],
      ['https://dev.auth.ixo.earth@evil.example/', 'https://img.example/1.jpg'],
      ['https://dev.auth.ixo.earth/a', 'https://img.example/1 .jpg'],
      ['https://dev.auth.ixo.earth/a', 'javascript:alert(1)'],
    ]) {
      const built = cardsPart(
        { body: 'Look:', items: [item(url!, image!)] },
        AUTH,
      );
      expect(built.part.kind).toBe('text');
      expect(built.part.text).not.toContain('\\');
      expect(built.part.text).not.toContain('javascript:');
      expect(built.part.text).not.toContain('dev.auth.ixo.earth@');
    }
  });
});

describe('cardsPart', () => {
  const card = (n: number, change: Partial<CardItem> = {}): CardItem => ({
    title: `Beach clean-up ${n}`,
    body: 'Sat 9:00, Muizenberg',
    imageUrl: `https://img.example/${n}.jpg`,
    link: { url: `https://yoma.world/o/${n}`, label: 'register' },
    ...change,
  });

  it('one card is an image card; 2–10 a carousel', () => {
    expect(
      cardsPart({ body: 'Near you:', items: [card(1)] }, ALL).part.kind,
    ).toBe('cards');
    const ten = Array.from({ length: 10 }, (_, i) => card(i + 1));
    expect(cardsPart({ body: 'Near you:', items: ten }, ALL).part.kind).toBe(
      'cards',
    );
  });

  it('the text version numbers the cards, bolds titles, always has the image link and Label: url', () => {
    expect(cardsText('Near you:', [card(1), card(2)])).toBe(
      [
        'Near you:',
        '1. **Beach clean-up 1**\nSat 9:00, Muizenberg\nImage: https://img.example/1.jpg\nView & register: https://yoma.world/o/1',
        '2. **Beach clean-up 2**\nSat 9:00, Muizenberg\nImage: https://img.example/2.jpg\nView & register: https://yoma.world/o/2',
      ].join('\n\n'),
    );
  });

  it('carousel card text: exactly 160 with *title*\\n fits, 161 falls back', () => {
    const title = 'T';
    const fits = s(160 - 3 - title.length);
    expect(
      cardsPart(
        { body: 'x', items: [card(1, { title, body: fits }), card(2)] },
        ALL,
      ).reason,
    ).toBeNull();
    const built = cardsPart(
      { body: 'x', items: [card(1, { title, body: `${fits}b` }), card(2)] },
      ALL,
    );
    expect(built.part.kind).toBe('text');
    expect(built.reason).toContain('card 1');
  });

  it('carousel card text: one line break in the body fits, two fall back', () => {
    expect(
      cardsPart({ body: 'x', items: [card(1, { body: 'a\nb' }), card(2)] }, ALL)
        .reason,
    ).toBeNull();
    expect(
      cardsPart(
        { body: 'x', items: [card(1, { body: 'a\nb\nc' }), card(2)] },
        ALL,
      ).reason,
    ).toContain('line break');
    // One card alone takes a longer text.
    expect(
      cardsPart(
        { body: 'x', items: [card(1, { body: `${s(300)}\n\nmore` })] },
        ALL,
      ).reason,
    ).toBeNull();
  });

  it.each([
    [
      'an unapproved link',
      card(2, { link: { url: 'https://evil.example/o', label: 'view' } }),
    ],
    [
      'an unknown label',
      card(2, { link: { url: 'https://yoma.world/o', label: 'pay' } }),
    ],
    ['a non-https image', card(2, { imageUrl: 'http://img.example/2.jpg' })],
    ['a title with a line break', card(2, { title: 'a\nb' })],
    ['a title over 60', card(2, { title: s(61) })],
  ])('any card with %s sends all of them as text', (_name, bad) => {
    const built = cardsPart({ body: 'Near you:', items: [card(1), bad] }, ALL);
    expect(built.part).toEqual({
      kind: 'text',
      text: cardsText('Near you:', [card(1), bad]),
    });
    expect(built.reason).toContain('card 2');
  });

  it('needs the kind the count asks for', () => {
    expect(
      cardsPart(
        { body: 'x', items: [card(1), card(2)] },
        { ...ALL, kinds: ['card'] },
      ).reason,
    ).toContain('carousel');
    expect(
      cardsPart(
        { body: 'x', items: [card(1)] },
        { ...ALL, kinds: ['carousel'] },
      ).reason,
    ).toContain('image card');
    expect(
      cardsPart(
        { body: 'x', items: Array.from({ length: 11 }, (_, i) => card(i)) },
        ALL,
      ).reason,
    ).toContain('1 to 10');
  });
});

describe('the rich-message tools', () => {
  const ctx = (id: string) => makeRuntimeContext({ toolCallId: id });
  const byName = (render: RenderCapability) =>
    new Map(buildRichMessageTools(render).map((t) => [t.tool.name, t]));
  const call = async (t: PluginTool, args: unknown, id = 'c1') =>
    toolMessage(await t.handler(args, ctx(id)));

  it('are offered only for the kinds the gateway lists', () => {
    expect([...byName(ALL).keys()]).toEqual([
      OFFER_CHOICES_TOOL,
      SEND_LINK_BUTTON_TOOL,
      SEND_CARDS_TOOL,
    ]);
    expect([...byName({ ...ALL, kinds: ['list'] }).keys()]).toEqual([
      OFFER_CHOICES_TOOL,
    ]);
    expect([...byName({ ...ALL, linkOrigins: [] }).keys()]).toEqual([
      OFFER_CHOICES_TOOL,
    ]);
    expect([
      ...byName({ kinds: [], linkLabels: [], linkOrigins: [] }).keys(),
    ]).toEqual([]);
    expect(byName(ALL).get(OFFER_CHOICES_TOOL)?.returnDirect).toBe(true);
    expect(byName(ALL).get(SEND_LINK_BUTTON_TOOL)?.returnDirect).toBe(false);
  });

  it('offer_choices tells the model the format and the text, once per turn', async () => {
    const tool = byName(ALL).get(OFFER_CHOICES_TOOL)!.tool;
    const message = await call(tool, {
      question: 'Which size?',
      options: [{ id: 'small', title: 'Small' }, { title: 'Large' }],
    });
    const content = JSON.parse(String(message.content));
    expect(content).toMatchObject({
      status: 'asked',
      format: 'buttons',
      options: [
        { id: 'small', title: 'Small' },
        { id: '2', title: 'Large' },
      ],
      shown: 'Which size?\n\n1. Small\n2. Large',
    });
    expect(richPartsOf(message.artifact)).toHaveLength(1);
    expect(
      await tool.handler(
        { question: 'Again?', options: opts('A', 'B') },
        ctx('c2'),
      ),
    ).toContain('only one choices message');
  });

  it('send_link_button on an unapproved site goes out as text and says why', async () => {
    const tool = byName(ALL).get(SEND_LINK_BUTTON_TOOL)!.tool;
    const message = await call(tool, {
      text: 'Read this.',
      url: 'https://evil.example/a',
      label: 'open',
    });
    expect(JSON.parse(String(message.content))).toMatchObject({
      format: 'text',
      reason: 'the link is not on an approved site',
      shown: 'Read this.\n\nOpen: https://evil.example/a',
    });
    expect(richPartsOf(message.artifact)).toEqual([]);
  });
});

describe('rich parts in the plan', () => {
  const tools = new Map(
    buildRichMessageTools(ALL).map((t) => [t.tool.name, t.tool]),
  );
  const run = async (name: string, args: unknown, id: string) =>
    toolMessage(
      await tools
        .get(name)!
        .handler(args, makeRuntimeContext({ toolCallId: id })),
    );

  it('a choices part stands where its call stands, after the text before it, never merged', async () => {
    const result = await run(
      OFFER_CHOICES_TOOL,
      { question: 'Which size?', options: opts('Small', 'Large') },
      'c1',
    );
    const plan = await planOf([
      new HumanMessage('I want a T-shirt'),
      new AIMessage({
        content: 'Good choice.',
        tool_calls: [{ id: 'c1', name: OFFER_CHOICES_TOOL, args: {} }],
      }),
      result,
    ]);
    expect(plan.parts.map((p) => p.kind)).toEqual(['text', 'choices']);
    expect(plan.parts[0]).toMatchObject({ kind: 'text', text: 'Good choice.' });
    expect(planText(plan)).toBe(
      'Good choice.\n\nWhich size?\n\n1. Small\n2. Large',
    );
    expect(planTextForModel(plan)).toBe(planText(plan));
    // A stored plan reads back with its rich parts.
    expect(parseReplyPlan(JSON.stringify(plan))).toEqual(plan);
  });

  it('a short line before a link button is kept, and text after it follows it', async () => {
    const result = await run(
      SEND_LINK_BUTTON_TOOL,
      {
        text: 'Open your check.',
        url: 'https://dev.self.ixo.earth/l/abc',
        label: 'start_check',
      },
      'l1',
    );
    const plan = await planOf([
      new HumanMessage('Verify me'),
      new AIMessage({
        content: 'Here you go.',
        tool_calls: [{ id: 'l1', name: SEND_LINK_BUTTON_TOOL, args: {} }],
      }),
      result,
      new AIMessage('Tell me when you are done.'),
    ]);
    expect(
      plan.parts.map((p) => (p.kind === 'text' ? p.text : p.kind)),
    ).toEqual(['Here you go.', 'link_button', 'Tell me when you are done.']);
  });

  it('a link that went out as text is its own message where the call stands', async () => {
    const result = await run(
      SEND_LINK_BUTTON_TOOL,
      { text: 'Read this.', url: 'https://evil.example/a', label: 'open' },
      'l1',
    );
    const plan = await planOf([
      new HumanMessage('Send me the page'),
      new AIMessage({
        content: 'Sure.',
        tool_calls: [{ id: 'l1', name: SEND_LINK_BUTTON_TOOL, args: {} }],
      }),
      result,
      new AIMessage('Anything else?'),
    ]);
    expect(
      plan.parts.map((p) => (p.kind === 'text' ? p.text : p.kind)),
    ).toEqual([
      'Sure.',
      'Read this.\n\nOpen: https://evil.example/a',
      'Anything else?',
    ]);
  });

  it("a plugin's rich parts come after the reply and its standalone messages", async () => {
    const part = linkButtonPart(
      {
        body: 'Allow this.',
        url: 'https://dev.self.ixo.earth/c/1',
        label: 'allow',
        fallback: 'Allow this: https://dev.self.ixo.earth/c/1',
      },
      ALL,
    ).part!;
    const plan = await planOf([
      new HumanMessage('Start'),
      new AIMessage({
        content: '',
        tool_calls: [
          { id: 'p1', name: 'plugin_card', args: {} },
          { id: 'p2', name: 'plugin_code', args: {} },
        ],
      }),
      withRichParts(
        { toolCallId: 'p1' },
        { name: 'plugin_card', content: 'sent', parts: [part] },
      ),
      withStandaloneMessages(
        { toolCallId: 'p2' },
        { name: 'plugin_code', content: 'sent', messages: ['`1234`'] },
      ),
      new AIMessage('Please allow it.'),
    ]);
    expect(
      plan.parts.map((p) => (p.kind === 'text' ? p.text : p.kind)),
    ).toEqual(['Please allow it.', '`1234`', 'link_button']);
    expect(planText(plan)).toContain(
      'Allow this: https://dev.self.ixo.earth/c/1',
    );
  });

  it('withRichParts refuses parts that are not valid', () => {
    expect(() =>
      withRichParts({}, { name: 'x', content: '', parts: [] }),
    ).toThrow(TypeError);
  });
});

describe('delivery profile and prompt', () => {
  const channel = {
    provider: 'whatsapp',
    bindingId: 'chb_x',
    remoteMessageRef: 'hmac:x',
  };

  it('carries render on a channel turn only', () => {
    const profile = resolveDeliveryProfile({
      client: 'channel',
      channel: { ...channel, render: ALL },
    });
    expect(profile).toMatchObject({ kind: 'chat', render: ALL });
    expect(
      resolveDeliveryProfile({ client: 'channel', channel }),
    ).not.toHaveProperty('render');
    expect(
      resolveDeliveryProfile({
        client: 'portal',
        channel: { ...channel, render: ALL },
      }),
    ).toEqual({
      kind: 'stream',
    });
  });

  it('names the bound rich tools only, in its own section that the surface section leaves out', () => {
    const profile = resolveDeliveryProfile({
      client: 'channel',
      channel: { ...channel, render: ALL },
    });
    const withTools = renderRichSection([
      OFFER_CHOICES_TOOL,
      SEND_LINK_BUTTON_TOOL,
    ]);
    expect(withTools).toMatch(/^## Buttons in this chat/);
    expect(withTools).toContain('`offer_choices`');
    expect(withTools).toContain('`send_link_button`');
    expect(withTools).not.toContain('`send_cards`');
    expect(withTools).toContain(
      'take precedence over any instruction above to show choices as a numbered or bulleted list',
    );
    expect(withTools).toContain(
      'do not write those options in your text, neither as a list nor in a sentence',
    );
    expect(renderRichSection([])).toBe('');
    expect(renderSurfaceSection(profile, false, false)).not.toContain(
      'can show buttons',
    );
  });
});

describe('ChannelChoices', () => {
  it('a tap counts on a choice this session offered within 24 hours', async () => {
    const stub = env.SQLITE_TEST.get(
      env.SQLITE_TEST.idFromName('channel-choices'),
    );
    await runInDurableObject(stub, async (_instance, state) => {
      const db = await DoSqliteDatabase.open(state, 'choices.db');
      let now = 1_000_000;
      const choices = new ChannelChoices(db, () => now);
      const built = choicesPart(
        {
          body: 'Which size?',
          options: [{ key: 'small', title: 'Small' }, { title: 'Large' }],
        },
        ALL,
        '3f9a01c2',
      );
      const plan: ReplyPlan = {
        v: 1,
        parts: [
          { partId: 'p1', kind: 'text', text: 'Good choice.' },
          { partId: 'p2', ...built.part },
        ],
      };
      expect(await choices.record('s1', plan)).toBe(1);
      expect(await choices.resolve('s1', 'oc:3f9a01c2:small')).toEqual({
        id: 'oc:3f9a01c2:small',
        key: 'small',
        title: 'Small',
        question: 'Which size?',
      });
      // Another session, an option it never offered, a foreign id: text.
      expect(await choices.resolve('s2', 'oc:3f9a01c2:small')).toBeNull();
      expect(await choices.resolve('s1', 'oc:3f9a01c2:medium')).toBeNull();
      expect(await choices.resolve('s1', 'ab12cd34.t3')).toBeNull();
      // Stale after 24 hours.
      now += CHOICE_TTL_MS + 1;
      expect(await choices.resolve('s1', 'oc:3f9a01c2:small')).toBeNull();
      // A plan with no choices records nothing.
      expect(
        await choices.record('s1', {
          v: 1,
          parts: [{ partId: 'p1', kind: 'text', text: 'Hi' }],
        }),
      ).toBe(0);
    });
  });
});

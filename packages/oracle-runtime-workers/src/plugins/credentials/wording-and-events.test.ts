import { describe, expect, it } from 'vitest';
import { createMemoryUserKv } from '../../core/user-kv';
import type {
  IdentityCheckUpdatedEvent,
  PermissionAnsweredEvent,
} from '../../plugin-api/channel-events';
import type {
  PluginTool,
  RuntimeContext,
  UserKvSurface,
} from '../../plugin-api/types';
import { CREDENTIALS_KV_NAMESPACE } from './check-store';
import { VerifierEntryMemo } from './credentials-client';
import {
  ActionInput,
  createCredentials,
  createCredentialsTools,
  createPermissionEventHandler,
  PERMISSION_CARD_TTL_SECONDS,
  PERMISSION_EVENT_TEXT,
} from './credentials-tools';
import {
  CredentialsServiceError,
  MESSAGES,
  NO_LATER_MESSAGE,
  refusalFor,
} from './errors';
import {
  readLinkRecord,
  readPermissionRecord,
  recordLink,
  recordPermission,
  rememberPermissionCard,
} from './person-state';
import {
  channelCtx,
  HUB,
  ISSUER_DID,
  json,
  recordingUcan,
  routedFetch,
  SELF,
  testConfig,
  VCT,
  type RecordedCall,
} from './test-fixtures';

const NOW = Date.UTC(2026, 10, 11, 9, 0);
const CARD_URL = `${HUB}/a/card_1?t=permission`;
const LIST_URL = `${HUB}/api/internal/permissions?bindingId=bind_1&bindingRevision=3`;
const STATUS_URL = `${HUB}/api/internal/permissions/card_1`;
const LINKS = `${SELF}/identity/v1/links`;

const GRANTS = [
  {
    id: 'offer',
    can: 'credentials/offer',
    with: 'ixo:credentials',
    audience: 'did:ixo:entity:80f392610e8a128b4f4b1ed828dbeb7f',
    expiresAt: 4_000_000_000,
    token: 'OFFER_DELEGATION',
  },
  {
    id: 'link',
    can: 'identity/link',
    with: 'ixo:identity',
    audience: 'did:ixo:oracle',
    expiresAt: 4_000_000_000,
    token: 'LINK_DELEGATION',
  },
];
const allowedCard = {
  id: 'card_1',
  status: 'allowed',
  items: [
    {
      index: 0,
      kind: 'service-action',
      action: 'self.identity-check',
      grants: GRANTS,
    },
  ],
};

function tools(routes: Parameters<typeof routedFetch>[0]): {
  tools: Record<string, PluginTool>;
  calls: RecordedCall[];
} {
  const { fetchImpl, calls } = routedFetch(routes);
  const list = createCredentialsTools({
    cfg: testConfig(),
    oracle: { name: 'Yo! Agent' },
    verifier: null,
    memo: new VerifierEntryMemo(),
    fetchImpl,
    sleep: async () => undefined,
    now: () => NOW,
  });
  return {
    tools: Object.fromEntries(list.map((t) => [t.name, t])),
    calls,
  };
}

async function run(
  t: PluginTool | undefined,
  args: unknown,
  ctx: RuntimeContext,
) {
  if (!t) throw new Error('missing tool');
  return t.handler(args, ctx);
}

const cardRoute = {
  [`POST ${HUB}/api/internal/permissions`]: () =>
    json(
      {
        id: 'card_1',
        url: CARD_URL,
        status: 'pending',
        expiresAt: NOW / 1000 + 3600,
      },
      201,
    ),
};

describe('permission card sentences, chosen by what the card asks', () => {
  const cases: Array<[string, unknown[], string]> = [
    [
      'the identity check',
      [{ kind: 'service-action', action: 'self.identity-check' }],
      `This lets me send you a link for your identity check. Please tap this to allow: ${CARD_URL}`,
    ],
    [
      'the identity check with the identity credential check',
      [
        { kind: 'service-action', action: 'self.identity-check' },
        {
          kind: 'credential-check',
          vct: VCT,
          claims: ['age_over_18'],
          days: 30,
        },
      ],
      `This lets me send you a link for your identity check. Please tap this to allow: ${CARD_URL}`,
    ],
    [
      'the identity credential check',
      [
        {
          kind: 'credential-check',
          vct: VCT,
          claims: ['age_over_18'],
          days: 30,
        },
      ],
      `This lets me check that your identity is verified. Please tap this to allow: ${CARD_URL}`,
    ],
    [
      'an action this runtime has no sentence for',
      [{ kind: 'service-action', action: 'yo.rewards' }],
      `Please tap this to see what Yo! Agent is asking for, and allow it if you agree: ${CARD_URL}`,
    ],
    [
      'a known action mixed with an unknown one',
      [
        { kind: 'service-action', action: 'yo.rewards' },
        { kind: 'service-action', action: 'self.identity-check' },
      ],
      `Please tap this to see what Yo! Agent is asking for, and allow it if you agree: ${CARD_URL}`,
    ],
  ];
  it.each(cases)('%s', async (_name, items, message) => {
    const { adapter } = recordingUcan();
    const { tools: t } = tools(cardRoute);
    await expect(
      run(t.credentials_request_permissions, { items }, channelCtx(adapter)),
    ).resolves.toMatchObject({ status: 'sent', message });
  });

  it('asks the Hub for a card that waits one hour for an answer', async () => {
    const { adapter } = recordingUcan();
    const { tools: t, calls } = tools(cardRoute);
    await run(
      t.credentials_request_action_permission,
      { action: 'self.identity-check', days: 7 },
      channelCtx(adapter),
    );
    const post = calls.find((c) => c.method === 'POST');
    expect(PERMISSION_CARD_TTL_SECONDS).toBe(3600);
    expect(JSON.parse(post?.body ?? '').expiresAt).toBe(NOW / 1000 + 3600);
    // How long the permission lasts once allowed is unchanged.
    expect(JSON.parse(post?.body ?? '').permissions).toEqual([
      { kind: 'service-action', action: 'self.identity-check', days: 7 },
    ]);
  });
});

describe('the identity link message', () => {
  const linkRoutes = {
    [`GET ${LIST_URL}`]: () => json({ permissions: [allowedCard] }),
    [`POST ${LINKS}`]: () =>
      json(
        {
          linkId: 'lnk_1',
          url: 'https://dev.self.ixo.earth/l/tok',
          expiresAt: (NOW + 15 * 60_000) / 1000,
        },
        201,
      ),
  };

  it('opens on its own by default, and as the next step with context "next_step"', async () => {
    const { adapter } = recordingUcan();
    const { tools: t } = tools(linkRoutes);
    const ctx = channelCtx(adapter);
    await expect(
      run(t.credentials_request_action, { action: 'self.identity-check' }, ctx),
    ).resolves.toMatchObject({
      message:
        'To do your identity check, open this link. You will scan your ID document and take a selfie. The link works once and ends in 15 minutes: https://dev.self.ixo.earth/l/tok',
    });
    await expect(
      run(
        t.credentials_request_action,
        { action: 'self.identity-check', context: 'next_step' },
        { ...ctx, toolCallId: 'call-2' },
      ),
    ).resolves.toMatchObject({
      message:
        'Next, you need to do your identity check. Open this link. You will scan your ID document and take a selfie. The link works once and ends in 15 minutes: https://dev.self.ixo.earth/l/tok',
    });
  });

  it('takes only the two contexts, and nothing else (strict input)', () => {
    expect(ActionInput.parse({ action: 'self.identity-check' }).context).toBe(
      'standalone',
    );
    expect(() =>
      ActionInput.parse({ action: 'self.identity-check', context: 'later' }),
    ).toThrow();
    expect(() =>
      ActionInput.parse({ action: 'self.identity-check', extra: true }),
    ).toThrow();
  });
});

describe('link status messages', () => {
  const statusOf = (body: Record<string, unknown>) => ({
    [`GET ${LIST_URL}`]: () => json({ permissions: [allowedCard] }),
    [`GET ${LINKS}/lnk_1`]: () =>
      json({
        linkId: 'lnk_1',
        updatedAt: '2026-11-11T09:00:00.000Z',
        expiresAt: '2026-11-11T09:15:00.000Z',
        ...body,
      }),
  });
  const read = async (
    body: Record<string, unknown>,
    kv: UserKvSurface = createMemoryUserKv(),
  ) => {
    const { adapter } = recordingUcan();
    const { tools: t } = tools(statusOf(body));
    return run(
      t.credentials_action_status,
      { action: 'self.identity-check', ref: 'lnk_1' },
      channelCtx(adapter, { kv }),
    );
  };

  it.each([
    [
      'sent',
      "You haven't opened the link yet.",
      `Wait for them; do not poll. ${NO_LATER_MESSAGE}`,
    ],
    [
      'opened',
      "You opened the link but haven't started the check yet.",
      `Wait for them to go on; do not poll. ${NO_LATER_MESSAGE}`,
    ],
    [
      'in_progress',
      "Your identity check has started but isn't finished yet. Please finish the steps on the page you opened.",
      `Wait for them to finish; do not poll. ${NO_LATER_MESSAGE}`,
    ],
    [
      'passed',
      'Your identity check is done. You are verified.',
      'Go on with the task; credentials_check can now prove it.',
    ],
    [
      'failed',
      "Sorry, your identity check didn't pass.",
      'Offer a new link only if they want to try again.',
    ],
    [
      'expired',
      'That link has ended.',
      'Offer a new link only if they still want the check.',
    ],
    [
      'cancelled',
      'That link was stopped.',
      'Offer a new link only if they still want the check.',
    ],
  ])('%s', async (status, message, hint) => {
    const answer = await read({ status });
    expect(answer).toMatchObject({ status, message, hint });
    expect(answer).not.toHaveProperty('review');
  });

  it('says a person reviews it, and never promises a message', async () => {
    const answer = await read({ status: 'in_progress', review: true });
    expect(answer).toEqual({
      linkId: 'lnk_1',
      status: 'in_progress',
      review: true,
      updatedAt: Date.UTC(2026, 10, 11, 9, 0) / 1000,
      expiresAt: Date.UTC(2026, 10, 11, 9, 15) / 1000,
      message:
        "Thanks, your identity check is sent. Someone from our support team will look at it. Please check back later. You can ask me anytime, and I'll check how it's going.",
      hint: `A person reviews it; nothing tells you when it is done and you cannot message them first. ${NO_LATER_MESSAGE} Do not send a new link. Read the status again only when they write.`,
    });
  });

  it('reads an older Self (no field), a review on another status, or a value other than true as not in review', async () => {
    for (const body of [
      { status: 'in_progress' },
      { status: 'in_progress', review: 'yes' },
      { status: 'in_progress', review: false },
      { status: 'passed', review: true },
    ]) {
      const answer = await read(body);
      expect(answer).not.toHaveProperty('review');
      expect(answer).not.toMatchObject({ message: MESSAGES.inReview.message });
    }
  });

  it('keeps the review in the short-term status cache', async () => {
    const kv = createMemoryUserKv();
    await read({ status: 'in_progress', review: true }, kv);
    const kept = (await kv.get(CREDENTIALS_KV_NAMESPACE, 'link:lnk_1')) as {
      state: { review?: boolean };
    };
    expect(kept.state.review).toBe(true);
  });

  it('answers an open link in review with the review words (409), from the field or the status read last', async () => {
    const conflict = (review: boolean) => ({
      [`GET ${LIST_URL}`]: () => json({ permissions: [allowedCard] }),
      [`POST ${LINKS}`]: () =>
        json(
          {
            error: { code: 'link_active', message: 'x', retryable: false },
            linkId: 'lnk_1',
            status: 'in_progress',
            expiresAt: '2026-11-11T09:15:00.000Z',
            ...(review ? { review: true } : {}),
          },
          409,
        ),
      [`GET ${LINKS}/lnk_1`]: () =>
        json({
          linkId: 'lnk_1',
          status: 'in_progress',
          review: true,
          updatedAt: '2026-11-11T09:00:00.000Z',
          expiresAt: '2026-11-11T09:15:00.000Z',
        }),
    });
    const { adapter } = recordingUcan();
    // Self says so beside the 409.
    const first = tools(conflict(true)).tools;
    await expect(
      run(
        first.credentials_request_action,
        { action: 'self.identity-check' },
        channelCtx(adapter),
      ),
    ).resolves.toMatchObject({
      status: 'already_open',
      review: true,
      ...MESSAGES.inReview,
    });
    // An older Self: no field on the 409, but the status read last was in review.
    const kv = createMemoryUserKv();
    const second = tools(conflict(false)).tools;
    const ctx = channelCtx(adapter, { kv });
    await run(
      second.credentials_action_status,
      { action: 'self.identity-check', ref: 'lnk_1' },
      ctx,
    );
    await expect(
      run(
        second.credentials_request_action,
        { action: 'self.identity-check' },
        { ...ctx, toolCallId: 'call-2' },
      ),
    ).resolves.toMatchObject({
      status: 'already_open',
      review: true,
      ...MESSAGES.inReview,
    });
    // Without either: the in-progress words.
    const third = tools(conflict(false)).tools;
    await expect(
      run(
        third.credentials_request_action,
        { action: 'self.identity-check' },
        channelCtx(adapter),
      ),
    ).resolves.toMatchObject({
      status: 'already_open',
      message: expect.stringContaining('already in progress'),
    });
  });

  it('refusalFor maps a 409 in review to the review words', () => {
    expect(
      refusalFor(
        new CredentialsServiceError({
          service: 'self',
          status: 409,
          code: 'link_active',
          body: { status: 'in_progress', review: true },
        }),
      ),
    ).toEqual({ error: 'link_active', ...MESSAGES.inReview });
  });
});

describe('permission events', () => {
  const event = (
    status: PermissionAnsweredEvent['status'],
    permissionId = 'card_1',
  ): PermissionAnsweredEvent => ({
    kind: 'permission_answered',
    permissionId,
    status,
    requestId: `permission:${permissionId}:${status}`,
  });
  const hubSays = (status: string) => ({
    [`GET ${STATUS_URL}`]: () =>
      json({
        id: 'card_1',
        status,
        items: [
          {
            index: 0,
            kind: 'service-action',
            action: 'self.identity-check',
            ...(status === 'allowed' ? { grants: GRANTS } : {}),
          },
        ],
      }),
  });
  async function setup(
    hubStatus: string,
    record: (kv: UserKvSurface) => Promise<void> = (kv) =>
      recordPermission(kv, 'card_1', ['service-action'], CARD_URL, {
        actions: ['self.identity-check'],
      }),
  ) {
    const { adapter } = recordingUcan();
    const { fetchImpl, calls } = routedFetch(hubSays(hubStatus));
    const kv = createMemoryUserKv();
    await record(kv);
    const warnings: string[] = [];
    const base = channelCtx(adapter, { kv });
    const ctx: RuntimeContext = {
      ...base,
      logger: { ...base.logger, warn: (m: string) => void warnings.push(m) },
    };
    const handle = createPermissionEventHandler({
      cfg: testConfig(),
      fetchImpl,
      sleep: async () => undefined,
      now: () => NOW,
    });
    return { handle, ctx, kv, calls, warnings };
  }

  it('allowed: reads the card at the Hub, then lets the agent go on with the identity link after the fixed sentence', async () => {
    const { handle, ctx, kv, calls } = await setup('allowed');
    const answer = await handle(event('allowed'), ctx);
    expect(answer.kind).toBe('agent');
    const note = answer.kind === 'agent' ? answer.note : '';
    expect(note).toContain(`"${PERMISSION_EVENT_TEXT.allowed}"`);
    expect(note).toContain('(it asked for: self.identity-check)');
    expect(note).toContain(
      'call credentials_request_action with action "self.identity-check" and context "next_step"',
    );
    expect(note).toContain(NO_LATER_MESSAGE);
    expect(calls.map((c) => `${c.method} ${c.url}`)).toEqual([
      `GET ${STATUS_URL}`,
    ]);
    expect(await readPermissionRecord(kv, 'card_1')).toMatchObject({
      told: { status: 'allowed', requestId: 'permission:card_1:allowed' },
      seen: 'allowed',
    });
  });

  it('not allowed: the fixed sentence, sent without the model', async () => {
    const { handle, ctx } = await setup('declined');
    await expect(handle(event('not_allowed'), ctx)).resolves.toMatchObject({
      kind: 'reply',
      text: 'No problem, nothing was shared. Tell me if you change your mind.',
      note: expect.stringContaining("They chose Don't allow"),
    });
  });

  it('expired: the fixed sentence, sent without the model', async () => {
    const { handle, ctx } = await setup('expired');
    await expect(handle(event('expired'), ctx)).resolves.toMatchObject({
      kind: 'reply',
      text: 'That link has run out. Shall I send a new one?',
    });
  });

  it("passes on a card this person's kv does not hold, without asking the Hub", async () => {
    const { handle, ctx, calls } = await setup('allowed');
    await expect(handle(event('allowed', 'card_other'), ctx)).resolves.toEqual({
      kind: 'pass',
    });
    expect(calls).toHaveLength(0);
  });

  it('ignores a forged or stale event the Hub does not confirm, and tells nothing', async () => {
    for (const [claimed, hub] of [
      ['allowed', 'pending'],
      ['allowed', 'declined'],
      ['not_allowed', 'allowed'],
      ['expired', 'stopped'],
    ] as const) {
      const { handle, ctx, kv, warnings } = await setup(hub);
      await expect(handle(event(claimed), ctx)).resolves.toEqual({
        kind: 'ignore',
      });
      expect((await readPermissionRecord(kv, 'card_1'))?.told).toBeUndefined();
      expect(warnings.join('\n')).toContain('not confirmed');
    }
  });

  it('ignores a duplicate of a told answer, while the same event asked again (a restart) answers again', async () => {
    const { handle, ctx, calls } = await setup('allowed');
    await handle(event('allowed'), ctx);
    // The same request again (the run restarted before its decision was kept).
    await expect(handle(event('allowed'), ctx)).resolves.toMatchObject({
      kind: 'agent',
    });
    // The same card and answer under any other request: nothing more is said.
    await expect(
      handle(
        { ...event('allowed'), requestId: 'permission:card_1:allowed:2' },
        ctx,
      ),
    ).resolves.toEqual({ kind: 'ignore' });
    expect(calls).toHaveLength(2);
  });

  it('stays silent when the person already learned the answer in the chat', async () => {
    const { adapter } = recordingUcan();
    const { handle, ctx, kv, calls } = await setup('allowed');
    // A tool read the card as allowed during the person's own turn.
    const { tools: t } = tools(hubSays('allowed'));
    await run(
      t.credentials_permission_status,
      { permissionId: 'card_1' },
      channelCtx(adapter, { kv }),
    );
    expect((await readPermissionRecord(kv, 'card_1'))?.seen).toBe('allowed');
    await expect(handle(event('allowed'), ctx)).resolves.toEqual({
      kind: 'ignore',
    });
    expect(calls).toHaveLength(0);
  });

  it('ignores the event when the Hub cannot be read, and logs why', async () => {
    const { adapter } = recordingUcan();
    const kv = createMemoryUserKv();
    await recordPermission(kv, 'card_1', ['service-action'], CARD_URL, {
      actions: ['self.identity-check'],
    });
    const { fetchImpl } = routedFetch({
      [`GET ${STATUS_URL}`]: () => json({ error: 'unavailable' }, 503),
    });
    const warnings: string[] = [];
    const base = channelCtx(adapter, { kv });
    const handle = createPermissionEventHandler({
      cfg: testConfig(),
      fetchImpl,
      sleep: async () => undefined,
      now: () => NOW,
    });
    await expect(
      handle(event('allowed'), {
        ...base,
        logger: { ...base.logger, warn: (m: string) => void warnings.push(m) },
      }),
    ).resolves.toEqual({ kind: 'ignore' });
    expect(warnings.join('\n')).toContain('hub_unread (hub_503_unavailable)');
  });

  it('ignores the event outside our WhatsApp channel', async () => {
    const { adapter } = recordingUcan();
    const { handle, kv, calls } = await setup('allowed');
    await expect(
      handle(event('allowed'), channelCtx(adapter, { kv, client: 'portal' })),
    ).resolves.toEqual({ kind: 'ignore' });
    expect(calls).toHaveLength(0);
  });

  it("another plugin's card: recorded with rememberPermissionCard, answered with its own next step", async () => {
    const { handle, ctx } = await setup('allowed', (kv) =>
      rememberPermissionCard(kv, {
        permissionId: 'card_1',
        items: [
          { kind: 'service-action', action: 'yo.rewards', days: 30 },
          { kind: 'service-action', action: 'self.identity-check' },
          {
            kind: 'credential-check',
            vct: VCT,
            issuers: [ISSUER_DID],
            claims: ['age_over_18'],
            days: 30,
          },
        ],
        url: CARD_URL,
        next: 'call rewards_claim and send its message right after that sentence',
      }),
    );
    const answer = await handle(event('allowed'), ctx);
    expect(answer).toMatchObject({ kind: 'agent' });
    const note = answer.kind === 'agent' ? answer.note : '';
    expect(note).toContain(
      `(it asked for: yo.rewards, self.identity-check, a check of ${VCT})`,
    );
    expect(note).toContain(
      'Then, in the same message, call rewards_claim and send its message right after that sentence.',
    );
    expect(note).not.toContain('credentials_request_action');
  });

  it('refuses a next step longer than 600 characters', async () => {
    await expect(
      rememberPermissionCard(createMemoryUserKv(), {
        permissionId: 'card_1',
        items: [{ kind: 'service-action', action: 'yo.rewards' }],
        next: 'x'.repeat(601),
      }),
    ).rejects.toThrow(RangeError);
  });

  it('keeps what a card asked, its answers and its link when it is recorded again without them', async () => {
    const kv = createMemoryUserKv();
    await rememberPermissionCard(kv, {
      permissionId: 'card_1',
      items: [{ kind: 'service-action', action: 'yo.rewards' }],
      url: CARD_URL,
      next: 'go on',
    });
    await recordPermission(kv, 'card_1', ['service-action']);
    expect(await readPermissionRecord(kv, 'card_1')).toEqual({
      id: 'card_1',
      kinds: ['service-action'],
      url: CARD_URL,
      actions: ['yo.rewards'],
      vcts: [],
      next: 'go on',
    });
  });
});

describe('identity-check events', () => {
  const event = (
    status: IdentityCheckUpdatedEvent['status'],
    requestId = `identity:lnk_1:${status}`,
  ): IdentityCheckUpdatedEvent => ({
    kind: 'identity_check_updated',
    linkId: 'lnk_1',
    status,
    requestId,
  });
  const selfSays = (body: Record<string, unknown>) => ({
    [`GET ${LIST_URL}`]: () => json({ permissions: [allowedCard] }),
    [`GET ${LINKS}/lnk_1`]: () =>
      json({
        linkId: 'lnk_1',
        updatedAt: '2026-11-11T09:00:00.000Z',
        expiresAt: '2026-11-11T09:15:00.000Z',
        ...body,
      }),
  });
  async function setup(
    body: Record<string, unknown>,
    record: (kv: UserKvSurface) => Promise<void> = (kv) =>
      recordLink(kv, 'lnk_1', 'card_1'),
  ) {
    const { adapter } = recordingUcan();
    const { fetchImpl, calls } = routedFetch(selfSays(body));
    const kv = createMemoryUserKv();
    await record(kv);
    const warnings: string[] = [];
    const base = channelCtx(adapter, { kv });
    const ctx: RuntimeContext = {
      ...base,
      logger: { ...base.logger, warn: (m: string) => void warnings.push(m) },
    };
    const kit = createCredentials({
      cfg: testConfig(),
      oracle: { name: '' },
      verifier: null,
      memo: new VerifierEntryMemo(),
      fetchImpl,
      sleep: async () => undefined,
      now: () => NOW,
    });
    const selfReads = () =>
      calls.filter((c) => c.url === `${LINKS}/lnk_1`).length;
    return {
      handle: kit.identityCheckEvent,
      ctx,
      kv,
      calls,
      warnings,
      selfReads,
    };
  }

  it('records the link it made, with the card whose grants made it', async () => {
    const { adapter } = recordingUcan();
    const kv = createMemoryUserKv();
    const { tools: t } = tools({
      [`GET ${LIST_URL}`]: () => json({ permissions: [allowedCard] }),
      [`POST ${LINKS}`]: () =>
        json(
          {
            linkId: 'lnk_1',
            url: 'https://dev.self.ixo.earth/l/tok',
            expiresAt: (NOW + 15 * 60_000) / 1000,
          },
          201,
        ),
    });
    await run(
      t.credentials_request_action,
      { action: 'self.identity-check' },
      channelCtx(adapter, { kv }),
    );
    expect(await readLinkRecord(kv, 'lnk_1')).toEqual({
      linkId: 'lnk_1',
      permissionId: 'card_1',
    });
  });

  it('passed: reads Self first, then lets the agent go on after the fixed sentence', async () => {
    const { handle, ctx, kv, selfReads } = await setup({ status: 'passed' });
    const answer = await handle(event('passed'), ctx);
    expect(answer.kind).toBe('agent');
    const note = answer.kind === 'agent' ? answer.note : '';
    expect(note).toContain('"Your identity check is done. You are verified."');
    expect(note).toContain('go on with the task you were on');
    expect(note).toContain(NO_LATER_MESSAGE);
    expect(selfReads()).toBe(1);
    expect(await readLinkRecord(kv, 'lnk_1')).toMatchObject({
      told: { status: 'passed', requestId: 'identity:lnk_1:passed' },
      seen: 'passed',
    });
  });

  it("passed: another plugin's card goes on with its verifiedNext words", async () => {
    const { handle, ctx } = await setup({ status: 'passed' }, async (kv) => {
      await rememberPermissionCard(kv, {
        permissionId: 'card_1',
        items: [
          { kind: 'service-action', action: 'yo.rewards' },
          { kind: 'service-action', action: 'self.identity-check' },
        ],
        verifiedNext:
          'call rewards_claim and send its message right after that sentence',
      });
      await recordLink(kv, 'lnk_1', 'card_1');
    });
    const answer = await handle(event('passed'), ctx);
    expect(answer.kind === 'agent' && answer.note).toContain(
      'Then, in the same message, call rewards_claim and send its message right after that sentence.',
    );
  });

  it('failed and in review: the fixed sentences, sent without the model', async () => {
    const failed = await setup({ status: 'failed' });
    await expect(
      failed.handle(event('failed'), failed.ctx),
    ).resolves.toMatchObject({
      kind: 'reply',
      text: "Sorry, your identity check didn't pass.",
      note: expect.stringContaining(
        'Offer a new link only if they want to try again.',
      ),
    });
    const review = await setup({ status: 'in_progress', review: true });
    await expect(
      review.handle(event('in_review'), review.ctx),
    ).resolves.toMatchObject({
      kind: 'reply',
      text: MESSAGES.inReview.message,
    });
  });

  it('follows Self, not the event: a forged or stale status says only what Self says', async () => {
    // The event claims passed; Self says failed: the failed words.
    const differs = await setup({ status: 'failed' });
    await expect(
      differs.handle(event('passed'), differs.ctx),
    ).resolves.toMatchObject({
      kind: 'reply',
      text: "Sorry, your identity check didn't pass.",
    });
    expect(differs.warnings.join('\n')).toContain('following Self');
    // Self says the check is still going (or an older Self without review): nothing.
    for (const body of [
      { status: 'in_progress' },
      { status: 'opened' },
      { status: 'expired' },
    ]) {
      const still = await setup(body);
      await expect(still.handle(event('passed'), still.ctx)).resolves.toEqual({
        kind: 'ignore',
      });
      expect((await readLinkRecord(still.kv, 'lnk_1'))?.told).toBeUndefined();
    }
  });

  it("passes on a link this person's kv does not hold, without asking Self", async () => {
    const { handle, ctx, calls } = await setup(
      { status: 'passed' },
      async () => undefined,
    );
    await expect(handle(event('passed'), ctx)).resolves.toEqual({
      kind: 'pass',
    });
    expect(calls).toHaveLength(0);
  });

  it('ignores a duplicate without asking Self again, while the same event asked again answers again', async () => {
    const { handle, ctx, selfReads } = await setup({ status: 'passed' });
    await handle(event('passed'), ctx);
    await expect(handle(event('passed'), ctx)).resolves.toMatchObject({
      kind: 'agent',
    });
    await expect(
      handle(event('passed', 'identity:lnk_1:passed:2'), ctx),
    ).resolves.toEqual({ kind: 'ignore' });
    expect(selfReads()).toBe(2);
  });

  it('stays silent when the person already learned the outcome in the chat', async () => {
    const { adapter } = recordingUcan();
    const { handle, ctx, kv, selfReads } = await setup({
      status: 'in_progress',
      review: true,
    });
    // The person asked first: credentials_action_status read "in review".
    const { tools: t } = tools(
      selfSays({ status: 'in_progress', review: true }),
    );
    await run(
      t.credentials_action_status,
      { action: 'self.identity-check', ref: 'lnk_1' },
      channelCtx(adapter, { kv }),
    );
    expect((await readLinkRecord(kv, 'lnk_1'))?.seen).toBe('in_review');
    await expect(handle(event('in_review'), ctx)).resolves.toEqual({
      kind: 'ignore',
    });
    expect(selfReads()).toBe(0);
  });

  it('ignores the event when Self cannot be read, and logs why', async () => {
    const { adapter } = recordingUcan();
    const kv = createMemoryUserKv();
    await recordLink(kv, 'lnk_1', 'card_1');
    const { fetchImpl } = routedFetch({
      [`GET ${LIST_URL}`]: () => json({ permissions: [allowedCard] }),
      [`GET ${LINKS}/lnk_1`]: () => json({ error: 'unavailable' }, 503),
    });
    const warnings: string[] = [];
    const base = channelCtx(adapter, { kv });
    const kit = createCredentials({
      cfg: testConfig(),
      oracle: { name: '' },
      verifier: null,
      memo: new VerifierEntryMemo(),
      fetchImpl,
      sleep: async () => undefined,
      now: () => NOW,
    });
    await expect(
      kit.identityCheckEvent(event('passed'), {
        ...base,
        logger: { ...base.logger, warn: (m: string) => void warnings.push(m) },
      }),
    ).resolves.toEqual({ kind: 'ignore' });
    expect(warnings.join('\n')).toContain('identity check event: self_unread');
  });
});

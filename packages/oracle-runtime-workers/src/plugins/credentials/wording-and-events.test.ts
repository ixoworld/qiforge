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
  lastLinkState,
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
      'The check is done. Go on with the task you were doing (a next step you were given comes first); call credentials_check only if this oracle itself needs to read a claim from the credential for its own decision.',
    ],
    [
      'failed',
      "Sorry, your identity check didn't pass.",
      `Offer a new link only if they want to try again. ${NO_LATER_MESSAGE}`,
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

  it('says the check passed and the proof is being saved, never that it is unfinished', async () => {
    const answer = await read({ status: 'in_progress', saving: true });
    expect(answer).toEqual({
      linkId: 'lnk_1',
      status: 'in_progress',
      saving: true,
      updatedAt: Date.UTC(2026, 10, 11, 9, 0) / 1000,
      expiresAt: Date.UTC(2026, 10, 11, 9, 15) / 1000,
      message:
        'You passed your identity check. Your proof is being saved; this can take a minute. Please ask me again shortly.',
      hint: `The check is done and approved; their proof is still being saved to their IXO account. Do not send a new link and do not say the check is unfinished. ${NO_LATER_MESSAGE} Read the status again when they next write.`,
    });
  });

  it('reads an older Self (no field), saving on another status, or a value other than true as not saving', async () => {
    for (const body of [
      { status: 'in_progress' },
      { status: 'in_progress', saving: 'yes' },
      { status: 'in_progress', saving: false },
      { status: 'passed', saving: true },
    ]) {
      const answer = await read(body);
      expect(answer).not.toHaveProperty('saving');
      expect(answer).not.toMatchObject({ message: MESSAGES.saving.message });
    }
  });

  it('keeps saving in the short-term status cache, and tells no identity outcome for it', async () => {
    const kv = createMemoryUserKv();
    await read({ status: 'in_progress', saving: true }, kv);
    const kept = (await kv.get(CREDENTIALS_KV_NAMESPACE, 'link:lnk_1')) as {
      state: { saving?: boolean; review?: boolean };
    };
    expect(kept.state.saving).toBe(true);
    expect(kept.state.review).toBeUndefined();
    // A row kept before the field existed still reads.
    await kv.set(CREDENTIALS_KV_NAMESPACE, 'link:lnk_1', {
      at: NOW,
      state: {
        linkId: 'lnk_1',
        status: 'in_progress',
        updatedAt: 1,
        expiresAt: 2,
      },
    });
    expect(await lastLinkState(kv, 'lnk_1')).toEqual({
      linkId: 'lnk_1',
      status: 'in_progress',
      updatedAt: 1,
      expiresAt: 2,
    });
  });

  it.each([
    [
      'error',
      'Sorry, something went wrong with your identity check. Please ask me for a new link to try again.',
      'It was a problem on our side, not about them',
      'do not say they failed or were not verified',
    ],
    [
      'too_many_attempts',
      'Your identity check ran out of tries. Please ask me for a new link to try again.',
      'They used up their tries',
      'do not say they were refused',
    ],
  ])(
    'failed with failure %s: its own words, never "didn\'t pass"',
    async (failure, message, why, never) => {
      const answer = await read({ status: 'failed', failure });
      expect(answer).toMatchObject({ status: 'failed', failure, message });
      const hint = (answer as { hint: string }).hint;
      expect(hint).toContain(why);
      expect(hint).toContain(never);
      expect(hint).toContain('Offer them a new link');
      expect(hint).toContain(NO_LATER_MESSAGE);
      expect(JSON.stringify(answer)).not.toContain("didn't pass");
    },
  );

  it('reads an unknown failure, a wrong type, or failure on another status as the default words', async () => {
    for (const body of [
      { status: 'failed', failure: 'rate_limited' },
      { status: 'failed', failure: 7 },
      { status: 'failed', failure: true },
      { status: 'failed', failure: ['error'] },
    ]) {
      const answer = await read(body);
      expect(answer).toMatchObject({
        status: 'failed',
        message: "Sorry, your identity check didn't pass.",
      });
      expect(answer).not.toHaveProperty('failure');
      expect(answer).not.toHaveProperty('error');
    }
    for (const status of ['passed', 'in_progress', 'expired']) {
      const answer = await read({ status, failure: 'error' });
      expect(answer).toMatchObject({ status });
      expect(answer).not.toHaveProperty('failure');
      expect(answer).not.toMatchObject({
        message: expect.stringContaining('something went wrong'),
      });
    }
  });

  it('keeps failure with the failed status in the cache, and a later read says the same thing', async () => {
    const kv = createMemoryUserKv();
    const first = await read({ status: 'failed', failure: 'error' }, kv);
    const kept = (await kv.get(CREDENTIALS_KV_NAMESPACE, 'link:lnk_1')) as {
      state: { status?: string; failure?: string };
    };
    expect(kept.state).toMatchObject({ status: 'failed', failure: 'error' });
    // Self now answers without the field: the final status read last decides.
    const again = await read({ status: 'failed' }, kv);
    expect(again).toEqual(first);
    // A row kept before the field existed, or with a value no longer known,
    // reads with the default words.
    for (const failure of [undefined, 'something_new']) {
      await kv.set(CREDENTIALS_KV_NAMESPACE, 'link:lnk_1', {
        at: NOW,
        state: {
          linkId: 'lnk_1',
          status: 'failed',
          updatedAt: 1,
          expiresAt: 2,
          ...(failure ? { failure } : {}),
        },
      });
      expect(await lastLinkState(kv, 'lnk_1')).toEqual({
        linkId: 'lnk_1',
        status: 'failed',
        updatedAt: 1,
        expiresAt: 2,
      });
      await expect(
        read({ status: 'failed', failure: 'error' }, kv),
      ).resolves.toMatchObject({
        message: "Sorry, your identity check didn't pass.",
      });
    }
  });

  it('answers an open link being saved with the saving words (409), from the field or the status read last', async () => {
    const conflict = (saving: boolean) => ({
      [`GET ${LIST_URL}`]: () => json({ permissions: [allowedCard] }),
      [`POST ${LINKS}`]: () =>
        json(
          {
            error: { code: 'link_active', message: 'x', retryable: false },
            linkId: 'lnk_1',
            status: 'in_progress',
            expiresAt: '2026-11-11T09:15:00.000Z',
            ...(saving ? { saving: true } : {}),
          },
          409,
        ),
      [`GET ${LINKS}/lnk_1`]: () =>
        json({
          linkId: 'lnk_1',
          status: 'in_progress',
          saving: true,
          updatedAt: '2026-11-11T09:00:00.000Z',
          expiresAt: '2026-11-11T09:15:00.000Z',
        }),
    });
    const { adapter } = recordingUcan();
    await expect(
      run(
        tools(conflict(true)).tools.credentials_request_action,
        { action: 'self.identity-check' },
        channelCtx(adapter),
      ),
    ).resolves.toMatchObject({
      status: 'already_open',
      saving: true,
      ...MESSAGES.saving,
    });
    const kv = createMemoryUserKv();
    const second = tools(conflict(false)).tools;
    const ctx = channelCtx(adapter, { kv });
    await run(
      second.credentials_action_status,
      { action: 'self.identity-check', ref: 'lnk_1' },
      ctx,
    );
    const answer = await run(
      second.credentials_request_action,
      { action: 'self.identity-check' },
      { ...ctx, toolCallId: 'call-2' },
    );
    expect(answer).toMatchObject({
      status: 'already_open',
      saving: true,
      ...MESSAGES.saving,
    });
    expect(answer).not.toHaveProperty('review');
  });

  it('refusalFor maps a 409 being saved to the saving words', () => {
    expect(
      refusalFor(
        new CredentialsServiceError({
          service: 'self',
          status: 409,
          code: 'link_active',
          body: { status: 'in_progress', saving: true },
        }),
      ),
    ).toEqual({ error: 'link_active', ...MESSAGES.saving });
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
      'Then, in the same message, do exactly this next step (set by the plugin that sent the card), and nothing before it: call rewards_claim and send its message right after that sentence. That is the only next step: do not add credentials_check or any other call it does not name',
    );
    expect(note).not.toContain('credentials_request_action');
    expect(note).toContain(
      'call load_capability only for a tool the step needs that you do not have',
    );
  });

  it('allowed, then already_verified: the scripted next step never adds a credentials_check', async () => {
    // As the Yo rewards plugin records it: the identity link next, and the
    // claim instead when the person is already verified.
    const claim =
      'continue their reward claim: call rewards_claim with the campaignId from rewards_list (call rewards_list first if you lack it)';
    const { handle, ctx } = await setup('allowed', (kv) =>
      rememberPermissionCard(kv, {
        permissionId: 'card_1',
        items: [
          { kind: 'service-action', action: 'yo.rewards', days: 30 },
          { kind: 'service-action', action: 'self.identity-check' },
        ],
        url: CARD_URL,
        next: `send their identity check link: call credentials_request_action with action "self.identity-check" and context "next_step". If it answers already_verified, instead ${claim}`,
        verifiedNext: claim,
      }),
    );
    const answer = await handle(event('allowed'), ctx);
    const note = answer.kind === 'agent' ? answer.note : '';
    // The note names the plugin's step as the only one, and forbids an
    // extra credentials_check.
    expect(note).toContain(`and nothing before it: send their identity`);
    expect(note).toContain('do not add credentials_check');
    expect(note).not.toMatch(/(?<!add )credentials_check (for|can|instead)/);
    // The tool's already_verified answer sends the model back to that step.
    const verified = refusalFor(
      new CredentialsServiceError({
        service: 'self',
        status: 409,
        code: 'already_verified',
      }),
    );
    expect(verified.error).toBe('already_verified');
    expect(verified.hint).toContain('Go on with the task you were doing');
    expect(verified.hint).toContain('do exactly that step and nothing else');
    expect(verified.hint).toContain(
      'Call credentials_check only if this oracle itself needs to read a claim from the credential for its own decision and no next step was given.',
    );
    expect(verified.hint).not.toContain('use credentials_check instead');
  });

  it('allowed identity card without a plugin step: an already_verified link goes on with the task, credentials_check only for its own decision', async () => {
    const { handle, ctx } = await setup('allowed');
    const answer = await handle(event('allowed'), ctx);
    const note = answer.kind === 'agent' ? answer.note : '';
    expect(note).toContain(
      'if it answers already_verified, they are verified: go on with the task; call credentials_check only if this oracle itself needs to read a claim from the credential for its own decision',
    );
    expect(note).toContain(
      'call load_capability only for a tool the step needs that you do not have',
    );
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
      // Kept so the same unopened link can be sent again.
      url: 'https://dev.self.ixo.earth/l/tok',
      expiresAt: (NOW + 15 * 60_000) / 1000,
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
    const note = answer.kind === 'agent' ? answer.note : '';
    expect(note).toContain(
      'Then, in the same message, do exactly this next step (set by the plugin that asked for the check), and nothing before it: call rewards_claim and send its message right after that sentence. That is the only next step: do not add credentials_check',
    );
    expect(note).not.toContain('credentials_check can now prove it');
  });

  it("passed without a plugin step: credentials_check only for the oracle's own decision", async () => {
    const { handle, ctx } = await setup({ status: 'passed' });
    const answer = await handle(event('passed'), ctx);
    const note = answer.kind === 'agent' ? answer.note : '';
    expect(note).toContain(
      'go on with the task you were on, the one that needed the identity check (call credentials_check only if this oracle itself needs to read a claim from the credential for its own decision).',
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

  it.each([
    [
      'error',
      'Sorry, something went wrong with your identity check. Please ask me for a new link to try again.',
      'a problem on our side, not a decision about them',
    ],
    [
      'too_many_attempts',
      'Your identity check ran out of tries. Please ask me for a new link to try again.',
      'they used up their tries',
    ],
  ])(
    'failed with failure %s: its own fixed sentence after re-reading Self',
    async (failure, text, why) => {
      const { handle, ctx, kv, selfReads } = await setup({
        status: 'failed',
        failure,
      });
      const answer = await handle(event('failed'), ctx);
      expect(answer).toMatchObject({ kind: 'reply', text });
      const note = answer.kind === 'reply' ? answer.note : '';
      expect(note).toContain(why);
      expect(note).toContain(`they were told: "${text}"`);
      expect(note).toContain(NO_LATER_MESSAGE);
      expect(note).not.toContain('did not pass');
      expect(selfReads()).toBe(1);
      // The cache keeps the cause: a later status read says the same.
      expect(await lastLinkState(kv, 'lnk_1')).toMatchObject({
        status: 'failed',
        failure,
      });
    },
  );

  it('failed with an unknown or mistyped failure: the default sentence', async () => {
    for (const failure of ['rate_limited', 3, null]) {
      const { handle, ctx } = await setup({ status: 'failed', failure });
      const answer = await handle(event('failed'), ctx);
      expect(answer).toMatchObject({
        kind: 'reply',
        text: "Sorry, your identity check didn't pass.",
        note: expect.stringContaining('Their identity check did not pass'),
      });
    }
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
      { status: 'in_progress', saving: true },
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

describe('identity-check starts: tries left and when they can try again', () => {
  const iso = (seconds: number) => new Date(NOW + seconds * 1000).toISOString();
  const FIVE_HOURS = 5 * 3600;
  const atLimit = {
    resetsAt: iso(FIVE_HOURS),
    retryAfterSeconds: FIVE_HOURS,
    startsLeft: 0,
    startsMax: 3,
    windowHours: 6,
  };
  const statusRoutes = (body: Record<string, unknown>) => ({
    [`GET ${LIST_URL}`]: () => json({ permissions: [allowedCard] }),
    [`GET ${LINKS}/lnk_1`]: () =>
      json({
        linkId: 'lnk_1',
        updatedAt: '2026-11-11T09:00:00.000Z',
        expiresAt: '2026-11-11T09:15:00.000Z',
        ...body,
      }),
  });
  const status = async (body: Record<string, unknown>) => {
    const { adapter } = recordingUcan();
    const { tools: t } = tools(statusRoutes(body));
    return (await run(
      t.credentials_action_status,
      { action: 'self.identity-check', ref: 'lnk_1' },
      channelCtx(adapter),
    )) as Record<string, unknown> & { message: string; hint: string };
  };
  const eventReply = async (body: Record<string, unknown>) => {
    const { adapter } = recordingUcan();
    const { fetchImpl } = routedFetch(statusRoutes(body));
    const kv = createMemoryUserKv();
    await recordLink(kv, 'lnk_1', 'card_1');
    const kit = createCredentials({
      cfg: testConfig(),
      oracle: { name: '' },
      verifier: null,
      memo: new VerifierEntryMemo(),
      fetchImpl,
      sleep: async () => undefined,
      now: () => NOW,
    });
    const answer = await kit.identityCheckEvent(
      {
        kind: 'identity_check_updated',
        linkId: 'lnk_1',
        status: 'failed',
        requestId: 'identity:lnk_1:failed',
      },
      channelCtx(adapter, { kv }),
    );
    if (answer.kind !== 'reply') throw new Error(`not a reply: ${answer.kind}`);
    return answer;
  };

  describe('a new link refused with 429 daily_limit', () => {
    const create = async (
      body: Record<string, unknown>,
      headers: Record<string, string> = {},
    ) => {
      const { adapter } = recordingUcan();
      const { tools: t, calls } = tools({
        [`GET ${LIST_URL}`]: () => json({ permissions: [allowedCard] }),
        [`POST ${LINKS}`]: () =>
          json(
            {
              error: {
                code: 'daily_limit',
                message:
                  'You can start up to 3 verifications a day. Please try again tomorrow.',
                retryable: false,
              },
              ...body,
            },
            429,
            headers,
          ),
      });
      const answer = (await run(
        t.credentials_request_action,
        { action: 'self.identity-check' },
        channelCtx(adapter),
      )) as Record<string, unknown> & { message: string; hint: string };
      return { answer, posts: calls.filter((c) => c.method === 'POST') };
    };

    it("today's Self (resetsAt + Retry-After): when they can try again, from resetsAt", async () => {
      const wait = 23 * 3600 + 20 * 60;
      const { answer, posts } = await create(
        { resetsAt: iso(wait) },
        { 'retry-after': String(wait) },
      );
      expect(answer).toMatchObject({
        error: 'daily_limit',
        message:
          "You've used all your tries for now. You can try again in about 23 hours. Just message me then and I'll send you a new link.",
        limit: {
          code: 'daily_limit',
          resetsAt: iso(wait),
          retryAfterSeconds: wait,
          tryAgain: 'in about 23 hours',
          startsLeft: 0,
        },
      });
      expect(answer.message).not.toContain('in a minute');
      expect(answer.message).not.toContain('Too many requests');
      expect(answer.hint).toContain(
        'Do not create, offer or promise a new link',
      );
      // A Retry-After of hours is not waited out: one call only.
      expect(posts).toHaveLength(1);
    });

    it("Self's new fields: the number of tries and the wait", async () => {
      const { answer } = await create(atLimit, {
        'retry-after': String(FIVE_HOURS),
      });
      expect(answer).toMatchObject({
        error: 'daily_limit',
        message:
          "You've used your 3 tries for now. You can try again in about 5 hours. Just message me then and I'll send you a new link.",
        limit: { startsMax: 3, windowHours: 6, tryAgain: 'in about 5 hours' },
      });
    });

    it('no time from Self: "later today", never "in a minute"', async () => {
      const { answer } = await create({});
      expect(answer.message).toBe(
        "You've used all your tries for now. You can try again later today. Just message me then and I'll send you a new link.",
      );
    });
  });

  describe('a failed check: the tries left', () => {
    it.each([
      [2, 'You can try 2 more times.'],
      [1, 'You can try 1 more time.'],
    ])('startsLeft %i', async (startsLeft, sentence) => {
      const answer = await status({
        status: 'failed',
        failure: 'too_many_attempts',
        startsLeft,
        startsMax: 3,
      });
      expect(answer).toMatchObject({
        status: 'failed',
        failure: 'too_many_attempts',
        startsLeft,
        message: `Your identity check ran out of tries. Please ask me for a new link to try again. ${sentence}`,
      });
      expect(answer).not.toHaveProperty('limit');
      expect(answer.hint).toContain(`startsLeft ${startsLeft}`);
    });

    it('startsLeft 0: when they can try again instead of a new link', async () => {
      const answer = await status({
        status: 'failed',
        failure: 'too_many_attempts',
        ...atLimit,
      });
      expect(answer).toMatchObject({
        status: 'failed',
        startsLeft: 0,
        limit: { tryAgain: 'in about 5 hours', resetsAt: iso(FIVE_HOURS) },
        message:
          "Your identity check ran out of tries. You've used your 3 tries for now. You can try again in about 5 hours. Just message me then and I'll send you a new link.",
      });
      expect(answer.message).not.toContain('ask me for a new link');
      expect(answer.hint).toContain('do not say they were refused');
      expect(answer.hint).toContain(
        'Do not create, offer or promise a new link',
      );
    });

    it('a plain "not verified" with 0 left: the same wait', async () => {
      const answer = await status({ status: 'failed', ...atLimit });
      expect(answer.message).toBe(
        "Sorry, your identity check didn't pass. You've used your 3 tries for now. You can try again in about 5 hours. Just message me then and I'll send you a new link.",
      );
    });

    it('0 left but the reset has passed: the usual words', async () => {
      const answer = await status({
        status: 'failed',
        failure: 'too_many_attempts',
        startsLeft: 0,
        resetsAt: iso(-60),
      });
      expect(answer.message).toBe(
        'Your identity check ran out of tries. Please ask me for a new link to try again.',
      );
      expect(answer).not.toHaveProperty('limit');
    });

    it('Self says nothing about starts: exactly the words as before', async () => {
      const answer = await status({
        status: 'failed',
        failure: 'too_many_attempts',
      });
      expect(answer.message).toBe(
        'Your identity check ran out of tries. Please ask me for a new link to try again.',
      );
      expect(answer).not.toHaveProperty('startsLeft');
    });
  });

  describe('the photo limit', () => {
    const PHOTOS =
      'Your identity check stopped because all the photo tries on that link were used. Please ask me for a new link to try again.';
    it.each([
      [{ failure: 'too_many_attempts', failureReason: 'too_many_photos' }],
      [{ failure: 'too_many_photos' }],
    ])('%o: its own words and a new link', async (fields) => {
      const answer = await status({ status: 'failed', ...fields });
      expect(answer).toMatchObject({
        status: 'failed',
        failure: 'too_many_photos',
        message: PHOTOS,
      });
      expect(answer.hint).toContain('Offer them a new link');
      expect(answer.hint).toContain('do not say they were refused');
    });

    it('an unknown failureReason keeps "too_many_attempts"', async () => {
      const answer = await status({
        status: 'failed',
        failure: 'too_many_attempts',
        failureReason: 'too_many_videos',
      });
      expect(answer).toMatchObject({ failure: 'too_many_attempts' });
    });

    it('with 1 start left, and with none', async () => {
      expect(
        (
          await status({
            status: 'failed',
            failure: 'too_many_attempts',
            failureReason: 'too_many_photos',
            startsLeft: 1,
          })
        ).message,
      ).toBe(`${PHOTOS} You can try 1 more time.`);
      expect(
        (
          await status({
            status: 'failed',
            failure: 'too_many_photos',
            ...atLimit,
          })
        ).message,
      ).toBe(
        "Your identity check stopped because all the photo tries on that link were used. You've used your 3 tries for now. You can try again in about 5 hours. Just message me then and I'll send you a new link.",
      );
    });
  });

  describe('the failed event', () => {
    it('carries the structured facts for a plugin that words it itself', async () => {
      const answer = await eventReply({
        status: 'failed',
        failure: 'too_many_attempts',
        startsLeft: 2,
        startsMax: 3,
        windowHours: 6,
      });
      expect(answer.text).toBe(
        'Your identity check ran out of tries. Please ask me for a new link to try again. You can try 2 more times.',
      );
      expect(answer.facts).toEqual({
        outcome: 'failed',
        failure: 'too_many_attempts',
        startsLeft: 2,
        startsMax: 3,
        windowHours: 6,
      });
      expect(answer.note).toContain(`they were told: "${answer.text}"`);
    });

    it('no start left: the wait, and atLimit with the reset', async () => {
      const answer = await eventReply({
        status: 'failed',
        failure: 'too_many_attempts',
        ...atLimit,
      });
      expect(answer.text).toBe(
        "Your identity check ran out of tries. You've used your 3 tries for now. You can try again in about 5 hours. Just message me then and I'll send you a new link.",
      );
      expect(answer.facts).toEqual({
        outcome: 'failed',
        failure: 'too_many_attempts',
        startsLeft: 0,
        startsMax: 3,
        windowHours: 6,
        atLimit: true,
        resetsAt: iso(FIVE_HOURS),
        retryAfterSeconds: FIVE_HOURS,
        tryAgain: 'in about 5 hours',
      });
      expect(answer.note).toContain(
        'Do not create, offer or promise a new link',
      );
    });

    it('the photo limit, and Self saying nothing about starts', async () => {
      const photos = await eventReply({
        status: 'failed',
        failure: 'too_many_attempts',
        failureReason: 'too_many_photos',
      });
      expect(photos.facts).toEqual({
        outcome: 'failed',
        failure: 'too_many_photos',
      });
      expect(photos.note).toContain('they used up the photo tries');
      const plain = await eventReply({ status: 'failed' });
      expect(plain.text).toBe("Sorry, your identity check didn't pass.");
      expect(plain.facts).toEqual({
        outcome: 'failed',
        failure: 'not_verified',
      });
    });
  });

  it('an unstarted link while no start is left: the wait, never the same link again or a new one', async () => {
    const { adapter } = recordingUcan();
    const kv = createMemoryUserKv();
    await recordLink(kv, 'lnk_1', 'card_1', {
      url: 'https://dev.self.ixo.earth/l/tok',
      expiresAt: NOW / 1000 + 600,
    });
    const { tools: t, calls } = tools({
      [`GET ${LIST_URL}`]: () => json({ permissions: [allowedCard] }),
      [`GET ${LINKS}/lnk_1`]: () =>
        json({
          linkId: 'lnk_1',
          status: 'sent',
          updatedAt: iso(-60),
          expiresAt: iso(600),
          limit: { code: 'daily_limit', resetsAt: iso(40 * 60) },
        }),
    });
    const ctx = channelCtx(adapter, { kv });
    const answer = (await run(
      t.credentials_request_action,
      { action: 'self.identity-check' },
      ctx,
    )) as Record<string, unknown>;
    expect(answer).toMatchObject({
      error: 'daily_limit',
      message:
        "You've used all your tries for now. You can try again in about 40 minutes. Just message me then and I'll send you a new link.",
    });
    expect(JSON.stringify(answer)).not.toContain('/l/tok');
    expect(calls.filter((c) => c.method === 'POST')).toHaveLength(0);
    // The status tool says the same.
    await expect(
      run(
        t.credentials_action_status,
        { action: 'self.identity-check', ref: 'lnk_1' },
        { ...ctx, toolCallId: 'call-2' },
      ),
    ).resolves.toMatchObject({
      status: 'sent',
      startsLeft: 0,
      limit: { tryAgain: 'in about 40 minutes' },
    });
  });

  it('a new link: startsLeft for the agent, and a hint when it is the last try', async () => {
    const { adapter } = recordingUcan();
    const { tools: t } = tools({
      [`GET ${LIST_URL}`]: () => json({ permissions: [allowedCard] }),
      [`POST ${LINKS}`]: () =>
        json(
          {
            linkId: 'lnk_1',
            url: 'https://dev.self.ixo.earth/l/tok',
            expiresAt: (NOW + 15 * 60_000) / 1000,
            startsLeft: 1,
            startsMax: 3,
          },
          201,
        ),
    });
    const answer = (await run(
      t.credentials_request_action,
      { action: 'self.identity-check' },
      channelCtx(adapter),
    )) as Record<string, unknown> & { hint: string };
    expect(answer).toMatchObject({ status: 'sent', startsLeft: 1 });
    expect(answer.hint).toContain('last identity-check try for now');
  });
});

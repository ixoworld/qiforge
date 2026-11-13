import { z } from 'zod';
import type {
  ChannelEventResult,
  IdentityCheckUpdatedEvent,
  PermissionAnsweredEvent,
  PermissionEventStatus,
} from '../../plugin-api/channel-events';
import { tool } from '../../plugin-api/tool-helper';
import { linkButtonPart, renderOf, withRichParts } from '../../delivery/rich';
import type {
  PluginTool,
  RuntimeContext,
  UserKvSurface,
} from '../../plugin-api/types';
import {
  checkIdleTtlMs,
  CREDENTIALS_KV_NAMESPACE,
  checkKey,
  deleteCheck,
  openKey,
  pruneEndedChecks,
  readCheck,
  readResult,
  saveCheck,
  type CheckRow,
} from './check-store';
import {
  DID_PATTERN,
  IDENTITY_LEVEL1_VCT,
  MAX_ISSUERS_PER_TYPE,
  purposeFor,
  type CredentialsConfig,
} from './config';
import {
  CredentialsWorkerClient,
  VERIFY_CAPABILITY,
  type VerifierEntryMemo,
} from './credentials-client';
import {
  CredentialsServiceError,
  MESSAGES,
  refusal,
  refusalFor,
  checkInProgress,
  describeError,
  hubReasonOf,
  isInReview,
  isSaving,
  NO_LATER_MESSAGE,
  type CredentialsRefusal,
  type Wording,
} from './errors';
import type { FetchLike } from './http';
import {
  canonicalJson,
  HubPermissionsClient,
  isOutdatedItem,
  MAX_PERMISSION_ITEMS,
  PERMISSIONS_CAPABILITY,
  sha256Hex,
  type ListedPermission,
  type PermissionGrant,
  type PermissionItemState,
  type PermissionRequest,
  type PermissionState,
  type ItemStatus,
  type PermissionStatus,
} from './hub-client';
import {
  chargeLinkStatus,
  chargePermissionList,
  chargePermissionStatus,
  clearGrantsCache,
  clearGrantsCacheOf,
  clearPendingAction,
  identityOutcomeOf,
  knowsPermission,
  lastLinkState,
  latestLinkRecord,
  noteLinkSeen,
  noteLinkTold,
  notePermissionAnswerTold,
  permissionUrl,
  readGrantsCache,
  readLinkCache,
  readPendingAction,
  readPermissionCache,
  readLinkRecord,
  readPermissionRecord,
  recordLink,
  recordPermission,
  toldInReview,
  writeGrantsCache,
  writeLinkCache,
  writePendingAction,
  writePermissionCache,
  type IdentityOutcome,
  type LinkRecord,
  type PermissionAnswer,
  type PermissionRecord,
} from './person-state';
import { RESPONSE_ROUTE_PREFIX, sealResponseToken } from './response-route';
import {
  LINK_CAPABILITY,
  LINK_STATUSES,
  SelfLinksClient,
  type LinkFailure,
  type LinkState,
  type LinkStatus,
} from './self-client';
import { SelfTime, whenItEnds } from './times';
import {
  buildCredentialRequest,
  isVerificationUnavailable,
  newResponseKeys,
  randomToken,
  VerifierSetupError,
  type CheckOutcome,
  type CredentialQuery,
  type OracleJwsSigner,
  type VerifierContext,
} from './verifier';

// ---------------------------------------------------------------------------
// The WhatsApp gate.

/** The channel provider id of IXO Channels' WhatsApp. */
export const WHATSAPP_PROVIDER = 'whatsapp';

/**
 * The person's WhatsApp binding when this turn came from our WhatsApp
 * channel (`ctx.session.client === 'channel'` and
 * `ctx.session.channel.provider === 'whatsapp'`, both set by the runtime
 * from the authenticated channel turn, never by the model); null on every
 * other surface. Every tool of this plugin refuses without it.
 */
export function whatsAppBinding(
  ctx: Pick<RuntimeContext, 'session'>,
): { bindingId: string; bindingRevision: number } | null {
  const channel = ctx.session.channel;
  if (
    ctx.session.client !== 'channel' ||
    channel?.provider !== WHATSAPP_PROVIDER
  )
    return null;
  return {
    bindingId: channel.bindingId,
    bindingRevision: channel.bindingRevision,
  };
}

// ---------------------------------------------------------------------------
// Inputs.

const Did = z.string().max(256).regex(DID_PATTERN, 'a did:ixo or did:web');
const ClaimName = z
  .string()
  .min(1)
  .max(100)
  .regex(/^[A-Za-z0-9_.-]+$/, 'a field name such as age_over_18');
const Vct = z.string().url().max(512);
/**
 * Optional: the configured issuers of the type are the default, and a
 * list given must be among them (`acceptedIssuers`).
 */
const Issuers = z.array(Did).min(1).max(MAX_ISSUERS_PER_TYPE).optional();
const Claims = z.array(ClaimName).max(30);

/**
 * The catalogue entry that has its own flow here (a link from Self). Any
 * other entry id is accepted as the Hub's pattern allows; the Hub answers
 * 400 for ids it does not know.
 */
export const IDENTITY_CHECK_ACTION = 'self.identity-check';
/** The Hub's pattern for a catalogue entry id. */
export const ACTION_ID_PATTERN = /^[a-z][a-z0-9]*(\.[a-z][a-z0-9-]*)+$/;
const ActionId = z
  .string()
  .max(128)
  .regex(ACTION_ID_PATTERN, 'a catalogue entry id such as self.identity-check');
export type SupportedAction = string;

export const CheckPermissionInput = z
  .object({
    vct: Vct.describe('The credential type (its vct URL).'),
    issuers: Issuers.describe(
      'Optional: fewer issuers than this service accepts for the type. Leave it out to use them all.',
    ),
    claims: Claims.min(1).describe(
      'The fields you need to see (1-30), as few as possible.',
    ),
    days: z
      .number()
      .int()
      .min(1)
      .max(90)
      .default(30)
      .describe('How long the permission lasts, in days (1-90).'),
  })
  .strict();

const CheckItem = CheckPermissionInput.extend({
  kind: z.literal('credential-check'),
});
const ActionItem = z
  .object({
    kind: z.literal('service-action'),
    action: ActionId.describe(
      'An entry id from the Hub\'s approved list, for example "self.identity-check".',
    ),
    days: z
      .number()
      .int()
      .min(1)
      .max(90)
      .optional()
      .describe(
        "How long the permission lasts, in days; omit for the entry's usual length (the Hub refuses more than the entry allows).",
      ),
  })
  .strict();

export const RequestPermissionsInput = z
  .object({
    items: z
      .array(z.discriminatedUnion('kind', [CheckItem, ActionItem]))
      .min(1)
      .max(MAX_PERMISSION_ITEMS)
      .describe(
        'Everything you need from the person, 1-5 items, shown on ONE card.',
      ),
  })
  .strict();

export const PermissionStatusInput = z
  .object({
    permissionId: z.string().regex(/^[A-Za-z0-9_-]{1,128}$/),
  })
  .strict();

/**
 * No `purpose`: why the oracle asks is the operator's fixed wording per
 * credential type (`purposeFor`), never text the model writes.
 */
export const CheckInput = z
  .object({
    vct: Vct,
    issuers: Issuers.describe(
      'Optional: fewer issuers than this service accepts for the type. Leave it out to use them all.',
    ),
    claims: Claims.default([]).describe(
      'The fields you need to see, as few as possible (empty = only that they hold one).',
    ),
  })
  .strict();

export const ActionPermissionInput = z
  .object({
    action: ActionId,
    days: z
      .number()
      .int()
      .min(1)
      .max(90)
      .optional()
      .describe(
        "How long the permission lasts, in days; omit for the action's usual length.",
      ),
  })
  .strict();

/** How the identity link's message opens: on its own, or as the next step of a task. */
export const LINK_CONTEXTS = ['next_step', 'standalone'] as const;

export const ActionInput = z
  .object({
    action: ActionId,
    context: z
      .enum(LINK_CONTEXTS)
      .default('standalone')
      .describe(
        'For "self.identity-check" only: "next_step" when the identity check is the next step of a task already under way (after a reward claim, or right after they allowed the card), else "standalone" (the default). It only changes the first words of the link message.',
      ),
  })
  .strict();

export const ActionStatusInput = z
  .object({
    action: ActionId,
    ref: z
      .string()
      .regex(/^[A-Za-z0-9_-]{1,128}$/)
      .optional()
      .describe(
        'The linkId credentials_request_action returned. Leave it out for the newest link made for this person.',
      ),
  })
  .strict();

// ---------------------------------------------------------------------------
// Shared plumbing.

export interface CredentialsToolsDeps {
  cfg: CredentialsConfig;
  /** The oracle's name and description (its config): who asks, in the catalog. */
  oracle: { name: string; description?: string };
  /** Built once per isolate by the plugin; null without Blocksync. */
  verifier: VerifierContext | null;
  memo: VerifierEntryMemo;
  fetchImpl?: FetchLike;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  /**
   * The whole deadline of `credentials_check`, in ms (default 25 s): setup,
   * the calls and the wait for the answer all fit in it.
   */
  checkWaitMs?: number;
}

/**
 * How long a card waits for Allow or Don't allow: one hour. Not how long a
 * permission lasts once allowed (that is each item's `days`).
 */
export const PERMISSION_CARD_TTL_SECONDS = 3600;
/** A presentation request of `credentials_check` lives 15 minutes. */
export const CHECK_REQUEST_TTL_SECONDS = 15 * 60;
/** One deadline per tool: every call it makes ends inside it. */
export const TOOL_DEADLINE_MS = 25_000;
export const CHECK_WAIT_MS = TOOL_DEADLINE_MS;
/** How often the worker is asked for the request's status while waiting. */
const WORKER_POLL_MS = 4_000;
/** As long as the longest grant a card can carry, plus its day. */
const ACTION_RECORD_TTL_MS = 32 * 24 * 3600 * 1000;

const defaultSleep = (ms: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, ms));

type Ready = {
  cfg: CredentialsConfig & { serviceKey: string; oracleDid: string };
  binding: { bindingId: string; bindingRevision: number };
};

/** Everything every tool needs, or the refusal to answer instead. */
function readiness(
  ctx: RuntimeContext,
  cfg: CredentialsConfig,
): Ready | CredentialsRefusal {
  const binding = whatsAppBinding(ctx);
  if (!binding) return refusal('whatsapp_only', MESSAGES.whatsAppOnly);
  const { serviceKey, oracleDid } = cfg;
  if (!cfg.enabled || !serviceKey || !oracleDid || !ctx.ucan.hasSigningKey()) {
    const missing = !cfg.enabled
      ? 'disabled'
      : !serviceKey
        ? 'no_service_key'
        : !oracleDid
          ? 'no_oracle_did'
          : 'no_signing_key';
    ctx.logger.warn(`[credentials] not_available (${missing})`);
    return refusal('not_available', MESSAGES.notAvailable);
  }
  return { cfg: { ...cfg, serviceKey, oracleDid }, binding };
}

function isRefusal(
  value: Ready | CredentialsRefusal,
): value is CredentialsRefusal {
  return 'error' in value;
}

function minted(
  result: { invocation: string } | { error: string },
  service: string,
  logger: RuntimeContext['logger'],
): string {
  if ('error' in result) {
    // The reason can name DIDs: logged, never shown.
    logger.warn(`[credentials] could not sign a call to ${service}`);
    throw new Error('UCAN mint failed');
  }
  return result.invocation;
}

/** What every call to a service takes from the deps. */
type TransportDeps = Pick<CredentialsToolsDeps, 'fetchImpl' | 'sleep' | 'now'>;

function transport(deps: TransportDeps, deadline: number) {
  return {
    deadline,
    ...(deps.now ? { now: deps.now } : {}),
    ...(deps.fetchImpl ? { fetchImpl: deps.fetchImpl } : {}),
    ...(deps.sleep ? { sleep: deps.sleep } : {}),
  };
}

function hubClient(
  ctx: RuntimeContext,
  ready: Ready,
  deps: TransportDeps,
  deadline: number,
) {
  return new HubPermissionsClient({
    hubUrl: ready.cfg.hub.url,
    serviceKey: ready.cfg.serviceKey,
    mint: async (facts) =>
      minted(
        await ctx.ucan.mintSelfSignedInvocation(
          ready.cfg.hub.did,
          PERMISSIONS_CAPABILITY,
          { maxTtlSeconds: 120, facts },
        ),
        'the Hub',
        ctx.logger,
      ),
    ...transport(deps, deadline),
  });
}

function workerClient(
  ctx: RuntimeContext,
  ready: Ready,
  deps: CredentialsToolsDeps,
  deadline: number,
) {
  return new CredentialsWorkerClient({
    baseUrl: ready.cfg.credentials.url,
    mint: async (facts) =>
      minted(
        await ctx.ucan.mintSelfSignedInvocation(
          ready.cfg.credentials.did,
          VERIFY_CAPABILITY,
          { maxTtlSeconds: 120, facts },
        ),
        'the Credentials worker',
        ctx.logger,
      ),
    ...transport(deps, deadline),
  });
}

function selfClient(
  ctx: RuntimeContext,
  ready: Ready,
  deps: CredentialsToolsDeps,
  linkGrant: PermissionGrant,
  deadline: number,
) {
  return new SelfLinksClient({
    selfUrl: ready.cfg.self.url,
    webOrigin: ready.cfg.selfWebOrigin,
    ...(ready.cfg.oracleEntityDid
      ? { entityDid: ready.cfg.oracleEntityDid }
      : {}),
    mint: async (facts) =>
      minted(
        await ctx.ucan.createInvocationFromDelegation(
          linkGrant.token,
          ready.cfg.self.did,
          LINK_CAPABILITY,
          { maxTtlSeconds: 240, facts },
        ),
        'Self',
        ctx.logger,
      ),
    ...transport(deps, deadline),
  });
}

/** A stable key for one tool call (the same on a resumed run), else random. */
async function requestKeyOf(
  ctx: RuntimeContext,
  salt: string,
): Promise<string> {
  if (ctx.session.runId && ctx.toolCallId)
    return sha256Hex(`${ctx.session.runId}:${ctx.toolCallId}:${salt}`);
  return randomToken(24);
}

function sortedUnique(values: readonly string[]): string[] {
  return [...new Set(values)].sort();
}

/**
 * The issuers a check or a card may name for `vct`: the operator's list
 * (`CREDENTIALS_TRUSTED_ISSUERS`), or the part of it the model asked for.
 * A type without a list, or an issuer outside it, is refused before anything
 * is sent: the model can narrow the trust anchor, never widen it.
 */
export function acceptedIssuers(
  cfg: Pick<CredentialsConfig, 'trustedIssuers'>,
  vct: string,
  asked: readonly string[] | undefined,
): { issuers: string[]; configured: string[] } | CredentialsRefusal {
  const listed = Object.hasOwn(cfg.trustedIssuers, vct)
    ? cfg.trustedIssuers[vct]
    : undefined;
  if (!listed?.length)
    return refusal('untrusted_credential', MESSAGES.untrustedCredential);
  const configured = sortedUnique(listed);
  if (asked === undefined) return { issuers: configured, configured };
  const issuers = sortedUnique(asked);
  if (issuers.some((did) => !configured.includes(did)))
    return refusal('untrusted_issuer', MESSAGES.untrustedIssuer);
  return { issuers, configured };
}

/** The refusal for a failure, logged without any personal detail. */
function failed(
  ctx: RuntimeContext,
  tool: string,
  error: unknown,
  nowMs: number,
): CredentialsRefusal {
  const result = refusalFor(error, {
    ...(ctx.user.timezone ? { timeZone: ctx.user.timezone } : {}),
    nowMs,
  });
  const reason =
    error instanceof CredentialsServiceError ? hubReasonOf(error) : undefined;
  ctx.logger.warn(
    `[credentials] ${tool}: ${result.error} (${
      error instanceof CredentialsServiceError
        ? `${error.service} ${error.status} ${error.code}${reason ? ` reason=${reason}` : ''}`
        : describeError(error)
    })`,
  );
  return result;
}

function kvOf(ctx: RuntimeContext): UserKvSurface | null {
  return ctx.kv ?? null;
}

/**
 * Where an answer keeps its link button (`Wording.button`): not enumerable,
 * so an answer sent as it is (JSON) never shows it.
 */
const LINK_BUTTON = Symbol('credentials.linkButton');

/** A tool answer: the person's sentence (`message`) and the agent's (`hint`). */
function said(wording: Wording, extra: Record<string, unknown> = {}) {
  const answer = {
    ...extra,
    message: wording.message,
    ...(wording.hint ? { hint: wording.hint } : {}),
  };
  if (wording.button)
    Object.defineProperty(answer, LINK_BUTTON, { value: wording.button });
  return answer;
}

/** What the agent is told when the link went out as a button. */
const BUTTON_HINT =
  'The message with the link has been sent for you as a message with a button; it is the whole reply. Write nothing before or after it, and do not repeat it, the link or the button.';

/**
 * An answer whose link the chat can show as a button (the turn's `render`
 * allows the link's site and the label): the sentence and the button go
 * out as their own message after the reply, and the agent gets the answer
 * without `message` and the link. Anything else is returned as it is, so
 * the agent sends `message` with the link written out, as before.
 */
function delivered(
  ctx: RuntimeContext,
  name: string,
  answer: unknown,
): unknown {
  if (!answer || typeof answer !== 'object') return answer;
  const button: unknown = Reflect.get(answer, LINK_BUTTON);
  const message: unknown = Reflect.get(answer, 'message');
  if (!button || typeof message !== 'string') return answer;
  const parsed = z
    .object({
      body: z.string(),
      url: z.string(),
      label: z.enum(['allow', 'start_check']),
    })
    .safeParse(button);
  if (!parsed.success) return answer;
  const built = linkButtonPart(
    { ...parsed.data, fallback: message },
    renderOf(ctx),
  );
  if (!built.part) return answer;
  const content: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(answer))
    if (key !== 'message' && key !== 'url' && key !== 'hint')
      content[key] = value;
  const hint: unknown = Reflect.get(answer, 'hint');
  const rest =
    typeof hint === 'string'
      ? hint
          .replace(
            /Send `message` as it is(, as one link in a short message)?\.\s*/,
            '',
          )
          .trim()
      : '';
  content.hint = rest ? `${BUTTON_HINT} ${rest}` : BUTTON_HINT;
  return withRichParts(ctx, { name, content, parts: [built.part] });
}

// ---------------------------------------------------------------------------
// Permission cards.

const STATUS_WORDING: Record<PermissionStatus, Wording> = {
  pending: {
    message: "You haven't answered yet.",
    hint: `They haven't answered the card; wait for them, do not ask again or poll. ${NO_LATER_MESSAGE}`,
  },
  allowed: {
    message: "Thanks, that's allowed.",
    hint: "Go on with the task. If you call another tool in this same reply (for example credentials_request_action for the identity link), send this sentence first and that tool's message right after it, together in ONE message.",
  },
  declined: MESSAGES.declined,
  expired: {
    message: 'The request ended before you answered.',
    hint: 'Ask again only if they still want this.',
  },
  stopped: {
    message: 'You stopped this permission.',
    hint: 'Respect it; ask again only if they bring it up.',
  },
  stopping: {
    message: 'This permission is being stopped.',
    hint: 'Treat it as stopped: it is no longer in use. Respect it; ask again only if they bring it up.',
  },
  unknown: MESSAGES.stateUnknown,
};

/** The refusal for a card or item that is not usable: declined, in an unknown state, or ended. */
function endedRefusal(
  cardStatus: PermissionStatus,
  itemStatus?: ItemStatus,
): CredentialsRefusal {
  if (cardStatus === 'unknown' || itemStatus === 'unknown')
    return refusal('permission_ended', MESSAGES.stateUnknown);
  return refusal(
    'permission_ended',
    cardStatus === 'declined' || itemStatus === 'declined'
      ? MESSAGES.declined
      : MESSAGES.permissionEnded,
  );
}

/** What a card asks, as a key: its action ids, then `check:<vct>` per credential type, sorted. */
function cardKey(actions: readonly string[], vcts: readonly string[] = []) {
  return sortedUnique([...actions, ...vcts.map((vct) => `check:${vct}`)]).join(
    '|',
  );
}

/**
 * The first sentence of a card, chosen by exactly what it asks (catalogue
 * action ids and credential types). A card asking anything else gets the
 * safe fallback, which says nothing about what is asked.
 */
const CARD_LEADS: ReadonlyMap<string, string> = new Map([
  [
    cardKey([IDENTITY_CHECK_ACTION]),
    'This lets me send you a link for your identity check.',
  ],
  [
    cardKey([IDENTITY_CHECK_ACTION], [IDENTITY_LEVEL1_VCT]),
    'This lets me send you a link for your identity check.',
  ],
  [
    cardKey([], [IDENTITY_LEVEL1_VCT]),
    'This lets me check that your identity is verified.',
  ],
]);

/** The action ids and credential types of a card's items. */
function askedOf(asked: readonly PermissionRequest[]) {
  return {
    actions: asked.flatMap((p) =>
      p.kind === 'service-action' ? [p.action] : [],
    ),
    vcts: asked.flatMap((p) => (p.kind === 'credential-check' ? [p.vct] : [])),
  };
}

/** What a card the Hub lists asks (only what it names; nothing when it names nothing). */
function askedOfItems(items: readonly PermissionItemState[]) {
  const actions = items.flatMap((i) => (i.action ? [i.action] : []));
  const vcts = items.flatMap((i) => (i.vct ? [i.vct] : []));
  return {
    ...(actions.length ? { actions } : {}),
    ...(vcts.length ? { vcts } : {}),
  };
}

function cardMessage(
  name: string,
  url: string,
  asked: readonly PermissionRequest[],
): Wording {
  const { actions, vcts } = askedOf(asked);
  const lead = CARD_LEADS.get(cardKey(actions, vcts));
  return {
    message: lead
      ? `${lead} Please tap this to allow: ${url}`
      : `Please tap this to see what ${name} is asking for, and allow it if you agree: ${url}`,
    hint: 'Send `message` as it is, as one link in a short message. Never paste ids or tokens.',
    button: {
      body:
        lead ??
        `Please tap this to see what ${name} is asking for, and allow it if you agree.`,
      url,
      label: 'allow',
    },
  };
}

/**
 * The card's sentence when the person allowed this before, but what they
 * allowed no longer matches the service's catalogue entry (`current: false`).
 */
function againMessage(url: string): Wording {
  return {
    message: `Something changed, so I need your OK again. Please tap this to allow: ${url}`,
    hint: 'What they allowed earlier no longer matches what this service needs now, so it is asked again on one card. Send `message` as it is, as one link in a short message. Never paste ids or tokens.',
    button: {
      body: 'Something changed, so I need your OK again.',
      url,
      label: 'allow',
    },
  };
}

/** The refusal for an allowed item the Hub marks `current: false`. */
const outdatedRefusal = () =>
  refusal('permission_outdated', MESSAGES.permissionOutdated);

/** Whether a tool's answer is the {@link outdatedRefusal}. */
function isOutdatedAnswer(answer: object): answer is CredentialsRefusal {
  return 'error' in answer && answer.error === 'permission_outdated';
}

/** A local refusal of one item of a several-item request, in the Hub's wording for a bad item. */
function itemRefusal(
  position: number,
  inner: CredentialsRefusal,
): CredentialsRefusal {
  return {
    error: inner.error,
    message: `Item ${position + 1} of this request isn't something we can set up.`,
    hint: [
      inner.hint ?? inner.message,
      'Fix or drop that item; nothing was sent.',
    ].join(' '),
  };
}

/** What the agent may see of one item: ids and capabilities, never tokens. */
function itemSummary(item: PermissionItemState, cardStatus: PermissionStatus) {
  const status = item.status ?? cardStatus;
  return {
    index: item.index,
    kind: item.kind,
    ...(item.action ? { action: item.action } : {}),
    state: status,
    ...(item.current !== undefined ? { current: item.current } : {}),
    // An out-of-date item is not in use: what it granted is not listed.
    ...(status === 'allowed' &&
    !isOutdatedItem(item) &&
    (item.consentIds?.length || item.grants?.length)
      ? {
          granted: {
            ...(item.consentIds?.length ? { consentIds: item.consentIds } : {}),
            ...(item.grants?.length
              ? {
                  grants: item.grants.map((g) => ({
                    ...(g.id ? { id: g.id } : {}),
                    can: g.can,
                    with: g.with,
                    audience: g.audience,
                    expiresAt: g.expiresAt,
                  })),
                }
              : {}),
          },
        }
      : {}),
  };
}

/** The service-action item of `action` in a card's state. */
function actionItem(
  state: PermissionState,
  action: string,
): PermissionItemState | undefined {
  return state.items.find(
    (i) => i.kind === 'service-action' && i.action === action,
  );
}

/** The kv key that remembers the card for one action. */
function actionKey(action: string): string {
  return `action:${action}`;
}

const ActionRecord = z.object({ permissionId: z.string() });

/**
 * A tool call's reader of the Hub's list of the person's live cards (read
 * at most once); null when the Hub could not say, `failure()` then names why.
 */
type HubCards = (() => Promise<ListedPermission[] | null>) & {
  failure: () => string | undefined;
};

// ---------------------------------------------------------------------------
// The Hub's list of the person's live cards: the truth the kv is a cache of.

/** A card about to end is not handed out again: a new one gets a full hour. */
const PENDING_CARD_MARGIN_SECONDS = 60;

/** The refusals that mean "the kv holds nothing usable": worth one look at the Hub. */
const NOTHING_USABLE: ReadonlySet<string> = new Set([
  'no_permission',
  'permission_ended',
  'permission_outdated',
]);

/** Whether a tool's answer is one of the {@link NOTHING_USABLE} refusals. */
function isEnded(answer: object): answer is CredentialsRefusal {
  return (
    'error' in answer &&
    typeof answer.error === 'string' &&
    NOTHING_USABLE.has(answer.error)
  );
}

const ALREADY_ALLOWED: Wording = {
  message: "You've already allowed this.",
  hint: 'No new card was sent: a permission they allowed earlier still covers everything asked. Go on with the task: a next step you were given comes first; otherwise credentials_check for a credential you need to check, or credentials_request_action for a service action.',
};

function itemStatusOf(card: PermissionState, item: PermissionItemState) {
  return item.status ?? card.status;
}

/** Whether a card is in `status` and, when waiting, not about to end. */
function cardIs(
  card: PermissionState,
  status: 'allowed' | 'pending',
  nowSeconds: number,
): boolean {
  if (card.status !== status) return false;
  return (
    status === 'allowed' ||
    card.expiresAt === undefined ||
    card.expiresAt > nowSeconds + PENDING_CARD_MARGIN_SECONDS
  );
}

/**
 * Whether one item of a card covers what is asked: the same action; or the
 * same credential type with every field asked among the card's and every
 * issuer asked among the card's. How long was asked plays no part: a
 * permission that is running is used until it ends.
 */
function itemCovers(item: PermissionItemState, asked: PermissionRequest) {
  if (item.kind !== asked.kind) return false;
  if (asked.kind === 'service-action') return item.action === asked.action;
  const { claims, issuers } = item;
  return (
    item.vct === asked.vct &&
    claims !== undefined &&
    issuers !== undefined &&
    asked.claims.every((c) => claims.includes(c)) &&
    asked.issuers.every((i) => issuers.includes(i))
  );
}

/** The grants of an item that have not ended. */
function runningGrants(item: PermissionItemState, nowSeconds: number) {
  return (item.grants ?? []).filter((g) => g.expiresAt > nowSeconds);
}

/**
 * Whether an item is in `status`. The item's own state decides, never the
 * card's alone: an allowed card can hold items that were stopped. An allowed
 * item also has to carry what Allow wrote (a grant still running, or a
 * consent) and must not be marked out of date (`current: false`: the
 * catalogue entry changed since); otherwise it is not in use.
 */
function itemIs(
  card: PermissionState,
  item: PermissionItemState,
  status: 'allowed' | 'pending',
  nowSeconds: number,
): boolean {
  if (itemStatusOf(card, item) !== status) return false;
  if (status === 'pending') return true;
  return (
    !isOutdatedItem(item) &&
    (runningGrants(item, nowSeconds).length > 0 ||
      (item.consentIds?.length ?? 0) > 0)
  );
}

/**
 * The newest allowed card with an allowed item covering `asked` that the
 * Hub marks out of date (`current: false`), when there is one.
 */
function outdatedCard(
  cards: readonly ListedPermission[],
  asked: PermissionRequest,
  nowSeconds: number,
): ListedPermission | undefined {
  return cards.find(
    (card) =>
      cardIs(card, 'allowed', nowSeconds) &&
      card.items.some(
        (item) =>
          itemStatusOf(card, item) === 'allowed' &&
          isOutdatedItem(item) &&
          itemCovers(item, asked),
      ),
  );
}

/** The newest card in `status` with an item in that state covering `asked`. */
function coveringCard(
  cards: readonly ListedPermission[],
  asked: PermissionRequest,
  status: 'allowed' | 'pending',
  nowSeconds: number,
): ListedPermission | undefined {
  return cards.find(
    (card) =>
      cardIs(card, status, nowSeconds) &&
      card.items.some(
        (item) =>
          itemIs(card, item, status, nowSeconds) && itemCovers(item, asked),
      ),
  );
}

/** A listed card as the status cache keeps it (without its link). */
function stateOf(card: ListedPermission): PermissionState {
  const { url: _url, ...state } = card;
  void _url;
  return state;
}

const OpenLink = z.object({
  linkId: z.string().regex(/^[A-Za-z0-9_-]{1,128}$/),
  status: z.enum(LINK_STATUSES),
  expiresAt: SelfTime,
  /** Self's "in review" (read leniently: anything but `true` is not). */
  review: z.literal(true).optional().catch(undefined),
  /** Self's "passed, proof being saved" (read leniently, as `review`). */
  saving: z.literal(true).optional().catch(undefined),
});

/** What the person does on an identity-check link, in the words every link message uses. */
const ID_CHECK_STEPS = 'You will scan your ID document and take a selfie.';

// ---------------------------------------------------------------------------
// credentials_check.

const CHECK_WORDING: Record<CheckOutcome['result'] | 'none', Wording> = {
  valid: {
    message: 'Thanks, your credential checks out.',
    hint: 'Use only the fields you asked for, for this task.',
  },
  invalid: {
    message: "Your credential didn't pass the check.",
    hint: 'It was not accepted; do not retry the same request.',
  },
  revoked: {
    message: 'Your credential has been revoked by its issuer.',
    hint: 'It cannot be used; do not retry.',
  },
  expired: {
    message: 'Your credential has expired.',
    hint: 'It cannot be used until it is renewed.',
  },
  none: {
    message: "You didn't share a credential for this.",
    hint: 'They declined or let it end; ask again only if they want to.',
  },
};

function liveCheck(row: CheckRow | null, nowSeconds: number): CheckRow | null {
  // A request about to end is not reused: a new one gets a full window.
  return row && row.expiresAt > nowSeconds + 60 ? row : null;
}

/** The Hub page where the person answers the request. */
function walletUrlOf(
  cfg: CredentialsConfig,
  requestId: string,
  given?: string,
) {
  if (given) {
    try {
      if (new URL(given).origin === cfg.hub.url) return given;
    } catch {
      // Not a URL: use the Hub's own path.
    }
  }
  return `${cfg.hub.url}/credentials/requests/${encodeURIComponent(requestId)}`;
}

// ---------------------------------------------------------------------------
// Permission events: the person answered a card in their wallet.

/** The Hub's card state an event's status stands for. */
const HUB_ANSWER: Record<PermissionEventStatus, PermissionAnswer> = {
  allowed: 'allowed',
  not_allowed: 'declined',
  expired: 'expired',
};

/** The fixed sentences a permission event answers with. */
export const PERMISSION_EVENT_TEXT = {
  allowed: 'Thanks, you allowed it.',
  not_allowed:
    'No problem, nothing was shared. Tell me if you change your mind.',
  expired: 'That link has run out. Shall I send a new one?',
} as const satisfies Record<PermissionEventStatus, string>;

/** What a card asked, for the model: its action ids and credential types. */
function askedLine(record: PermissionRecord): string {
  const asked = [
    ...(record.actions ?? []),
    ...(record.vcts ?? []).map((vct) => `a check of ${vct}`),
  ];
  return asked.length ? ` (it asked for: ${asked.join(', ')})` : '';
}

/**
 * Every event note that lets the model go on: tools already bound are used
 * as they are, `load_capability` only for one the step needs and lacks.
 */
const LOAD_ONLY_IF_MISSING =
  'Use the tools already in your tool list; call load_capability only for a tool the step needs that you do not have.';

/** When the next step is not another plugin's: credentials_check only for the oracle's own decision. */
const CHECK_ONLY_FOR_OWN_DECISION =
  'call credentials_check only if this oracle itself needs to read a claim from the credential for its own decision';

/**
 * The sentence after the fixed one in an event note: another plugin's next
 * step (from `rememberPermissionCard`) is the ONLY step, named plainly;
 * otherwise `fallback`.
 */
function nextStepSentence(
  pluginNext: string | undefined,
  owner: string,
  fallback: string,
): string {
  if (pluginNext)
    return `Then, in the same message, do exactly this next step (set by the plugin that ${owner}), and nothing before it: ${pluginNext}. That is the only next step: do not add credentials_check or any other call it does not name, even when a tool's hint suggests one. ${LOAD_ONLY_IF_MISSING}`;
  return `Then, in the same message, ${fallback}. ${LOAD_ONLY_IF_MISSING}`;
}

/** What the agent does once a card is allowed: another plugin's words, else by what it asked. */
function nextStep(record: PermissionRecord): string {
  if (record.actions?.includes(IDENTITY_CHECK_ACTION))
    return `go on with the task you were on: call credentials_request_action with action "self.identity-check" and context "next_step", and send its message right after that sentence (if it answers already_verified, they are verified: go on with the task; ${CHECK_ONLY_FOR_OWN_DECISION})`;
  if (record.vcts?.length)
    return 'go on with the task you were on: call credentials_check for the credential you needed';
  return 'go on with the task you were on';
}

const EVENT_NOTE_START =
  '[Permission answer from the wallet, checked with the Auth Hub; this is not a message from the user.';

/** The note and wording for a confirmed answer of `record`'s card. */
function eventAnswer(
  status: PermissionEventStatus,
  record: PermissionRecord,
): ChannelEventResult {
  const card = `the permission card you sent them${askedLine(record)}`;
  const text = PERMISSION_EVENT_TEXT[status];
  if (status === 'allowed')
    return {
      kind: 'agent',
      note: `${EVENT_NOTE_START} They allowed ${card}. Start your reply with exactly this sentence: "${text}" ${nextStepSentence(record.next, 'sent the card', nextStep(record))} Do not send the card again. ${NO_LATER_MESSAGE}]`,
    };
  return {
    kind: 'reply',
    text,
    note:
      status === 'not_allowed'
        ? `${EVENT_NOTE_START} They chose Don't allow on ${card}; they were told: "${text}" Respect it; ask again only if they bring it up.]`
        : `${EVENT_NOTE_START} They did not answer ${card} before it ran out; they were told: "${text}" If they want it, ask again with a request tool (it sends a new card).]`,
  };
}

/**
 * The plugin's answer to a permission event (`handleChannelEvent`). Only
 * a card this person's kv recorded is claimed (sent by a request tool, read
 * from the Hub's list, or recorded by another plugin with
 * `rememberPermissionCard`); any other id is `pass`. A claimed card is read
 * at the Hub first: unless the Hub's state is the event's (`allowed`,
 * `declined` for `not_allowed`, `expired`) nothing is said. Nothing is said
 * either when the person already learned that answer in the chat (a tool
 * read it) or an event already told it; the same event's run asked again
 * (a restart) answers as before. Only fixed sentences: `allowed` lets the
 * model go on with the task after "Thanks, you allowed it."; the others are
 * sent as they are.
 */
export function createPermissionEventHandler(
  deps: Pick<CredentialsToolsDeps, 'cfg'> & TransportDeps,
) {
  const now = deps.now ?? Date.now;
  return async (
    event: PermissionAnsweredEvent,
    ctx: RuntimeContext,
  ): Promise<ChannelEventResult> => {
    const kv = kvOf(ctx);
    if (!kv) return { kind: 'pass' };
    const record = await readPermissionRecord(kv, event.permissionId);
    if (!record) return { kind: 'pass' };
    const answer = HUB_ANSWER[event.status];
    const again = record.told?.requestId === event.requestId;
    if (!again && (record.told?.status === answer || record.seen === answer))
      return { kind: 'ignore' };
    const ready = readiness(ctx, deps.cfg);
    if (isRefusal(ready)) return { kind: 'ignore' };
    let state: PermissionState;
    try {
      state = await hubClient(
        ctx,
        ready,
        deps,
        now() + TOOL_DEADLINE_MS,
      ).status(event.permissionId);
    } catch (error) {
      ctx.logger.warn(
        `[credentials] permission event: hub_unread (${
          error instanceof CredentialsServiceError
            ? `hub_${error.status}_${error.code}`
            : describeError(error)
        })`,
      );
      return { kind: 'ignore' };
    }
    if (state.status !== answer) {
      ctx.logger.warn(
        `[credentials] permission event: not confirmed (event ${event.status}, hub ${state.status})`,
      );
      return { kind: 'ignore' };
    }
    // Told before the cache is written: the write marks the answer seen.
    await notePermissionAnswerTold(kv, state.id, answer, event.requestId);
    await writePermissionCache(kv, state, now());
    return eventAnswer(event.status, record);
  };
}

/** The fixed sentences an identity-check event answers with. */
export const IDENTITY_EVENT_TEXT = {
  in_review: MESSAGES.inReview.message,
  passed: 'Your identity check is done. You are verified.',
  failed: "Sorry, your identity check didn't pass.",
} as const satisfies Record<IdentityOutcome, string>;

/**
 * The fixed words for a `failed` check, by Self's `failure`: absent
 * (`not_verified`) is a real "not verified"; `error` was a problem on our
 * side; `too_many_attempts` means they used up their tries. The status
 * read and the event answer use the same words.
 */
export const IDENTITY_FAILED_WORDING = {
  not_verified: {
    message: IDENTITY_EVENT_TEXT.failed,
    hint: `Offer a new link only if they want to try again. ${NO_LATER_MESSAGE}`,
  },
  error: {
    message:
      'Sorry, something went wrong with your identity check. Please ask me for a new link to try again.',
    hint: `It was a problem on our side, not about them: do not say they failed or were not verified. Offer them a new link to try again. ${NO_LATER_MESSAGE}`,
  },
  too_many_attempts: {
    message:
      'Your identity check ran out of tries. Please ask me for a new link to try again.',
    hint: `They used up their tries on that link: do not say they were refused or not verified. Offer them a new link to try again. ${NO_LATER_MESSAGE}`,
  },
} as const satisfies Record<LinkFailure | 'not_verified', Wording>;

/** The words for a failed check, from Self's `failure` (only beside `failed`). */
function failedWording(state: { status: LinkStatus; failure?: LinkFailure }) {
  return IDENTITY_FAILED_WORDING[
    state.status === 'failed' && state.failure ? state.failure : 'not_verified'
  ];
}

const IDENTITY_NOTE_START =
  '[Identity check update, checked with Self; this is not a message from the user.';

const FAILED_NOTE: Record<keyof typeof IDENTITY_FAILED_WORDING, string> = {
  not_verified: 'Their identity check did not pass',
  error:
    'Their identity check ended because of a problem on our side, not a decision about them',
  too_many_attempts:
    'Their identity check ended because they used up their tries',
};

/** The note and wording for an identity check's outcome as Self reports it. */
function identityAnswer(
  outcome: IdentityOutcome,
  verifiedNext: string | undefined,
  failure: LinkFailure | undefined,
): ChannelEventResult {
  if (outcome === 'passed')
    return {
      kind: 'agent',
      note: `${IDENTITY_NOTE_START} Their identity check passed. Start your reply with exactly this sentence: "${IDENTITY_EVENT_TEXT.passed}" ${nextStepSentence(verifiedNext, 'asked for the check', `go on with the task you were on, the one that needed the identity check (${CHECK_ONLY_FOR_OWN_DECISION})`)} ${NO_LATER_MESSAGE}]`,
    };
  if (outcome === 'failed') {
    const why = failure ?? 'not_verified';
    const { message, hint } = IDENTITY_FAILED_WORDING[why];
    return {
      kind: 'reply',
      text: message,
      note: `${IDENTITY_NOTE_START} ${FAILED_NOTE[why]}; they were told: "${message}" ${hint}]`,
    };
  }
  const text = IDENTITY_EVENT_TEXT.in_review;
  return {
    kind: 'reply',
    text,
    note: `${IDENTITY_NOTE_START} Their identity check is waiting for a person's review; they were told: "${text}" ${MESSAGES.inReview.hint}]`,
  };
}

// ---------------------------------------------------------------------------
// The tools.

export function createCredentialsTools(
  deps: CredentialsToolsDeps,
): PluginTool[] {
  return createCredentials(deps).tools;
}

/**
 * The plugin's tools and its answer to identity-check events, which share
 * the tools' Hub-first grant path (the link status is read at Self with the
 * person's `link` grant, exactly as `credentials_action_status` reads it).
 */
export function createCredentials(deps: CredentialsToolsDeps): {
  tools: PluginTool[];
  identityCheckEvent: (
    event: IdentityCheckUpdatedEvent,
    ctx: RuntimeContext,
  ) => Promise<ChannelEventResult>;
} {
  const now = deps.now ?? Date.now;
  const sleep = deps.sleep ?? defaultSleep;
  const { cfg, oracle } = deps;
  /** The credential types this oracle may check (the operator's list). */
  const acceptedTypes = `Credential types this service accepts (vct): ${Object.keys(cfg.trustedIssuers).join(', ') || 'none'}; their issuers are set by the operator.`;
  /** `not_available`, logged with the tool and what was missing. */
  const unavailable = (ctx: RuntimeContext, tool: string, reason: string) => {
    ctx.logger.warn(`[credentials] ${tool}: not_available (${reason})`);
    return refusal('not_available', MESSAGES.notAvailable);
  };

  /**
   * The person's live cards at the Hub, asked at most once per tool call and
   * inside the per-person cap (6 a minute). Null when the Hub cannot say (it
   * is down, slow, older than the list, or the cap is reached): the tool
   * then goes on with what the kv holds, exactly as before the list existed;
   * `failure()` then names why, as a reason code for the logs.
   */
  function liveCards(
    ctx: RuntimeContext,
    ready: Ready,
    kv: UserKvSurface,
    deadline: number,
  ): HubCards {
    let asked: Promise<ListedPermission[] | null> | undefined;
    let why: string | undefined;
    const read = () =>
      (asked ??= (async () => {
        try {
          if (!(await chargePermissionList(kv, now()))) {
            why = 'list_capped';
            return null;
          }
          return await hubClient(ctx, ready, deps, deadline).listPermissions(
            ready.binding,
          );
        } catch (error) {
          why =
            error instanceof CredentialsServiceError
              ? `${error.service}_${error.status}_${error.code}`
              : 'list_error';
          ctx.logger.debug?.(`[credentials] permissions list: ${why}`);
          return null;
        }
      })());
    return Object.assign(read, { failure: () => why });
  }

  /** Keep a listed card in the kv: its id as this person's, and its status. */
  async function keepCard(kv: UserKvSurface, card: ListedPermission) {
    await recordPermission(
      kv,
      card.id,
      card.items.map((i) => i.kind),
      card.url,
      askedOfItems(card.items),
    );
    await writePermissionCache(kv, stateOf(card), now());
  }

  /**
   * Forget card `permissionId` for `action`, as the Hub marks its item out
   * of date: it stops being the card in use or the one waiting, and its
   * cached grants are dropped. Another card's records are left alone.
   */
  async function forgetAction(
    kv: UserKvSurface,
    action: string,
    permissionId: string,
  ) {
    const inUse = ActionRecord.safeParse(
      await kv.get(CREDENTIALS_KV_NAMESPACE, actionKey(action)),
    );
    if (inUse.success && inUse.data.permissionId === permissionId)
      await kv.delete(CREDENTIALS_KV_NAMESPACE, actionKey(action));
    if ((await readPendingAction(kv, action)) === permissionId)
      await clearPendingAction(kv, action);
    await clearGrantsCacheOf(kv, action, permissionId);
  }

  /**
   * Fill the kv for `action` again from the Hub's list: the newest allowed
   * card whose item for the action is allowed (with a grant still running
   * when `needGrants`) becomes the one in use; failing that, a card still
   * waiting is remembered as waiting. `outdated`: the only allowed card for
   * the action is marked `current: false` (it is forgotten, never used).
   * `grants`: the running grants of the card put in use (none otherwise).
   */
  async function restoreAction(
    kv: UserKvSurface,
    action: string,
    cards: () => Promise<ListedPermission[] | null>,
    needGrants: boolean,
  ): Promise<{
    found: 'allowed' | 'pending' | 'outdated' | 'none';
    grants: PermissionGrant[];
  }> {
    const listed = await cards();
    if (!listed) return { found: 'none', grants: [] };
    const nowSeconds = Math.floor(now() / 1000);
    for (const card of listed) {
      if (!cardIs(card, 'allowed', nowSeconds)) continue;
      const item = actionItem(card, action);
      if (!item || !itemIs(card, item, 'allowed', nowSeconds)) continue;
      const grants = runningGrants(item, nowSeconds);
      if (needGrants && grants.length === 0) continue;
      await kv.set(
        CREDENTIALS_KV_NAMESPACE,
        actionKey(action),
        { permissionId: card.id },
        { idleTtlMs: ACTION_RECORD_TTL_MS },
      );
      await clearGrantsCache(kv, action);
      await writeGrantsCache(kv, action, card.id, grants, now());
      await clearPendingAction(kv, action);
      await keepCard(kv, card);
      return { found: 'allowed', grants };
    }
    const asked: PermissionRequest = { kind: 'service-action', action };
    const waiting = coveringCard(listed, asked, 'pending', nowSeconds);
    if (waiting) {
      await writePendingAction(kv, action, waiting.id, ACTION_RECORD_TTL_MS);
      await keepCard(kv, waiting);
      return { found: 'pending', grants: [] };
    }
    const stale = outdatedCard(listed, asked, nowSeconds);
    if (!stale) return { found: 'none', grants: [] };
    await forgetAction(kv, action, stale.id);
    return { found: 'outdated', grants: [] };
  }

  /**
   * The answer when the Hub already holds what a request tool was about to
   * ask for; without `answer` a new card is needed (or the Hub could not say).
   *
   * - Every item is covered by a card the person allowed: nothing is sent,
   *   and the kv is filled again from those cards.
   * - Else ONE card still waiting covers every item: that card's link again.
   * - Else (also when only some items are covered): a new card for the whole
   *   list, as one card is one answer.
   *
   * An allowed item the Hub marks `current: false` covers nothing; its
   * action's records are forgotten and `again` is true, so the person is
   * asked "once more" rather than as if for the first time.
   */
  async function existingCard(
    kv: UserKvSurface,
    permissions: readonly PermissionRequest[],
    cards: () => Promise<ListedPermission[] | null>,
    askedAgain: boolean,
  ): Promise<{ answer?: Record<string, unknown>; again: boolean }> {
    const listed = await cards();
    if (!listed?.length) return { again: askedAgain };
    const nowSeconds = Math.floor(now() / 1000);
    const allowed = permissions.map((p) =>
      coveringCard(listed, p, 'allowed', nowSeconds),
    );
    if (allowed.every((card) => card !== undefined)) {
      for (const [i, p] of permissions.entries()) {
        const card = allowed[i];
        if (!card) continue;
        if (p.kind === 'service-action')
          await restoreAction(kv, p.action, async () => [card], false);
        else await keepCard(kv, card);
      }
      const newest = listed.find((card) => allowed.includes(card));
      return {
        again: false,
        answer: said(ALREADY_ALLOWED, {
          status: 'already_allowed',
          ...(newest ? { permissionId: newest.id } : {}),
        }),
      };
    }
    let again = askedAgain;
    for (const [i, p] of permissions.entries()) {
      if (allowed[i]) continue;
      const stale = outdatedCard(listed, p, nowSeconds);
      if (!stale) continue;
      again = true;
      if (p.kind === 'service-action')
        await forgetAction(kv, p.action, stale.id);
    }
    const waiting = listed.find(
      (card) =>
        cardIs(card, 'pending', nowSeconds) &&
        permissions.every((p) =>
          card.items.some(
            (item) =>
              itemIs(card, item, 'pending', nowSeconds) && itemCovers(item, p),
          ),
        ),
    );
    if (!waiting) return { again };
    // The link: the Hub's when it lists one, else the one kept when the card
    // was sent. Without either the card cannot be sent again, so a new one is.
    const url = waiting.url ?? (await permissionUrl(kv, waiting.id));
    if (!url || !onHub(url)) return { again };
    for (const p of permissions)
      if (p.kind === 'service-action')
        await writePendingAction(
          kv,
          p.action,
          waiting.id,
          ACTION_RECORD_TTL_MS,
        );
    await keepCard(kv, { ...waiting, url });
    const wording = again
      ? againMessage(url)
      : cardMessage(oracle.name, url, permissions);
    return {
      again,
      answer: said(
        {
          message: wording.message,
          hint: `This is the card they were sent before and have not answered yet; no new card was made. ${wording.hint ?? ''}`.trim(),
          ...(wording.button ? { button: wording.button } : {}),
        },
        {
          status: 'sent',
          permissionId: waiting.id,
          url,
          ...(waiting.expiresAt ? { expiresAt: waiting.expiresAt } : {}),
        },
      ),
    };
  }

  /** Whether a link kept in the kv is on the Hub's own origin. */
  function onHub(value: string): boolean {
    try {
      const url = new URL(value);
      return (
        url.origin === new URL(cfg.hub.url).origin &&
        !url.username &&
        !url.password
      );
    } catch {
      return false;
    }
  }

  /**
   * Ask the Hub for ONE card holding `items`. The shared path of the three
   * request tools (and of `credentials_request_action` when what the person
   * allowed is out of date: `again`); `label` keeps each tool's request key
   * apart. A card is sent only when the Hub holds none that already covers
   * the items. `cards` and `deadline`: the calling tool's own reader of the
   * Hub's list (read once per call) and its one deadline.
   */
  async function sendCard(
    ctx: RuntimeContext,
    toolName: string,
    label: string,
    items: z.infer<typeof RequestPermissionsInput>['items'],
    opts: {
      again?: boolean;
      cards?: () => Promise<ListedPermission[] | null>;
      deadline?: number;
    } = {},
  ) {
    const ready = readiness(ctx, cfg);
    if (isRefusal(ready)) return ready;
    const kv = kvOf(ctx);
    if (!kv) return unavailable(ctx, toolName, 'no_kv');
    const permissions: PermissionRequest[] = [];
    const seenActions = new Set<string>();
    for (const [position, item] of items.entries()) {
      if (item.kind === 'service-action') {
        if (seenActions.has(item.action))
          return refusal('duplicate_item', MESSAGES.duplicateItem);
        seenActions.add(item.action);
      }
      if (item.kind === 'credential-check') {
        const accepted = acceptedIssuers(cfg, item.vct, item.issuers);
        if ('error' in accepted)
          return items.length > 1 ? itemRefusal(position, accepted) : accepted;
        permissions.push({
          kind: 'credential-check',
          vct: item.vct,
          issuers: accepted.issuers,
          claims: sortedUnique(item.claims),
          days: item.days,
        });
      } else {
        permissions.push({
          kind: 'service-action',
          action: item.action,
          ...(item.days !== undefined ? { days: item.days } : {}),
        });
      }
    }
    const deadline = opts.deadline ?? now() + TOOL_DEADLINE_MS;
    try {
      // The Hub first: a card the person already allowed, or one still
      // waiting for them, is used again instead of sending another.
      const existing = await existingCard(
        kv,
        permissions,
        opts.cards ?? liveCards(ctx, ready, kv, deadline),
        opts.again ?? false,
      );
      if (existing.answer) return existing.answer;
      const card = await hubClient(ctx, ready, deps, deadline).request({
        ...ready.binding,
        requestKey: await requestKeyOf(ctx, label),
        expiresAt: Math.floor(now() / 1000) + PERMISSION_CARD_TTL_SECONDS,
        permissions,
      });
      for (const p of permissions) {
        if (p.kind !== 'service-action') continue;
        // The new card waits beside the one in use; it takes over only
        // once allowed, so a declined card leaves working grants alone.
        await writePendingAction(kv, p.action, card.id, ACTION_RECORD_TTL_MS);
      }
      await recordPermission(
        kv,
        card.id,
        permissions.map((p) => p.kind),
        card.url,
        askedOf(permissions),
      );
      const wording = existing.again
        ? againMessage(card.url)
        : cardMessage(oracle.name, card.url, permissions);
      return said(wording, {
        status: 'sent',
        permissionId: card.id,
        url: card.url,
        expiresAt: card.expiresAt,
      });
    } catch (error) {
      return failed(ctx, toolName, error, now());
    }
  }

  const requestPermissions = tool(
    async (raw, ctx) => {
      const args = RequestPermissionsInput.parse(raw);
      return delivered(
        ctx,
        'credentials_request_permissions',
        await sendCard(
          ctx,
          'credentials_request_permissions',
          'permissions',
          args.items,
        ),
      );
    },
    {
      name: 'credentials_request_permissions',
      description: [
        "Ask the person for everything you need in ONE card (1-5 items); they tap Allow or Don't allow once and Allow covers every item. Always put all you need in one request instead of sending several cards.",
        'Item kinds: {kind:"credential-check", vct, claims, issuers?, days} (standing permission to check one credential; the accepted issuers are configured, you may only narrow them) and {kind:"service-action", action, days?} (an action from the Hub\'s approved list: use only an entry id the operator\'s instructions name; self.identity-check is the only built-in one).',
        'Identity: ONE item {kind:"service-action", action:"self.identity-check", days} covers the identity link, the credential offer AND the standing consent to check IdentityLevel1 afterwards; add a credential-check item only for other credential types.',
        acceptedTypes,
        'Send the `message` (it holds the link) as it is, in a short message. Never paste ids or tokens. Then read the answer with credentials_permission_status, or go on once they say they allowed it.',
        'status "already_allowed": a permission they allowed earlier still covers every item, so nothing was sent; go on with the task. If a card for the same items is still waiting for their answer, that same card comes back (no new one is made). WhatsApp only.',
      ].join(' '),
      schema: RequestPermissionsInput,
    },
  );

  const requestCheckPermission = tool(
    async (raw, ctx) => {
      const args = CheckPermissionInput.parse(raw);
      return delivered(
        ctx,
        'credentials_request_check_permission',
        await sendCard(
          ctx,
          'credentials_request_check_permission',
          'check-permission',
          [{ ...args, kind: 'credential-check' }],
        ),
      );
    },
    {
      name: 'credentials_request_check_permission',
      description: [
        'One-item form of credentials_request_permissions: ask the person, once, for standing permission to check one credential (for example that they are over 18). If you need more than this, use credentials_request_permissions and ask for everything in ONE card.',
        'Ask for one credential type and as few fields as you need; the accepted issuers are configured (you may only narrow them).',
        acceptedTypes,
        'Send the `message` (it holds the link) as it is, in a short message. Never paste ids or tokens. Then check the answer with credentials_permission_status, or just call credentials_check once they say they allowed it. status "already_allowed": they allowed this earlier and nothing was sent; just call credentials_check.',
        'WhatsApp only.',
      ].join(' '),
      schema: CheckPermissionInput,
    },
  );

  const WAIT_CARD: Wording = {
    message: "There's nothing new yet. Please give it a little while.",
    hint: `You asked about this card too often (at most 6 a minute). Do not poll; wait for the person to say they answered. ${NO_LATER_MESSAGE}`,
  };

  /**
   * A card's status through the person's kv: kept 5 s (a declined, expired
   * or stopped card for good) and at most 6 reads a minute per card.
   */
  async function readCard(
    ctx: RuntimeContext,
    ready: Ready,
    kv: UserKvSurface,
    id: string,
    deadline: number,
  ): Promise<PermissionState | CredentialsRefusal> {
    const allowed = await chargePermissionStatus(kv, id, now());
    const kept = await readPermissionCache(kv, id, now());
    if (kept) return kept;
    if (!allowed) return refusal('rate_limited', WAIT_CARD);
    const state = await hubClient(ctx, ready, deps, deadline).status(id);
    await writePermissionCache(kv, state, now());
    return state;
  }

  const permissionStatus = tool(
    async (raw, ctx) => {
      const ready = readiness(ctx, cfg);
      if (isRefusal(ready)) return ready;
      const kv = kvOf(ctx);
      if (!kv)
        return unavailable(ctx, 'credentials_permission_status', 'no_kv');
      const args = PermissionStatusInput.parse(raw);
      const deadline = now() + TOOL_DEADLINE_MS;
      // Only this person's cards: the ones the kv recorded, else the ones
      // the Hub lists for this person's binding. Another person's id, or a
      // made-up one, is "not found".
      if (!(await knowsPermission(kv, args.permissionId))) {
        const listed = await liveCards(ctx, ready, kv, deadline)();
        const card = listed?.find((c) => c.id === args.permissionId);
        if (!card) return refusal('not_found', MESSAGES.notFound);
        await keepCard(kv, card);
      }
      try {
        const state = await readCard(
          ctx,
          ready,
          kv,
          args.permissionId,
          deadline,
        );
        if ('error' in state) return state;
        // Allowed items the Hub marks out of date are not in use: their
        // action's records go, and the person is asked once more.
        const outdated =
          state.status === 'allowed'
            ? state.items.filter(
                (item) =>
                  itemStatusOf(state, item) === 'allowed' &&
                  isOutdatedItem(item),
              )
            : [];
        for (const item of outdated)
          if (item.kind === 'service-action' && item.action)
            await forgetAction(kv, item.action, state.id);
        const wording: Wording = outdated.length
          ? {
              message: MESSAGES.permissionOutdated.message,
              hint: `Item ${outdated.map((i) => i.index + 1).join(', ')} (counting from 1) is marked current: false. ${MESSAGES.permissionOutdated.hint}`,
            }
          : STATUS_WORDING[state.status];
        return said(wording, {
          permissionId: state.id,
          status: state.status,
          ...(state.allowedAt ? { allowedAt: state.allowedAt } : {}),
          ...(state.expiresAt ? { expiresAt: state.expiresAt } : {}),
          items: state.items.map((item) => itemSummary(item, state.status)),
        });
      } catch (error) {
        return failed(ctx, 'credentials_permission_status', error, now());
      }
    },
    {
      name: 'credentials_permission_status',
      description:
        'Read whether the person answered a permission card (pending, allowed, declined, expired or stopped) and, per item, its kind, state and what was granted (ids only, never tokens). The card is answered as a whole: Allow covers every item. Use the permissionId a credentials_request_* tool returned. Only call it when you need the answer to go on; do not poll in a loop. WhatsApp only.',
      schema: PermissionStatusInput,
      effect: 'read',
    },
  );

  const check = tool(
    async (raw, ctx) => {
      const ready = readiness(ctx, cfg);
      if (isRefusal(ready)) return ready;
      const kv = kvOf(ctx);
      const signer: OracleJwsSigner | undefined =
        ctx.ucan.signJws && ctx.ucan.oraclePublicKey
          ? {
              signJws: ctx.ucan.signJws,
              oraclePublicKey: ctx.ucan.oraclePublicKey,
            }
          : undefined;
      if (!kv || !signer || !deps.verifier || !cfg.publicUrl)
        return unavailable(
          ctx,
          'credentials_check',
          !kv
            ? 'no_kv'
            : !signer
              ? 'no_signer'
              : !deps.verifier
                ? 'no_blocksync_url'
                : 'no_public_url',
        );
      const args = CheckInput.parse(raw);
      const accepted = acceptedIssuers(cfg, args.vct, args.issuers);
      if ('error' in accepted) return accepted;
      const query: CredentialQuery = {
        vct: args.vct,
        issuers: accepted.issuers,
        claims: sortedUnique(args.claims),
      };
      try {
        return await runCheck({
          ctx,
          ready,
          kv,
          signer,
          verifier: deps.verifier,
          publicUrl: cfg.publicUrl,
          query,
          catalogIssuers: accepted.configured,
          purpose: purposeFor(cfg, args.vct),
        });
      } catch (error) {
        if (error instanceof VerifierSetupError)
          return unavailable(ctx, 'credentials_check', error.code);
        if (isVerificationUnavailable(error)) {
          // A resolver or a status list could not be read: the kit's codes say which.
          ctx.logger.warn(
            `[credentials] credentials_check: verification_unavailable (${describeError(error)})`,
          );
          return refusal('verification_unavailable', MESSAGES.busy);
        }
        return failed(ctx, 'credentials_check', error, now());
      }
    },
    {
      name: 'credentials_check',
      description: [
        "Check one of the person's credentials: give the credential type (vct) and the fields you need (the accepted issuers are configured; you may only narrow them). It asks their IXO wallet, waits up to about 25 seconds and verifies the answer. Why you ask is fixed wording; you do not write it.",
        acceptedTypes,
        'result: valid (claims holds only the fields you asked for), invalid, revoked, expired, none (they did not share one) or pending (no standing permission answered: send them the `message`, which holds their wallet link, or ask for standing permission first with credentials_request_permissions).',
        'Do not call it before the person has allowed the card that covers it (a credential-check item, or the identity-check entry); credentials_request_action is not for credential-check items.',
        'Calling it again with the same fields continues the same request; it does not ask twice. Never quote the claims back beyond what the conversation needs. WhatsApp only.',
      ].join(' '),
      schema: CheckInput,
    },
  );

  async function runCheck(input: {
    ctx: RuntimeContext;
    ready: Ready;
    kv: UserKvSurface;
    signer: OracleJwsSigner;
    verifier: VerifierContext;
    publicUrl: string;
    query: CredentialQuery;
    /** Every issuer the oracle accepts for the type (its catalog entry lists them). */
    catalogIssuers: string[];
    purpose: string;
  }) {
    const { ctx, ready, kv, query } = input;
    const start = now();
    // One deadline: the setup, every call and the wait all end inside it.
    const deadline = start + (deps.checkWaitMs ?? CHECK_WAIT_MS);
    const worker = workerClient(ctx, ready, deps, deadline);
    const subject = ctx.user.did;
    const queryHash = (
      await sha256Hex(canonicalJson({ subject, ...query }))
    ).slice(0, 32);
    const nowSeconds = Math.floor(start / 1000);

    // Rows of checks that have ended go now, not at the next flush.
    await pruneEndedChecks(kv, nowSeconds).catch(() => undefined);

    const openId = await kv.get(CREDENTIALS_KV_NAMESPACE, openKey(queryHash));
    let row =
      typeof openId === 'string'
        ? liveCheck(await readCheck(kv, openId), nowSeconds)
        : null;
    if (row && row.subject !== subject) row = null;

    if (!row) {
      await deps.memo.ensure(
        worker,
        ready.cfg.credentials.url,
        {
          did: ready.cfg.oracleDid,
          name: oracle.name,
          ...(oracle.description ? { description: oracle.description } : {}),
        },
        { purpose: input.purpose, ...query, issuers: input.catalogIssuers },
      );
      const checkId = randomToken(16);
      const expiresAt = nowSeconds + CHECK_REQUEST_TTL_SECONDS;
      const keys = await newResponseKeys();
      const kid = keys.publicJwk.kid;
      if (!kid) throw new Error('The response key has no kid');
      // The token names the answer key, so the endpoint stores nothing
      // that is not an answer encrypted to it.
      const token = await sealResponseToken(
        { ownerDid: subject, checkId, expiresAt, kid },
        { serviceKey: ready.cfg.serviceKey, oracleDid: ready.cfg.oracleDid },
      );
      const built = await buildCredentialRequest({
        verifier: input.verifier,
        oracleDid: ready.cfg.oracleDid,
        signer: input.signer,
        responseUri: `${input.publicUrl}/${RESPONSE_ROUTE_PREFIX}/${token}`,
        query,
        expiresAt,
        keys,
      });
      const fresh: CheckRow = {
        v: 1,
        checkId,
        queryHash,
        expiresAt,
        subject,
        query,
        requestJwt: built.requestJwt,
        privateJwk: built.privateJwk,
      };
      // The row exists before the request is visible anywhere.
      await saveCheck(kv, fresh, start);
      // Two calls at once for the same check: the first one wins.
      if (typeof openId === 'string')
        await kv.delete(CREDENTIALS_KV_NAMESPACE, openKey(queryHash));
      const winner = await kv.update(
        CREDENTIALS_KV_NAMESPACE,
        openKey(queryHash),
        (current) => (typeof current === 'string' ? current : checkId),
        { idleTtlMs: checkIdleTtlMs(expiresAt, start) },
      );
      if (winner !== checkId) {
        await deleteCheck(kv, fresh);
        const theirs =
          typeof winner === 'string' ? await readCheck(kv, winner) : null;
        if (!theirs) throw new Error('The open check has no row');
        row = theirs;
      } else {
        try {
          const deposited = await worker.deposit({
            subject,
            ref: checkId,
            request: built.requestJwt,
            purpose: input.purpose,
            expiresAt,
          });
          row = {
            ...fresh,
            requestId: deposited.id,
            ...(deposited.wallet_url
              ? { walletUrl: deposited.wallet_url }
              : {}),
          };
          await kv.set(CREDENTIALS_KV_NAMESPACE, checkKey(checkId), row, {
            idleTtlMs: checkIdleTtlMs(expiresAt, start),
          });
        } catch (error) {
          // Nobody can answer a request that was not deposited.
          await deleteCheck(kv, fresh);
          throw error;
        }
      }
    }

    const active: CheckRow = row;
    const finish = async (
      result: CheckOutcome['result'] | 'none',
      claims?: Record<string, unknown>,
    ) => {
      await deleteCheck(kv, active);
      return said(CHECK_WORDING[result], {
        result,
        ...(claims ? { claims } : {}),
        ...(active.requestId ? { requestId: active.requestId } : {}),
      });
    };

    let delay = 500;
    // The worker is asked only after the Hub had a moment to answer.
    let lastPoll = now();
    let answered = false;
    for (;;) {
      // The verified answer: the person's object stored it (and only it).
      const outcome = await readResult(kv, active.checkId);
      if (outcome)
        return finish(
          outcome.result,
          outcome.result === 'valid' ? outcome.claims : undefined,
        );
      if (active.requestId && now() - lastPoll >= WORKER_POLL_MS) {
        lastPoll = now();
        try {
          const view = await worker.requestStatus(active.requestId);
          if (
            view.status === 'declined' ||
            view.status === 'cancelled' ||
            view.status === 'expired'
          )
            return finish('none');
          answered = view.status === 'answered';
        } catch {
          // The worker did not answer this time: keep waiting.
        }
      }
      if (now() >= deadline) break;
      await sleep(Math.min(delay, Math.max(0, deadline - now())));
      delay = Math.min(Math.round(delay * 1.6), 3_000);
    }
    if (answered) {
      // Answered at the worker, but no verified answer from the person
      // reached the response endpoint: this request cannot be answered
      // again, so it is closed here and the next call starts a new one.
      await finish('none');
      ctx.logger.warn(
        '[credentials] credentials_check: answer_lost (answered at the worker, no verified answer arrived)',
      );
      return refusal('answer_lost', MESSAGES.busy);
    }
    const walletUrl = active.requestId
      ? walletUrlOf(cfg, active.requestId, active.walletUrl)
      : `${cfg.hub.url}/credentials`;
    return {
      result: 'pending',
      ...(active.requestId ? { requestId: active.requestId } : {}),
      walletUrl,
      message: `Please answer in your IXO wallet: ${walletUrl}`,
      hint: 'No standing permission answered. Send `message` as it is, or ask for standing permission with credentials_request_check_permission (it sends no new card when the Hub already holds one for this); then call again with the same fields to continue this request.',
    };
  }

  const requestActionPermission = tool(
    async (raw, ctx) => {
      const args = ActionPermissionInput.parse(raw);
      return delivered(
        ctx,
        'credentials_request_action_permission',
        await sendCard(
          ctx,
          'credentials_request_action_permission',
          `action-permission:${args.action}`,
          [
            {
              kind: 'service-action',
              action: args.action,
              ...(args.days !== undefined ? { days: args.days } : {}),
            },
          ],
        ),
      );
    },
    {
      name: 'credentials_request_action_permission',
      description: [
        'One-item form of credentials_request_permissions: ask the person for permission to use a service on their behalf: an action from the Hub\'s approved list: use only an entry id the operator\'s instructions name; self.identity-check is the only built-in one (the Hub refuses ids it does not know). "self.identity-check" covers the identity link, the credential offer and the consent to check the identity credential afterwards, all on one card.',
        "They get a card in the IXO wallet showing who asks, the action, the service, what it allows and how long; they tap Allow or Don't allow.",
        'Send the `message` (it holds the link) as it is, in a short message; never paste ids or tokens. Once they allow it, call credentials_request_action. status "already_allowed": they allowed this earlier and nothing was sent; call credentials_request_action now. If you need more than this, use credentials_request_permissions.',
        'WhatsApp only.',
      ].join(' '),
      schema: ActionPermissionInput,
    },
  );

  /**
   * The card to use for `action`: the newest one once it is allowed (it then
   * replaces the one in use), else the one in use. A card still waiting, with
   * none in use, is `permission_pending`; one that ended is dropped.
   */
  async function cardFor(
    ctx: RuntimeContext,
    ready: Ready,
    kv: UserKvSurface,
    action: string,
    deadline: number,
  ): Promise<
    { permissionId: string; state?: PermissionState } | CredentialsRefusal
  > {
    const inUse = ActionRecord.safeParse(
      await kv.get(CREDENTIALS_KV_NAMESPACE, actionKey(action)),
    );
    const waiting = await readPendingAction(kv, action);
    let pendingAnswer: CredentialsRefusal | null = null;
    if (waiting) {
      const state = await readCard(ctx, ready, kv, waiting, deadline);
      const item = 'error' in state ? undefined : actionItem(state, action);
      if ('error' in state) {
        pendingAnswer = state;
      } else if (
        state.status === 'allowed' &&
        item &&
        (item.status ?? 'allowed') === 'allowed' &&
        isOutdatedItem(item)
      ) {
        // Allowed, but out of date already: never put in use.
        await clearPendingAction(kv, action);
        if (!inUse.success) return outdatedRefusal();
      } else if (
        state.status === 'allowed' &&
        (item?.status ?? 'allowed') === 'allowed'
      ) {
        await kv.set(
          CREDENTIALS_KV_NAMESPACE,
          actionKey(action),
          { permissionId: waiting },
          { idleTtlMs: ACTION_RECORD_TTL_MS },
        );
        await clearGrantsCache(kv, action);
        await clearPendingAction(kv, action);
        return { permissionId: waiting, state };
      } else if (state.status === 'pending') {
        pendingAnswer = refusal(
          'permission_pending',
          MESSAGES.permissionPending,
        );
      } else {
        // Declined, expired or stopped: the card in use, if any, stays.
        await clearPendingAction(kv, action);
        if (!inUse.success) return endedRefusal(state.status, item?.status);
      }
    }
    if (inUse.success) return { permissionId: inUse.data.permissionId };
    return pendingAnswer ?? refusal('no_permission', MESSAGES.noPermission);
  }

  /**
   * The allowed grants of an action's card from what the kv leads to, or the
   * refusal to answer: only when the Hub's list could not be read (see
   * {@link withGrants}). The copy kept in the kv (until the earliest grant
   * ends) is used first; `fresh` skips it (Self refused it).
   */
  async function allowedGrants(
    ctx: RuntimeContext,
    ready: Ready,
    kv: UserKvSurface,
    action: string,
    deadline: number,
    fresh: boolean,
  ): Promise<
    { grants: PermissionGrant[]; cached: boolean } | CredentialsRefusal
  > {
    const card = await cardFor(ctx, ready, kv, action, deadline);
    if ('error' in card) return card;
    const { permissionId } = card;
    if (!fresh) {
      const kept = await readGrantsCache(
        kv,
        action,
        permissionId,
        Math.floor(now() / 1000),
      );
      if (kept) return { grants: kept, cached: true };
    }
    const state =
      card.state ??
      (await hubClient(ctx, ready, deps, deadline).status(permissionId));
    if (state.status === 'pending')
      return refusal('permission_pending', MESSAGES.permissionPending);
    const item = actionItem(state, action);
    if (
      state.status === 'allowed' &&
      item &&
      (item.status ?? 'allowed') === 'allowed' &&
      isOutdatedItem(item)
    ) {
      await forgetAction(kv, action, permissionId);
      return outdatedRefusal();
    }
    const grants = (item?.grants ?? []).filter(
      (g) => g.expiresAt > Math.floor(now() / 1000),
    );
    if (
      state.status !== 'allowed' ||
      (item?.status ?? 'allowed') !== 'allowed' ||
      grants.length === 0
    ) {
      await kv.delete(CREDENTIALS_KV_NAMESPACE, actionKey(action));
      await clearGrantsCache(kv, action);
      return endedRefusal(state.status, item?.status);
    }
    await writeGrantsCache(kv, action, permissionId, grants, now());
    return { grants, cached: false };
  }

  /**
   * Run `run` with the action's grants, the Hub first: the person's live
   * cards are read from the Hub (the list, once per tool call) before any
   * grant is used, and only what the Hub answers decides.
   *
   * - The newest allowed card whose item for the action is allowed, not out
   *   of date (`current: false`) and holds running grants: its grants are
   *   used and the kv's copy is refreshed from them.
   * - Anything else: what the kv kept for the action (the card in use and
   *   its grants) is dropped, and the answer is "not answered yet" (a card
   *   is waiting), "once more" (out of date: `credentials_request_action`
   *   then sends the card again), "ended" (the kv had a card for it) or
   *   "ask for permission".
   *
   * Only when the list cannot be read (the Hub down, slow, 429/5xx, an older
   * Hub without the route, the per-person cap) does the tool go on from the
   * kv as before, so a Hub outage never blocks the person: kept grants that
   * have not ended are used, and when Self refuses them (401 or 403) they
   * are dropped, read again from the card and `run` is tried once more.
   * That fallback is logged with its reason code.
   */
  async function withGrants<T>(
    ctx: RuntimeContext,
    ready: Ready,
    kv: UserKvSurface,
    action: string,
    deadline: number,
    run: (grants: PermissionGrant[]) => Promise<T>,
    /** The tool call's reader of the Hub's list (read at most once). */
    cards: HubCards,
    toolName: string,
  ): Promise<T | CredentialsRefusal> {
    const listed = await cards();
    if (listed) {
      const fromHub = await grantsFromHub(kv, action, listed);
      if ('error' in fromHub) return fromHub;
      return run(fromHub.grants);
    }
    ctx.logger.warn(
      `[credentials] ${toolName}: hub_unread (${cards.failure() ?? 'unknown'}); going on from the kept permission`,
    );
    const grantsFor = (fresh: boolean) =>
      allowedGrants(ctx, ready, kv, action, deadline, fresh);
    const first = await grantsFor(false);
    if ('error' in first) return first;
    try {
      return await run(first.grants);
    } catch (error) {
      const refused =
        error instanceof CredentialsServiceError &&
        error.service === 'self' &&
        (error.status === 401 || error.status === 403);
      if (!first.cached || !refused) throw error;
    }
    await clearGrantsCache(kv, action);
    const second = await grantsFor(true);
    if ('error' in second) return second;
    return run(second.grants);
  }

  /** {@link withGrants} from the Hub's answer: the grants to use, or the refusal. */
  async function grantsFromHub(
    kv: UserKvSurface,
    action: string,
    listed: ListedPermission[],
  ): Promise<{ grants: PermissionGrant[] } | CredentialsRefusal> {
    const inUse = ActionRecord.safeParse(
      await kv.get(CREDENTIALS_KV_NAMESPACE, actionKey(action)),
    );
    const waiting = await readPendingAction(kv, action);
    const { found, grants } = await restoreAction(
      kv,
      action,
      async () => listed,
      true,
    );
    if (found === 'allowed') return { grants };
    // Nothing the Hub lists may be used: the kv's copy goes too.
    await kv.delete(CREDENTIALS_KV_NAMESPACE, actionKey(action));
    await clearGrantsCache(kv, action);
    if (found === 'pending')
      return refusal('permission_pending', MESSAGES.permissionPending);
    if (found === 'outdated') return outdatedRefusal();
    await clearPendingAction(kv, action);
    return inUse.success || waiting
      ? refusal('permission_ended', MESSAGES.permissionEnded)
      : refusal('no_permission', MESSAGES.noPermission);
  }

  /** The grant with this catalogue id (`link`, `offer`), else the one with this capability. */
  function grantFor(
    grants: PermissionGrant[],
    id: 'link' | 'offer',
    capability: { can: string; with: string },
  ): PermissionGrant | undefined {
    return (
      grants.find((g) => g.id === id) ??
      grants.find((g) => g.can === capability.can && g.with === capability.with)
    );
  }

  /**
   * For an entry that has no flow here: what the person allowed (ids,
   * capabilities, audiences and ends; never tokens), so the agent or another
   * plugin can act on it.
   */
  async function grantedOutline(
    ctx: RuntimeContext,
    ready: Ready,
    kv: UserKvSurface,
    action: string,
    deadline: number,
    cards: () => Promise<ListedPermission[] | null>,
  ) {
    try {
      const first = await outlineFromKv(ctx, ready, kv, action, deadline);
      if (!isEnded(first)) return first;
      // Nothing usable in the kv: the Hub's list, once.
      const { found } = await restoreAction(kv, action, cards, false);
      if (found === 'allowed')
        return await outlineFromKv(ctx, ready, kv, action, deadline);
      if (found === 'pending')
        return refusal('permission_pending', MESSAGES.permissionPending);
      if (found === 'outdated') return outdatedRefusal();
      return first;
    } catch (error) {
      return failed(ctx, 'credentials_request_action', error, now());
    }
  }

  /** {@link grantedOutline} from what the kv leads to. */
  async function outlineFromKv(
    ctx: RuntimeContext,
    ready: Ready,
    kv: UserKvSurface,
    action: string,
    deadline: number,
  ) {
    const card = await cardFor(ctx, ready, kv, action, deadline);
    if ('error' in card) return card;
    const state =
      card.state ??
      (await readCard(ctx, ready, kv, card.permissionId, deadline));
    if ('error' in state) return state;
    if (state.status === 'pending')
      return refusal('permission_pending', MESSAGES.permissionPending);
    const item = actionItem(state, action);
    if (
      !item ||
      state.status !== 'allowed' ||
      (item.status ?? 'allowed') !== 'allowed'
    )
      return endedRefusal(state.status, item?.status);
    if (isOutdatedItem(item)) {
      await forgetAction(kv, action, state.id);
      return outdatedRefusal();
    }
    const nowSeconds = Math.floor(now() / 1000);
    const live = {
      ...item,
      grants: (item.grants ?? []).filter((g) => g.expiresAt > nowSeconds),
    };
    return said(
      {
        message: 'Thanks, you allowed it.',
        hint: "This runtime has no built-in flow for this action; the granted capabilities are listed (no tokens). Another plugin or the operator's instructions say how to use them.",
      },
      {
        status: 'granted',
        permissionId: state.id,
        ...itemSummary(live, state.status),
      },
    );
  }

  const requestAction = tool(
    async (raw, ctx) => {
      const ready = readiness(ctx, cfg);
      if (isRefusal(ready)) return ready;
      const kv = kvOf(ctx);
      if (!kv) return unavailable(ctx, 'credentials_request_action', 'no_kv');
      const args = ActionInput.parse(raw);
      const deadline = now() + TOOL_DEADLINE_MS;
      const cards = liveCards(ctx, ready, kv, deadline);
      const answer =
        args.action !== IDENTITY_CHECK_ACTION
          ? await grantedOutline(ctx, ready, kv, args.action, deadline, cards)
          : await identityLink(
              ctx,
              ready,
              kv,
              args.action,
              deadline,
              cards,
              args.context,
            );
      if (!isOutdatedAnswer(answer))
        return delivered(ctx, 'credentials_request_action', answer);
      // What the person allowed no longer matches the catalogue entry: ask
      // for the card again on the normal path (one card, or the one already
      // waiting), in "once more" words.
      return delivered(
        ctx,
        'credentials_request_action',
        await sendCard(
          ctx,
          'credentials_request_action',
          `again:${args.action}`,
          [{ kind: 'service-action', action: args.action }],
          { again: true, cards, deadline },
        ),
      );
    },
    {
      name: 'credentials_request_action',
      description: [
        'Do not call this before the person has allowed the card. It is for service-action items only, never for credential-check items (those need no action: use credentials_check). Carry out a catalogued action the person allowed (on the card from credentials_request_permissions or credentials_request_action_permission). For "self.identity-check" (one card is enough: it holds the link, the offer and the consent) it asks Self for a link where they start an identity check (it works once and ends after about 15 minutes; the first device that opens it keeps it).',
        'Send the `message` (it holds the link) as it is. Keep the linkId to read progress with credentials_action_status. Never call this to answer "is it done?", "how is it going?" or "I finished": that is credentials_action_status. It reads their newest link first and makes a new one only when that one ended (passed, failed, expired, stopped): while it is open it answers it instead, status "sent" with again: true (the same link, still unopened) or status "already_open" (opened but not started, linkStatus "opened"; or their check is in progress: review: true: a person reviews it; saving: true: it passed and their proof is still being saved); relay the message and read progress with credentials_action_status only when they write. error "already_verified": they are already verified and no link is needed; go on with the task you were doing (a next step you were given comes first, and nothing else); call credentials_check only if this oracle itself needs to read a claim from the credential for its own decision.',
        'context (self.identity-check only): "next_step" when the check is the next step of a task already under way (after a reward claim, or right after they allowed the card; the message then opens with "Next, ..."), otherwise leave it out ("standalone").',
        'For any other entry id it answers status "granted" with the capabilities the person allowed (ids, capabilities, audiences and ends; never tokens) so another plugin or you can act on them. If they have not allowed it yet the answer says so: ask for permission first.',
        'When what they allowed earlier no longer matches what the service needs now, it sends the card again by itself and answers status "sent" with a permissionId and a `message` asking for their OK once more: send it as it is and call this again once they allowed it. WhatsApp only.',
      ].join(' '),
      schema: ActionInput,
    },
  );

  /**
   * `self.identity-check`: a link from Self, made with the `link` and
   * `offer` grants of the allowed card. State-aware: the person's newest
   * link is read at Self first, and while it is still open its own answer
   * comes back instead of a new link (the same link again while nobody
   * opened it; its progress once it was opened or a check started). A new
   * link is made only when there is none, or the last one ended (passed,
   * failed, expired, stopped), or it is about to end.
   */
  async function identityLink(
    ctx: RuntimeContext,
    ready: Ready,
    kv: UserKvSurface,
    action: string,
    deadline: number,
    cards: HubCards,
    context: (typeof LINK_CONTEXTS)[number],
  ) {
    const requestKey = await requestKeyOf(ctx, `action:${action}`);
    const opening =
      context === 'next_step'
        ? 'Next, you need to do your identity check. Open this link.'
        : 'To do your identity check, open this link.';
    try {
      return await withGrants(
        ctx,
        ready,
        kv,
        action,
        deadline,
        async (grants) => {
          const link = grantFor(grants, 'link', LINK_CAPABILITY);
          const offer = grantFor(grants, 'offer', {
            can: 'credentials/offer',
            with: 'ixo:credentials',
          });
          if (!link || !offer) {
            ctx.logger.warn('[credentials] the allowed card lacks a grant');
            return refusal('internal_error', MESSAGES.ourSide);
          }
          const self = selfClient(ctx, ready, deps, link, deadline);
          const previous = await latestLinkRecord(kv);
          if (previous) {
            const open = await stillOpen(ctx, kv, self, previous);
            if (open) return open;
          }
          const channel = ctx.session.channel?.provider;
          const created = await self.createLink({
            offerConsent: offer.token,
            requestKey,
            ...(channel ? { channel } : {}),
          });
          // Kept with the card whose grants made it, so an identity-check
          // event for it is recognised and knows what came next.
          const inUse = ActionRecord.safeParse(
            await kv.get(CREDENTIALS_KV_NAMESPACE, actionKey(action)),
          );
          await recordLink(
            kv,
            created.linkId,
            inUse.success ? inUse.data.permissionId : undefined,
            { url: created.url, expiresAt: created.expiresAt },
          );
          return linkMessage(ctx, opening, {
            linkId: created.linkId,
            url: created.url,
            expiresAt: created.expiresAt,
          });
        },
        cards,
        'credentials_request_action',
      );
    } catch (error) {
      // Self refuses a new link only while a check is in progress: that
      // one is continued, not a failure. Self keeps only a hash of its
      // token, so its URL cannot be sent again.
      const open = openLinkOf(error);
      if (open) {
        // Passed and being saved, or in review: Self says so beside the
        // 409, or the status read last did.
        const last =
          open.status === 'in_progress'
            ? await lastLinkState(kv, open.linkId)
            : null;
        return await openCheckAnswer(ctx, kv, {
          ...open,
          ...(isSaving(open) || last?.saving === true ? { saving: true } : {}),
          ...(isInReview(open) || last?.review === true
            ? { review: true }
            : {}),
        });
      }
      return failed(ctx, 'credentials_request_action', error, now());
    }
  }

  /** The message of an identity-check link (a new one, or the same one again). */
  function linkMessage(
    ctx: RuntimeContext,
    opening: string,
    link: { linkId: string; url: string; expiresAt: number },
    again = false,
  ) {
    const ends = endsFor(ctx, link.expiresAt);
    const first = again
      ? "You haven't opened your identity check link yet. Here it is again."
      : opening;
    return said(
      {
        message: `${first} ${ID_CHECK_STEPS} ${
          ends
            ? `The link works once and ends ${ends}: ${link.url}`
            : `The link works once: ${link.url}`
        }`,
        hint: again
          ? 'Their link is still open and nobody opened it: this is the same link, sent again (no new link was made). Send `message` as it is. For "is it done?" or "how is it going?" use credentials_action_status, not this tool.'
          : 'Send `message` as it is. Keep the linkId to read progress with credentials_action_status. Calling this again while the link is open answers the same link or its progress, never a new link; for "is it done?" or "how is it going?" use credentials_action_status.',
        button: {
          body: `${first} ${ID_CHECK_STEPS} ${
            ends
              ? `The link works once and ends ${ends}.`
              : 'The link works once.'
          }`,
          url: link.url,
          label: 'start_check',
        },
      },
      {
        status: 'sent',
        ...(again ? { again: true } : {}),
        url: link.url,
        linkId: link.linkId,
        expiresAt: link.expiresAt,
      },
    );
  }

  /**
   * The answer for the person's newest link when it is still open, or null
   * when a new link is due (it ended, is about to end, or cannot be read: a
   * new link then replaces one nobody started, and Self itself refuses one
   * while a check is in progress).
   */
  async function stillOpen(
    ctx: RuntimeContext,
    kv: UserKvSurface,
    self: SelfLinksClient,
    previous: LinkRecord,
  ) {
    let state: LinkState;
    try {
      state =
        (await readLinkCache(kv, previous.linkId, now())) ??
        (await self.linkStatus(previous.linkId));
    } catch (error) {
      ctx.logger.warn(
        `[credentials] identity link: the last link's status is unread (${
          error instanceof CredentialsServiceError
            ? `${error.service}_${error.status}_${error.code}`
            : describeError(error)
        }); asking Self for a new one`,
      );
      return null;
    }
    // Before the cache write, which marks an outcome read as seen.
    const wasToldReview = toldInReview(previous);
    await writeLinkCache(kv, state, now());
    const nowSeconds = Math.floor(now() / 1000);
    if (state.status === 'in_progress')
      return openCheckAnswer(ctx, kv, state, wasToldReview);
    // A link about to end is not reused: a new one gets a full window.
    if (state.expiresAt <= nowSeconds + 60) return null;
    if (state.status === 'sent' && previous.url) {
      ctx.logger.log(
        '[credentials] identity link: the last link is still unopened; sending it again',
      );
      return linkMessage(
        ctx,
        '',
        { linkId: state.linkId, url: previous.url, expiresAt: state.expiresAt },
        true,
      );
    }
    if (state.status === 'opened') {
      ctx.logger.log(
        '[credentials] identity link: the last link is opened, no check started; answering its status',
      );
      const ends = endsFor(ctx, state.expiresAt);
      return said(
        {
          message: ends
            ? `You opened the link but haven't started the check yet. Please go back to the page you opened and start it before it ends ${ends}. If you closed that page, ask me again after that and I'll send a new link.`
            : "You opened the link but haven't started the check yet. Please go back to the page you opened and start it.",
          hint: `Their link is open on the device that opened it (it cannot be opened again elsewhere), so no new link was made. Send \`message\` as it is. ${NO_LATER_MESSAGE}`,
        },
        {
          status: 'already_open',
          linkId: state.linkId,
          linkStatus: state.status,
          expiresAt: state.expiresAt,
        },
      );
    }
    // Passed, failed, expired, cancelled, or unopened with no URL kept.
    return null;
  }

  /**
   * The answer for a link whose check is in progress: being saved, in
   * review (the first notice, or "still being checked" once they were told),
   * or still going.
   */
  async function openCheckAnswer(
    ctx: RuntimeContext,
    kv: UserKvSurface,
    open: {
      linkId: string;
      status: LinkStatus;
      expiresAt: number;
      review?: true;
      saving?: true;
    },
    wasToldReview?: boolean,
  ) {
    const saving = isSaving(open) || open.saving === true;
    const review = !saving && (isInReview(open) || open.review === true);
    const told =
      review &&
      (wasToldReview ?? toldInReview(await readLinkRecord(kv, open.linkId)));
    if (review) await noteLinkSeen(kv, open.linkId, 'in_review');
    return said(
      saving
        ? MESSAGES.saving
        : review
          ? told
            ? MESSAGES.stillInReview
            : MESSAGES.inReview
          : {
              message: checkInProgress(endsFor(ctx, open.expiresAt)),
              hint: `Its link cannot be sent again; read progress with credentials_action_status when they write. ${NO_LATER_MESSAGE}`,
            },
      {
        status: 'already_open',
        linkId: open.linkId,
        linkStatus: open.status,
        ...(saving ? { saving: true } : review ? { review: true } : {}),
        expiresAt: open.expiresAt,
      },
    );
  }

  /**
   * When something ends, for the person: "at 18:05" in their zone when the
   * runtime knows it, else "in 15 minutes"; null once it has passed.
   */
  function endsFor(ctx: RuntimeContext, unixSeconds: number): string | null {
    return whenItEnds(unixSeconds, {
      ...(ctx.user.timezone ? { timeZone: ctx.user.timezone } : {}),
      nowMs: now(),
    });
  }

  /** The open link Self named in a 409 `link_active`, when it named one. */
  function openLinkOf(error: unknown): z.infer<typeof OpenLink> | null {
    if (
      !(error instanceof CredentialsServiceError) ||
      error.service !== 'self' ||
      error.code !== 'link_active'
    )
      return null;
    const parsed = OpenLink.safeParse(error.body);
    return parsed.success ? parsed.data : null;
  }

  const LINK_WORDING: Record<LinkStatus, Wording> = {
    sent: {
      message: "You haven't opened the link yet.",
      hint: `Wait for them; do not poll. ${NO_LATER_MESSAGE}`,
    },
    opened: {
      message: "You opened the link but haven't started the check yet.",
      hint: `Wait for them to go on; do not poll. ${NO_LATER_MESSAGE}`,
    },
    in_progress: {
      message:
        "Your identity check has started but isn't finished yet. Please finish the steps on the page you opened.",
      hint: `Wait for them to finish; do not poll. ${NO_LATER_MESSAGE}`,
    },
    passed: {
      message: 'Your identity check is done. You are verified.',
      hint: `The check is done. Go on with the task you were doing (a next step you were given comes first); ${CHECK_ONLY_FOR_OWN_DECISION}.`,
    },
    // Chosen by Self's `failure`: see `failedWording`.
    failed: IDENTITY_FAILED_WORDING.not_verified,
    expired: {
      message: 'That link has ended.',
      hint: 'Offer a new link only if they still want the check.',
    },
    cancelled: {
      message: 'That link was stopped.',
      hint: 'Offer a new link only if they still want the check.',
    },
  };

  const WAIT_WORDING: Wording = {
    message: "There's nothing new yet. Please give it a little while.",
    hint: `You asked about this link too often (at most 6 a minute). Do not poll; wait for the person to say how it went. ${NO_LATER_MESSAGE}`,
  };

  const actionStatus = tool(
    async (raw, ctx) => {
      const ready = readiness(ctx, cfg);
      if (isRefusal(ready)) return ready;
      const kv = kvOf(ctx);
      if (!kv) return unavailable(ctx, 'credentials_action_status', 'no_kv');
      const args = ActionStatusInput.parse(raw);
      if (args.action !== IDENTITY_CHECK_ACTION)
        return refusal('unknown_action', {
          message: MESSAGES.unknownAction.message,
          hint: 'Only self.identity-check has progress to read here; use credentials_permission_status for any other entry.',
        });
      const ref = args.ref ?? (await latestLinkRecord(kv))?.linkId;
      if (!ref)
        return refusal('not_found', {
          message: "I haven't sent you an identity check link yet.",
          hint: 'No identity-check link was made for this person here. Offer one with credentials_request_action only if they want to do the check.',
        });
      // Whether they were already told it is in review, before a read
      // below marks that outcome seen.
      const wasToldReview = toldInReview(await readLinkRecord(kv, ref));
      const stateAnswer = (state: {
        linkId: string;
        status: LinkStatus;
        updatedAt: number;
        expiresAt: number;
        review?: true;
        saving?: true;
        failure?: LinkFailure;
      }) => {
        const saving = isSaving(state);
        const review = !saving && isInReview(state);
        const failure = state.status === 'failed' ? state.failure : undefined;
        return said(
          saving
            ? MESSAGES.saving
            : review
              ? wasToldReview
                ? MESSAGES.stillInReview
                : MESSAGES.inReview
              : state.status === 'failed'
                ? failedWording(state)
                : LINK_WORDING[state.status],
          {
            linkId: state.linkId,
            status: state.status,
            ...(saving ? { saving: true } : review ? { review: true } : {}),
            ...(failure ? { failure } : {}),
            updatedAt: state.updatedAt,
            expiresAt: state.expiresAt,
          },
        );
      };
      try {
        // At most 6 calls a minute per link; the status read last is kept
        // 5 s (a final one for good), so most calls never reach Self.
        const allowed = await chargeLinkStatus(kv, ref, now());
        const kept = await readLinkCache(kv, ref, now());
        if (!allowed)
          return kept
            ? stateAnswer(kept)
            : refusal('rate_limited', WAIT_WORDING);
        if (kept) return stateAnswer(kept);
        const deadline = now() + TOOL_DEADLINE_MS;
        const answer = await withGrants(
          ctx,
          ready,
          kv,
          args.action,
          deadline,
          async (grants) => {
            const link = grantFor(grants, 'link', LINK_CAPABILITY);
            if (!link) return refusal('internal_error', MESSAGES.ourSide);
            return selfClient(ctx, ready, deps, link, deadline).linkStatus(ref);
          },
          liveCards(ctx, ready, kv, deadline),
          'credentials_action_status',
        );
        if ('error' in answer) return answer;
        await writeLinkCache(kv, answer, now());
        return stateAnswer(answer);
      } catch (error) {
        return failed(ctx, 'credentials_action_status', error, now());
      }
    },
    {
      name: 'credentials_action_status',
      description:
        'Read the progress of an action credentials_request_action started. Use this, never credentials_request_action, whenever the person asks about an identity check they were sent ("is it done?", "how is it going?", "did it work?", "I finished", "it doesn\'t work"). For "self.identity-check" pass the linkId as ref (or leave ref out for their newest link) (sent, opened, in_progress, passed, failed, expired, cancelled; in_progress with review: true means a person from support reviews it, which can take a while; in_progress with saving: true means it passed and their proof is still being saved, which can take a minute; failed with failure: "error" means a problem on our side, not about them, and failure: "too_many_attempts" means they used up their tries; without failure they were not verified). No personal data comes back. Only call it when the person writes and you need the answer; do not poll in a loop (at most 6 a minute per link; an answer is kept 5 seconds). You can never message them first. WhatsApp only.',
      schema: ActionStatusInput,
      effect: 'read',
    },
  );

  /**
   * An identity-check event (`identity_check_updated`): only for a link this
   * person's kv recorded (made by `credentials_request_action`); any other
   * link is `pass`. Self is read first, with the person's `link` grant on
   * the Hub-first path, and Self's state decides, not the event's: in
   * review, passed or failed is told once, anything else says nothing.
   * Nothing is said for an outcome the person already learned in the chat
   * or an event already told (the same event asked again after a restart
   * answers as before).
   */
  async function identityCheckEvent(
    event: IdentityCheckUpdatedEvent,
    ctx: RuntimeContext,
  ): Promise<ChannelEventResult> {
    const kv = kvOf(ctx);
    if (!kv) return { kind: 'pass' };
    const record = await readLinkRecord(kv, event.linkId);
    if (!record) return { kind: 'pass' };
    const known = (status: IdentityOutcome) =>
      record.told?.requestId !== event.requestId &&
      (record.told?.status === status || record.seen === status);
    // A repeat of what the person already knows needs no read at Self.
    if (known(event.status)) return { kind: 'ignore' };
    const ready = readiness(ctx, cfg);
    if (isRefusal(ready)) return { kind: 'ignore' };
    const deadline = now() + TOOL_DEADLINE_MS;
    let state: Awaited<ReturnType<SelfLinksClient['linkStatus']>>;
    try {
      const answer = await withGrants(
        ctx,
        ready,
        kv,
        IDENTITY_CHECK_ACTION,
        deadline,
        async (grants) => {
          const link = grantFor(grants, 'link', LINK_CAPABILITY);
          if (!link) return refusal('internal_error', MESSAGES.ourSide);
          return selfClient(ctx, ready, deps, link, deadline).linkStatus(
            event.linkId,
          );
        },
        liveCards(ctx, ready, kv, deadline),
        'identity check event',
      );
      if ('error' in answer) {
        ctx.logger.warn(
          `[credentials] identity check event: self_unread (${answer.error})`,
        );
        return { kind: 'ignore' };
      }
      state = answer;
    } catch (error) {
      ctx.logger.warn(
        `[credentials] identity check event: self_unread (${
          error instanceof CredentialsServiceError
            ? `${error.service}_${error.status}_${error.code}`
            : describeError(error)
        })`,
      );
      return { kind: 'ignore' };
    }
    const outcome = identityOutcomeOf(state);
    if (outcome !== event.status)
      ctx.logger.warn(
        `[credentials] identity check event: self says ${outcome ?? state.status}, event ${event.status}; following Self`,
      );
    if (!outcome || known(outcome)) {
      await writeLinkCache(kv, state, now());
      return { kind: 'ignore' };
    }
    // Told before the cache is written: the write marks the outcome seen.
    await noteLinkTold(kv, event.linkId, outcome, event.requestId);
    await writeLinkCache(kv, state, now());
    const card = record.permissionId
      ? await readPermissionRecord(kv, record.permissionId)
      : null;
    return identityAnswer(outcome, card?.verifiedNext, state.failure);
  }

  return {
    tools: [
      requestPermissions,
      requestCheckPermission,
      permissionStatus,
      check,
      requestActionPermission,
      requestAction,
      actionStatus,
    ],
    identityCheckEvent,
  };
}

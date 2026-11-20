import type { ActionOutcomeWire } from '@ixo/ixo-transaction/topic-proposals';
import type { ActionOutcomeV1 } from '@ixo/action-protocol';
import { z } from 'zod';
import {
  IDENTITY_CHECK_EVENT_STATUSES,
  PERMISSION_EVENT_STATUSES,
} from '../plugin-api/channel-events';
import {
  CHANNEL_MAX_FILE_BYTES,
  channelAttachmentRef,
} from '../attachments/channel';
import type { AttachmentInput } from '../attachments/types';
import { refusalAction, refusalRetryAfterSeconds } from '../core/turn-gate';
import { RenderCapabilityWire } from '../delivery/rich';
import type { ReplyPlan } from '../delivery/types';
import type { TurnRefusal } from '../plugin-api/turn-gate';

/**
 * A channel provider id (`whatsapp`, later others): lower-case, starts with a
 * letter, at most 32 characters. The runtime does not enumerate providers;
 * the gateway and the Auth Hub do. An unknown provider is delivered with the
 * default delivery profile.
 */
export const ChannelProviderId = z.string().regex(/^[a-z][a-z0-9_-]{0,31}$/);

export const ChannelReplyReference = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('unavailable') }),
  z.strictObject({
    kind: z.literal('known'),
    requestId: z.string().min(1).max(180),
    author: z.enum(['user', 'oracle']),
    partId: z.string().min(1).max(128).optional(),
  }),
]);
export type ChannelReplyReference = z.infer<typeof ChannelReplyReference>;
export type ChannelReplyContext =
  | {
      kind: 'unavailable';
      /**
       * `other_conversation`: the quoted message is this binding's but
       * belongs to a conversation other than the one the turn runs in.
       * `unknown`: nothing quotable was found (no receipt, no run, the run
       * did not finish, or the gateway could not resolve the quote).
       */
      reason?: 'other_conversation' | 'unknown';
    }
  | {
      kind: 'resolved';
      requestId: string;
      author: 'user' | 'oracle';
      text: string;
    };
/**
 * At most `max` code points. `.max()` counts UTF-16 units, which would refuse
 * a line of emoji the code-point clip has already let through.
 */
const codePoints = (max: number) =>
  z.string().refine((value) => Array.from(value).length <= max, {
    message: `At most ${max} characters`,
  });
export const ChannelControlBody = z.strictObject({
  provider: ChannelProviderId,
  bindingId: z.string().regex(/^chb_[A-Za-z0-9_-]{1,120}$/),
  bindingRevision: z.number().int().positive().safe(),
  requestId: z.string().min(1).max(180),
  cancelRequestIds: z.array(z.string().min(1).max(180)).max(64),
  command: z.discriminatedUnion('kind', [
    z.strictObject({ kind: z.literal('stop') }),
    z.strictObject({ kind: z.literal('status') }),
    z.strictObject({ kind: z.literal('new') }),
    z.strictObject({
      kind: z.literal('resume'),
      sessionId: z.string().min(1).max(255),
    }),
    /** List this binding's sessions; read-only. */
    z.strictObject({ kind: z.literal('topics') }),
    /** Rename the bound session. */
    z.strictObject({
      kind: z.literal('rename'),
      title: codePoints(80).min(1),
    }),
  ]),
});
export type ChannelControlInput = z.infer<typeof ChannelControlBody>;
/** One of a binding's sessions, as `topics` lists it. */
export const ChannelTopic = z.strictObject({
  sessionId: z.string().min(1).max(255),
  /** Null when the session has no title yet or is 'Untitled'. */
  title: codePoints(200).min(1).nullable(),
  /** Epoch ms. */
  createdAt: z.number().int().nonnegative(),
  /** Epoch ms of the session's last activity. */
  updatedAt: z.number().int().nonnegative(),
  /** The last message the person sent in it, clipped to 200 code points. */
  lastUser: codePoints(200).nullable(),
  /** The last finished reply in it, clipped to 200 code points. */
  lastReply: codePoints(200).nullable(),
});
export type ChannelTopic = z.infer<typeof ChannelTopic>;
export const ChannelControlResult = z.strictObject({
  requestId: z.string(),
  sessionId: z.string().nullable(),
  command: z.enum(['stop', 'new', 'resume', 'status', 'topics', 'rename']),
  /** Title of `sessionId` after the command; null: untitled, unknown or no session. */
  title: codePoints(200).min(1).nullable(),
  /**
   * Only for `topics`: this binding's sessions at its current consent
   * revision, most recent activity first, at most 20, the bound one included.
   */
  topics: z.array(ChannelTopic).max(20).optional(),
});
export type ChannelControlResult = z.infer<typeof ChannelControlResult>;
/**
 * A stored result as read back: receipts written before `title` existed
 * have none and replay as untitled instead of re-running the control.
 */
export const StoredChannelControlResult = ChannelControlResult.extend({
  title: codePoints(200).min(1).nullable().default(null),
});
export type ChannelControlOutcome =
  | { ok: true; result: ChannelControlResult }
  | Exclude<ChannelTurnOutcome, { ok: true }>;

/** The longest filename a channel file keeps, in code points (the gateway's own bound). */
export const CHANNEL_FILENAME_MAX = 200;

/**
 * A filename as the runtime keeps it: at most `CHANNEL_FILENAME_MAX` code
 * points (a longer one is cut, never refused), and the file's kind when the
 * name is empty, so a name alone never refuses a turn.
 */
export function channelFilename(filename: string, kind: string): string {
  const clipped = Array.from(filename).slice(0, CHANNEL_FILENAME_MAX).join('');
  return clipped || (kind === 'image' ? 'photo' : kind);
}

/**
 * A file the person sent on the channel (a WhatsApp photo, video, document
 * or audio file). The gateway downloads it from the provider and serves it
 * from a capability link of its own; the bytes never ride in the body.
 * `size` is bounded by the gateway's own per-file limit (50 MiB).
 */
export const ChannelAttachment = z
  .strictObject({
    url: z
      .string()
      .max(2000)
      .url()
      .refine((value) => value.startsWith('https://'), 'must be an https URL'),
    filename: z.string(),
    mimetype: z.string().min(1).max(100),
    size: z.number().int().nonnegative().max(CHANNEL_MAX_FILE_BYTES),
    sha256: z.string().regex(/^[0-9a-f]{64}$/),
    kind: z.enum(['image', 'video', 'document', 'audio']),
  })
  .transform((attachment) => ({
    ...attachment,
    filename: channelFilename(attachment.filename, attachment.kind),
  }));
export type ChannelAttachment = z.infer<typeof ChannelAttachment>;

/**
 * The run's attachment inputs for channel files: each names its file by its
 * opaque `channel:` reference, never by its link, so the model, the hidden
 * notes and the stored metadata never see a link. The owner object reads
 * the bytes through its channel source (`attachments/channel.ts`).
 */
export function channelAttachmentInputs(
  attachments: readonly ChannelAttachment[],
): AttachmentInput[] {
  return attachments.map((attachment) => ({
    channelRef: channelAttachmentRef(attachment.sha256),
    filename: attachment.filename,
    mimetype: attachment.mimetype,
    size: attachment.size,
  }));
}

/** Same cap as the attachment pipeline (`MAX_ATTACHMENTS`). */
export const MAX_CHANNEL_ATTACHMENTS = 10;

/** The most code points a blocked file's name carries in a notice. */
export const CHANNEL_NOTICE_FILENAME_MAX = 120;
/** The most characters a notice's detail carries. */
export const CHANNEL_NOTICE_DETAIL_MAX = 400;

/**
 * The gateway's reasons for blocking a file it checked after the run (its
 * `file-safety` verdicts that concern the file's content; a refused type or
 * size is never noticed).
 */
export const ChannelFileBlockReason = z.enum([
  'content_mismatch',
  'pdf_active',
  'office_macro',
  'office_embedded',
  'office_external',
  'unverifiable',
  'zip_limits',
]);
export type ChannelFileBlockReason = z.infer<typeof ChannelFileBlockReason>;

/**
 * A delivery notice: the gateway blocked a file the oracle sent with
 * `send_file`, after the run that sent it ended. The gateway sends it as a
 * turn of its own in the session of the plan that held the file, so the
 * model learns what was found and sends a corrected file. The runtime
 * downloads and checks nothing: `filename` and `detail` are the gateway's
 * words, shown to the model as quoted data, never to the person.
 */
export const ChannelFileNotice = z.strictObject({
  kind: z.literal('file_blocked'),
  /** The blocked part, as the plan named it. */
  partId: z.string().min(1).max(64),
  /** The file's name as the plan gave it, sanitised by the gateway. */
  filename: codePoints(CHANNEL_NOTICE_FILENAME_MAX).min(1),
  reason: ChannelFileBlockReason,
  /** What was found, for the model: one line of plain text without a link. */
  detail: z
    .string()
    .min(1)
    .max(CHANNEL_NOTICE_DETAIL_MAX)
    .refine((value) => !/[\r\n\u2028\u2029]/u.test(value), {
      message: 'detail must be one line',
    })
    .refine((value) => !/[a-z][a-z0-9+.-]*:\/\//iu.test(value), {
      message: 'detail must not carry a link',
    }),
  /** The request whose plan held the file. */
  originalRequestId: z.string().min(1).max(180),
});
export type ChannelFileNotice = z.infer<typeof ChannelFileNotice>;

const OPAQUE_EVENT_ID = /^[A-Za-z0-9_-]{1,128}$/;

/**
 * An event instead of a message from the person, told to the gateway by the
 * Auth Hub. Only ids and a fixed status: never text from the Hub or Self.
 * The turn runs in the binding's current session, and the plugin that owns
 * the card or link reads it at the Hub or Self before anything is said
 * (`OraclePlugin.handleChannelEvent`).
 *
 * - `permission_answered`: the person answered a permission card.
 * - `identity_check_updated`: an identity check at Self went into review,
 *   passed or failed.
 */
export const ChannelEvent = z.discriminatedUnion('kind', [
  z.strictObject({
    kind: z.literal('permission_answered'),
    /** The Hub card id. */
    permissionId: z.string().regex(OPAQUE_EVENT_ID),
    status: z.enum(PERMISSION_EVENT_STATUSES),
  }),
  z.strictObject({
    kind: z.literal('identity_check_updated'),
    /** Self's identity link id. */
    linkId: z.string().regex(OPAQUE_EVENT_ID),
    status: z.enum(IDENTITY_CHECK_EVENT_STATUSES),
  }),
]);
export type ChannelEvent = z.infer<typeof ChannelEvent>;

/**
 * The one request id an event is sent with (`permission:<permissionId>:<status>`
 * or `identity:<linkId>:<status>`): a resend is the same request.
 */
export function channelEventRequestId(event: ChannelEvent): string {
  return event.kind === 'permission_answered'
    ? `permission:${event.permissionId}:${event.status}`
    : `identity:${event.linkId}:${event.status}`;
}

/** The longest link an entry point keeps, in UTF-16 units (a longer one is refused, never cut). */
export const CHANNEL_ENTRY_URL_MAX = 2048;
/** The most code points an ad's headline carries. */
export const CHANNEL_ENTRY_HEADLINE_MAX = 256;
/** The most code points an ad's primary text carries. */
export const CHANNEL_ENTRY_BODY_MAX = 2048;
/** The most code points an ad's welcome message carries. */
export const CHANNEL_ENTRY_WELCOME_MAX = 1024;

/**
 * Characters entry-point text never holds: control characters other than
 * tab and newline (`\p{Cc}`: C0, DEL, C1) and the bidi controls
 * (`\p{Bidi_Control}`: U+061C, U+200E, U+200F, U+202A–U+202E,
 * U+2066–U+2069). The gateway strips them before it sends the text.
 */
function hasEntryControl(value: string): boolean {
  for (const char of value)
    if (
      (/\p{Cc}/u.test(char) && char !== '\n' && char !== '\t') ||
      /\p{Bidi_Control}/u.test(char)
    )
      return true;
  return false;
}

/** Ad text: at most `max` code points, not blank, no controls. */
const entryText = (max: number) =>
  codePoints(max)
    .refine((value) => value.trim() !== '', { message: 'must not be blank' })
    .refine((value) => !hasEntryControl(value), {
      message: 'must not carry control characters',
    });

/** An `https:` link that `new URL` parses, without whitespace or control characters. */
const entryUrl = z
  .string()
  .max(CHANNEL_ENTRY_URL_MAX)
  .refine(
    (value) => {
      if (/[\s\p{Cc}]/u.test(value)) return false;
      try {
        return new URL(value).protocol === 'https:';
      } catch {
        return false;
      }
    },
    { message: 'must be an https URL' },
  );

/** Meta's `source_type` and `media_type`: lower-case letters and `_`. */
const ENTRY_KIND = /^[a-z_]{1,32}$/;

/**
 * How the person reached this chat, when the provider says: Meta's
 * `referral` object on an inbound WhatsApp message that followed a tap on
 * a Click-to-WhatsApp ad, every field validated and capped by the gateway
 * and checked again here (a body that breaks a rule is refused, never
 * repaired). Every text and link in it was written by the advertiser or
 * Meta: untrusted data, never instructions. `ctwaClid` is Meta's click id
 * for that tap: never log it.
 */
export const ChannelEntryPoint = z.strictObject({
  kind: z.literal('ad'),
  /** The ad network. */
  provider: z.literal('meta'),
  /** When the message that carried it was sent, in epoch ms. */
  sentAt: z.number().int().nonnegative().safe(),
  /** Meta's `source_type` (`ad` for a Click-to-WhatsApp ad). */
  sourceType: z.string().regex(ENTRY_KIND),
  /** Meta's `source_id`: the ad id, digits. */
  sourceId: z.string().regex(/^[0-9]{1,32}$/),
  /** Meta's `source_url`: the link the person tapped. */
  sourceUrl: entryUrl.optional(),
  /** The ad's headline. */
  headline: entryText(CHANNEL_ENTRY_HEADLINE_MAX).optional(),
  /** The ad's primary text. */
  body: entryText(CHANNEL_ENTRY_BODY_MAX).optional(),
  /** Meta's `media_type` (`image`, `video`). */
  mediaType: z.string().regex(ENTRY_KIND).optional(),
  /** The ad's image, a time-limited Meta CDN link. */
  imageUrl: entryUrl.optional(),
  /** The ad's video, a time-limited Meta CDN link. */
  videoUrl: entryUrl.optional(),
  /** The video ad's thumbnail, a time-limited Meta CDN link. */
  thumbnailUrl: entryUrl.optional(),
  /** Meta's click id for the tap (absent for WhatsApp Status placements). Never log it. */
  ctwaClid: z
    .string()
    .regex(/^[A-Za-z0-9_-]{1,512}$/)
    .optional(),
  /** The ad's welcome message (`welcome_message.text`). */
  welcomeMessageText: entryText(CHANNEL_ENTRY_WELCOME_MAX).optional(),
});
export type ChannelEntryPoint = z.infer<typeof ChannelEntryPoint>;

/**
 * Every field of a channel turn. `ChannelTurnBody` adds the rules that tie
 * `message`, `notice` and `event` together; this object is what other
 * schemas take fields from.
 */
const ChannelTurnFields = z.strictObject({
  provider: ChannelProviderId,
  bindingId: z.string().regex(/^chb_[A-Za-z0-9_-]{1,120}$/),
  bindingRevision: z.number().int().positive().safe(),
  requestId: z.string().min(1).max(180),
  remoteMessageRef: z.string().regex(/^hmac:[a-f0-9]{64}$/),
  sessionId: z.string().min(1).max(255).optional(),
  /** An explicit correction stays in its current session, even with routing enabled. */
  sessionPolicy: z.literal('continue').optional(),
  /** What the person sent. Required, except on a turn that carries `notice` or `event`. */
  message: z.string().min(1).max(16_000).optional(),
  /** Files sent with the message; `message` carries the caption or a placeholder. */
  attachments: z
    .array(ChannelAttachment)
    .min(1)
    .max(MAX_CHANNEL_ATTACHMENTS)
    .optional(),
  replyTo: ChannelReplyReference.optional(),
  /**
   * A delivery notice instead of a message from the person. It runs in the
   * session of the original turn's plan (`sessionId`, `sessionPolicy:
   * 'continue'`), with no files and no quote, and is answered like a turn.
   */
  notice: ChannelFileNotice.optional(),
  /**
   * An event instead of a message from the person (`ChannelEvent`): no
   * message, files, quote, notice, session or tapped `choice`;
   * `sessionPolicy: 'continue'`; the request id is
   * `channelEventRequestId(event)`. It may carry `render`, so the answer to
   * an event can hold the same rich parts as any answer. Sent only to a
   * runtime whose turn results list `permission_event` in `features` (both
   * kinds).
   */
  event: ChannelEvent.optional(),
  /**
   * What the gateway can show beyond text for this binding (reply buttons,
   * lists, link buttons, cards), and the link-button labels and link origins
   * it accepts. With a message: sent only to a runtime whose turn results
   * list `rich_messages`. With an event: only to one that lists both
   * `rich_messages` and `rich_events` (0.50.0 refuses it there). Never with
   * a notice. Absent: the reply is text only.
   */
  render: RenderCapabilityWire.optional(),
  /**
   * The person tapped a reply button or list row the oracle offered:
   * `message` is the option's title, `id` the tapped id. Checked against
   * the choices offered in this session; an unknown id reads as text.
   */
  choice: z.strictObject({ id: z.string().min(1).max(256) }).optional(),
  /**
   * When the person sent this message according to the provider (WhatsApp's
   * own timestamp on the inbound message), in epoch ms. Sent only to a
   * runtime whose turn results list `provider_sent_at`, and only with a
   * message: never with a notice or an event. A value the runtime cannot
   * believe (`plausibleProviderSentAt`) is ignored, not refused.
   */
  providerSentAt: z.number().int().nonnegative().safe().optional(),
  /**
   * The ad the person tapped to reach this chat (`ChannelEntryPoint`).
   * Sent only to a runtime whose turn results list `entry_point`, and only
   * with a message: never with a notice or an event. Untrusted advertiser
   * text: plugin code reads it (`ctx.session.channel.entryPoint`); it never
   * reaches the model, the oracle room or a log.
   */
  entryPoint: ChannelEntryPoint.optional(),
  /**
   * Which kind of oracle the gateway believes it addresses. `companion` is
   * the legacy value; the gateway sends `oracle`. Both are accepted.
   */
  context: z.strictObject({ kind: z.enum(['companion', 'oracle']) }),
});

export const ChannelTurnBody = ChannelTurnFields.superRefine((body, ctx) => {
  if (body.event) {
    for (const field of [
      'message',
      'attachments',
      'replyTo',
      'notice',
      'sessionId',
      // An event has no tap; `render` is allowed (`rich_events`).
      'choice',
      'providerSentAt',
      'entryPoint',
    ] as const)
      if (body[field] !== undefined)
        ctx.addIssue({
          code: 'custom',
          path: [field],
          message: `${field} is not allowed with an event`,
        });
    if (body.sessionPolicy !== 'continue')
      ctx.addIssue({
        code: 'custom',
        path: ['sessionPolicy'],
        message: "an event is sent with sessionPolicy 'continue'",
      });
    if (body.requestId !== channelEventRequestId(body.event))
      ctx.addIssue({
        code: 'custom',
        path: ['requestId'],
        message: `an event is sent with requestId ${channelEventRequestId(body.event)}`,
      });
    return;
  }
  if (!body.notice) {
    if (body.message === undefined)
      ctx.addIssue({
        code: 'custom',
        path: ['message'],
        message: 'message is required',
      });
    return;
  }
  for (const field of [
    'attachments',
    'replyTo',
    'render',
    'choice',
    'providerSentAt',
    'entryPoint',
  ] as const)
    if (body[field] !== undefined)
      ctx.addIssue({
        code: 'custom',
        path: [field],
        message: `${field} is not allowed with a notice`,
      });
  if (body.sessionId === undefined)
    ctx.addIssue({
      code: 'custom',
      path: ['sessionId'],
      message: 'a notice names the session of the original turn',
    });
  if (body.sessionPolicy !== 'continue')
    ctx.addIssue({
      code: 'custom',
      path: ['sessionPolicy'],
      message: "a notice is sent with sessionPolicy 'continue'",
    });
});

export type ChannelTurnInput = z.infer<typeof ChannelTurnBody>;

/**
 * What the runtime can do beyond the base turn contract; every turn result
 * carries the list. `delivery_notice`: a blocked file may be sent back as
 * a `notice` turn. `permission_event`: a permission card's answer, or an
 * identity check's change at Self, may be sent as an `event` turn (a
 * runtime without it refuses one with 400). `rich_messages`: a message turn
 * may carry `render` (what the gateway can show) and `choice` (a tapped
 * option); its plan may then hold `choices`, `link_button` and `cards`
 * parts (a runtime without it refuses either field with 400).
 * `rich_events`: an event turn may carry `render` too, and its answer is
 * planned exactly like a message turn's (0.50.0 lists `rich_messages`
 * without it and refuses `render` with an event with 400).
 * `provider_sent_at`: a message turn may carry `providerSentAt`, the
 * provider's send time of the person's message (a runtime without it
 * refuses the field with 400).
 * `entry_point`: a message turn may carry `entryPoint`, the ad the person
 * tapped to reach the chat (a runtime without it refuses the field with
 * 400).
 */
export const CHANNEL_TURN_FEATURES = [
  'delivery_notice',
  'permission_event',
  'rich_messages',
  'rich_events',
  'provider_sent_at',
  'entry_point',
] as const;
export type ChannelTurnFeature = (typeof CHANNEL_TURN_FEATURES)[number];

/** How far ahead of this runtime's clock a provider send time may be (clock skew). */
export const PROVIDER_SENT_AT_MAX_AHEAD_MS = 5 * 60_000;
/**
 * How old a provider send time may be. WhatsApp's service window is 24
 * hours and the gateway admits nothing older; this leaves room for a
 * message retried late.
 */
export const PROVIDER_SENT_AT_MAX_AGE_MS = 48 * 3_600_000;

/**
 * The turn's `providerSentAt` when it is believable at `now` (epoch ms):
 * not more than `PROVIDER_SENT_AT_MAX_AHEAD_MS` in the future and not older
 * than `PROVIDER_SENT_AT_MAX_AGE_MS`. Anything else is dropped, so a
 * gateway's clock fault never fails a turn and never reaches a plugin.
 */
export function plausibleProviderSentAt(
  value: number | undefined,
  now: number,
): number | undefined {
  if (value === undefined || !Number.isSafeInteger(value)) return undefined;
  if (value > now + PROVIDER_SENT_AT_MAX_AHEAD_MS) return undefined;
  if (value < now - PROVIDER_SENT_AT_MAX_AGE_MS) return undefined;
  return value;
}

/** The most turns one history page holds, and how many when `limit` is absent. */
export const CHANNEL_HISTORY_LIMIT_MAX = 50;
export const CHANNEL_HISTORY_LIMIT_DEFAULT = 20;
/** The largest history request body (bytes). */
export const CHANNEL_HISTORY_BODY_MAX_BYTES = 4096;
/** The longest cursor a history query carries (the Auth Hub accepts at most 512). */
export const CHANNEL_HISTORY_CURSOR_MAX = 512;

const HistoryCursorText = z
  .string()
  .min(1)
  .max(CHANNEL_HISTORY_CURSOR_MAX)
  .regex(/^[A-Za-z0-9._-]+$/);

/**
 * The page a history read asks for: `limit` turns (1-50, default 20), older
 * than `before` or newer than `after` (both exclusive, never both). Cursors
 * are opaque: they come from an earlier page of the same binding.
 */
export const ChannelHistoryQuery = z
  .strictObject({
    limit: z.number().int().min(1).max(CHANNEL_HISTORY_LIMIT_MAX).optional(),
    before: HistoryCursorText.optional(),
    after: HistoryCursorText.optional(),
  })
  .refine((query) => !(query.before && query.after), {
    message: 'before and after are mutually exclusive',
  });
export type ChannelHistoryQuery = z.infer<typeof ChannelHistoryQuery>;

/** `POST /channels/history`: one page of a web binding's conversations. */
export const ChannelHistoryBody = z.strictObject({
  provider: ChannelProviderId,
  bindingId: z.string().regex(/^chb_[A-Za-z0-9_-]{1,120}$/),
  bindingRevision: z.number().int().positive().safe(),
  requestId: z.string().min(1).max(180),
  query: ChannelHistoryQuery,
});
export type ChannelHistoryInput = z.infer<typeof ChannelHistoryBody>;

/**
 * The canonical JSON of a history query, as the person's device signed it
 * and the Auth Hub hashed it into the grant: the keys present, in the order
 * `after`, `before`, `limit`, no spaces.
 */
export function canonicalHistoryQuery(query: ChannelHistoryQuery): string {
  const ordered: Record<string, string | number> = {};
  if (query.after !== undefined) ordered.after = query.after;
  if (query.before !== undefined) ordered.before = query.before;
  if (query.limit !== undefined) ordered.limit = query.limit;
  return JSON.stringify(ordered);
}

/** Lower-case hex SHA-256 of `canonicalHistoryQuery`: the grant's `nb.queryHash`. */
export function historyQueryHash(query: ChannelHistoryQuery): Promise<string> {
  return channelRequestHash(canonicalHistoryQuery(query));
}

export const ChannelOrigin = z.strictObject({
  v: z.literal(1),
  transport: ChannelProviderId,
  binding_id: ChannelTurnFields.shape.bindingId,
  remote_ref: ChannelTurnFields.shape.remoteMessageRef,
});

export type ChannelOrigin = z.infer<typeof ChannelOrigin>;

export function channelOrigin(
  channel: Pick<
    ChannelTurnInput,
    'provider' | 'bindingId' | 'remoteMessageRef'
  >,
): ChannelOrigin {
  return {
    v: 1,
    transport: channel.provider,
    binding_id: channel.bindingId,
    remote_ref: channel.remoteMessageRef,
  };
}

export interface ChannelIdentity {
  callerDid: string;
  provider: string;
  bindingId: string;
  bindingRevision: number;
}

export interface ChannelTurnResponse {
  requestId: string;
  runId: string;
  sessionId: string;
  /** Title of `sessionId` at response time; null when untitled. */
  sessionTitle?: string | null;
  status:
    | 'queued'
    | 'running'
    | 'recovering'
    | 'finished'
    | 'aborted'
    | 'interrupted'
    | 'failed';
  messageId?: string;
  text?: string;
  /** What this runtime supports beyond the base contract (`CHANNEL_TURN_FEATURES`). */
  features: readonly ChannelTurnFeature[];
  /**
   * A finished turn's Reply Plan: the parts to deliver in order (short
   * messages, artefact links and files). `text` stays the whole reply as one
   * message for gateways that predate plans, or that cannot read one of its
   * parts: a file is a link line there.
   */
  plan?: ReplyPlan;
  actionOutcomes?: ActionOutcomeWire[];
  hubActionOutcomes?: ActionOutcomeV1[];
}

export type ChannelErrorStatus =
  | 400
  | 401
  | 402
  | 403
  | 404
  | 409
  | 410
  | 413
  | 428
  | 429
  | 503;

/**
 * The machine-readable reason a channel turn was refused. The gateway maps
 * a refusal by `code` first and by HTTP status second. 428 (Precondition
 * Required) means a precondition on the user's side is missing: fix it
 * (authorize the oracle again, finish setting up the user's oracle room) and
 * retry; it is never a transient outage.
 *
 * | code                              | status | meaning                                               |
 * | --------------------------------- | ------ | ----------------------------------------------------- |
 * | `invalid_request`                 | 400    | body missing, not UTF-8, not JSON, or the wrong shape |
 * | `invalid_cursor`                  | 400    | a history cursor names no message of this binding     |
 * | `unauthorized`                    | 401    | no valid user-rooted channel invocation               |
 * | `expired`                         | 401    | a history grant or invocation has expired             |
 * | `provider_not_supported`          | 403    | a history read for a provider other than `web`        |
 * | `revision_mismatch`               | 403    | a history grant of another binding revision           |
 * | `control_not_supported`           | 403    | a session control for a `web` binding                 |
 * | `scope_mismatch`                  | 403    | the invocation does not cover this binding or body    |
 * | `identity_mismatch`               | 403    | the channel identity does not match the request       |
 * | `identity_required`               | 403    | the binding check got no channel identity             |
 * | `binding_inactive`                | 403    | the Auth Hub reports the binding inactive             |
 * | `channel_grant_not_tool_authority`| 403    | a channel request carried a delegation header         |
 * | `storage_unauthorized`            | 403    | the user's file storage rejected the oracle (final)   |
 * | `session_not_found`               | 404    | the session is not the user's oracle session          |
 * | `request_conflict`                | 409    | the request id already belongs to another message     |
 * | `session_conflict`                | 409    | another session is bound, or the named one is gone:   |
 * |                                   |        | resend the same request without `sessionId`           |
 * | `room_not_encrypted`              | 409    | the user's oracle room is not end-to-end encrypted    |
 * | `room_unavailable`                | 409    | the oracle cannot use the user's oracle room (final)  |
 * | `response_expired`                | 410    | the run was pruned; the request cannot run again      |
 * | `request_too_large`               | 413    | the body is over 64 kB                                |
 * | `turn_refused`                    | (any)  | a plugin refused the turn (`gateTurn`): final for the |
 * |                                   |        | message; relay `message` (and `action` as a link) to  |
 * |                                   |        | the person; `reason` is the plugin's code; the status |
 * |                                   |        | is the plugin's: 402, 403, 429 or 503                 |
 * | `room_not_ready`                  | 428    | the user has no oracle room yet                       |
 * | `delegation_required`             | 428    | no usable delegation to this oracle (see below)       |
 * | `rate_limited`                    | 429    | too many requests for this user                       |
 * | `not_configured`                  | 503    | channels or binding validation are not configured     |
 * | `binding_check_unavailable`       | 503    | the Auth Hub binding check failed or answered badly   |
 * | `unavailable`                     | 503    | any other failure (the shell logs it)                 |
 */
export type ChannelErrorCode =
  | 'invalid_request'
  | 'invalid_cursor'
  | 'unauthorized'
  | 'expired'
  | 'provider_not_supported'
  | 'revision_mismatch'
  | 'control_not_supported'
  | 'scope_mismatch'
  | 'identity_mismatch'
  | 'identity_required'
  | 'binding_inactive'
  | 'channel_grant_not_tool_authority'
  | 'storage_unauthorized'
  | 'session_not_found'
  | 'request_conflict'
  | 'request_cancelled'
  | 'session_conflict'
  | 'room_not_encrypted'
  | 'room_unavailable'
  | 'response_expired'
  | 'request_too_large'
  | 'room_not_ready'
  | 'turn_refused'
  | 'delegation_required'
  | 'rate_limited'
  | 'not_configured'
  | 'binding_check_unavailable'
  | 'unavailable';

/**
 * What a `turn_refused` refusal carries besides `message`: the plugin's
 * `code` as `reason`, and the refusal's documented details (each omitted
 * when absent).
 */
export interface ChannelRefusalDetails {
  reason?: string;
  retryAfterSeconds?: number;
  action?: { label: string; url: string };
}

export type ChannelTurnOutcome =
  | { ok: true; result: ChannelTurnResponse }
  | ({
      ok: false;
      status: ChannelErrorStatus;
      code: ChannelErrorCode;
      message: string;
    } & ChannelRefusalDetails);

/**
 * A history read's answer across RPC: the page as JSON text with how many
 * items it holds and how many of them carry a Reply Plan (for the route's
 * metrics), or the refusal.
 */
export type ChannelHistoryOutcome =
  | { ok: true; json: string; items: number; plans: number }
  | Exclude<ChannelTurnOutcome, { ok: true }>;

export class ChannelError extends Error {
  constructor(
    readonly status: ChannelErrorStatus,
    message: string,
    readonly code: ChannelErrorCode,
    /** `turn_refused` only: the plugin's reason and details. */
    readonly refusal: ChannelRefusalDetails = {},
  ) {
    super(message);
    this.name = 'ChannelError';
  }
}

/** The failed outcome a `ChannelError` is answered with. */
export function channelErrorOutcome(
  error: ChannelError,
): Exclude<ChannelTurnOutcome, { ok: true }> {
  return {
    ok: false,
    status: error.status,
    code: error.code,
    message: error.message,
    ...channelRefusalFields(error.refusal),
  };
}

/**
 * The JSON body of a channel refusal: `{ code, message }`, plus `reason`,
 * `retryAfterSeconds` and `action` on a `turn_refused` that carries them.
 */
export function channelErrorBody(
  error: Pick<ChannelError, 'code' | 'message'> & ChannelRefusalDetails,
): { code: ChannelErrorCode; message: string } & ChannelRefusalDetails {
  return {
    code: error.code,
    message: error.message,
    ...channelRefusalFields(error),
  };
}

function channelRefusalFields(
  details: ChannelRefusalDetails,
): ChannelRefusalDetails {
  return {
    ...(details.reason !== undefined ? { reason: details.reason } : {}),
    ...(details.retryAfterSeconds !== undefined
      ? { retryAfterSeconds: details.retryAfterSeconds }
      : {}),
    ...(details.action
      ? { action: { label: details.action.label, url: details.action.url } }
      : {}),
  };
}

/** The statuses a `turn_refused` is answered with (the gate's own). */
const CHANNEL_TURN_REFUSAL_STATUSES = [402, 403, 429, 503] as const;

/**
 * The `turn_refused` error for a refusal of a plugin's `gateTurn`: its
 * status (402, 403, 429 or 503; anything else 403), its message, its `code`
 * as `reason`, its `retryAfterSeconds` and `action`.
 */
export function channelTurnRefusedError(refusal: TurnRefusal): ChannelError {
  const retryAfterSeconds = refusalRetryAfterSeconds(refusal);
  const action = refusalAction(refusal);
  return new ChannelError(
    CHANNEL_TURN_REFUSAL_STATUSES.find(
      (allowed) => allowed === refusal.status,
    ) ?? 403,
    refusal.message,
    'turn_refused',
    {
      ...(refusal.code ? { reason: refusal.code } : {}),
      ...(retryAfterSeconds !== undefined ? { retryAfterSeconds } : {}),
      ...(action ? { action: { label: action.label, url: action.url } } : {}),
    },
  );
}

/**
 * The session a channel request would run in does not exist in the user's
 * object (deleted in Qi.Space, or never created there). It answers like
 * `session_not_found` wherever it escapes, but admission handles it first:
 * the binding forgets the session and the request is answered with
 * `session_conflict` (or, when the request named no session, opens a new
 * one at once).
 */
export class StaleSessionError extends ChannelError {
  constructor(message = 'Oracle session not found') {
    super(404, message, 'session_not_found');
    this.name = 'StaleSessionError';
  }
}

/**
 * The run of one channel request: fixed by the binding and the request id,
 * so every retry, poll and object restart lands on the same run.
 */
export async function channelRunId(
  bindingId: string,
  requestId: string,
): Promise<string> {
  return `channel_${await channelRequestHash(JSON.stringify([bindingId, requestId]))}`;
}

/**
 * The least lifetime a delegation must have left for a channel turn to be
 * admitted (seconds): a turn, its tool calls and its owner-copy flush must
 * not outlive the delegation they run under.
 */
export const CHANNEL_DELEGATION_MIN_REMAINING_SECONDS = 900;

/** The user's delegation to this oracle as the user object holds it. */
export interface ChannelDelegation {
  raw?: string;
  /** Unix seconds: the delegation's effective expiry; absent = unknown. */
  expiration?: number;
}

export function delegationRequiredError(): ChannelError {
  return new ChannelError(
    428,
    'Delegation required: the user must authorize this oracle again',
    'delegation_required',
  );
}

/**
 * A channel turn runs under the user's stored delegation to this oracle,
 * like a Matrix turn. Without one, with an unknown expiry, or with less than
 * `CHANNEL_DELEGATION_MIN_REMAINING_SECONDS` left, there is no tool
 * authority to run under: the turn is refused with an explicit 428
 * `delegation_required` instead of running degraded (memory, files and the
 * sandbox would fail silently).
 */
export function requireChannelDelegation(
  delegation: ChannelDelegation | undefined,
  nowSeconds: number,
): void {
  if (
    !delegation?.raw ||
    typeof delegation.expiration !== 'number' ||
    !Number.isFinite(delegation.expiration) ||
    delegation.expiration <=
      nowSeconds + CHANNEL_DELEGATION_MIN_REMAINING_SECONDS
  )
    throw delegationRequiredError();
}

export async function channelRequestHash(raw: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(raw),
  );
  return Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, '0'),
  ).join('');
}

export async function readChannelBody(
  request: Request,
  maxBytes = 64_000,
): Promise<string> {
  const reader = request.body?.getReader();
  if (!reader)
    throw new ChannelError(
      400,
      'A channel turn is required',
      'invalid_request',
    );
  const chunks: Uint8Array[] = [];
  let size = 0;
  while (true) {
    const chunk = await reader.read();
    if (chunk.done) break;
    size += chunk.value.byteLength;
    if (size > maxBytes) {
      await reader.cancel();
      throw new ChannelError(
        413,
        'Channel request is too large',
        'request_too_large',
      );
    }
    chunks.push(chunk.value);
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(
      bytes,
    );
  } catch {
    throw new ChannelError(
      400,
      'Channel request must be UTF-8',
      'invalid_request',
    );
  }
}

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
import { RenderCapabilityWire } from '../delivery/rich';
import type { ReplyPlan } from '../delivery/types';

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
   * message, files, quote, notice or session; `sessionPolicy: 'continue'`;
   * the request id is `channelEventRequestId(event)`. Sent only to a runtime
   * whose turn results list `permission_event` in `features` (both kinds).
   */
  event: ChannelEvent.optional(),
  /**
   * What the gateway can show beyond text for this binding (reply buttons,
   * lists, link buttons, cards), and the link-button labels and link origins
   * it accepts. Sent only to a runtime whose turn results list
   * `rich_messages`, and only with a message (never with a notice or an
   * event). Absent: the reply is text only.
   */
  render: RenderCapabilityWire.optional(),
  /**
   * The person tapped a reply button or list row the oracle offered:
   * `message` is the option's title, `id` the tapped id. Checked against
   * the choices offered in this session; an unknown id reads as text.
   */
  choice: z.strictObject({ id: z.string().min(1).max(256) }).optional(),
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
      'render',
      'choice',
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
  for (const field of ['attachments', 'replyTo', 'render', 'choice'] as const)
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
 */
export const CHANNEL_TURN_FEATURES = [
  'delivery_notice',
  'permission_event',
  'rich_messages',
] as const;
export type ChannelTurnFeature = (typeof CHANNEL_TURN_FEATURES)[number];

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
 * | `unauthorized`                    | 401    | no valid user-rooted channel invocation               |
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
 * | `room_not_ready`                  | 428    | the user has no oracle room yet                       |
 * | `delegation_required`             | 428    | no usable delegation to this oracle (see below)       |
 * | `rate_limited`                    | 429    | too many requests for this user                       |
 * | `not_configured`                  | 503    | channels or binding validation are not configured     |
 * | `binding_check_unavailable`       | 503    | the Auth Hub binding check failed or answered badly   |
 * | `unavailable`                     | 503    | any other failure (the shell logs it)                 |
 */
export type ChannelErrorCode =
  | 'invalid_request'
  | 'unauthorized'
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
  | 'delegation_required'
  | 'rate_limited'
  | 'not_configured'
  | 'binding_check_unavailable'
  | 'unavailable';

export type ChannelTurnOutcome =
  | { ok: true; result: ChannelTurnResponse }
  | {
      ok: false;
      status: ChannelErrorStatus;
      code: ChannelErrorCode;
      message: string;
    };

export class ChannelError extends Error {
  constructor(
    readonly status: ChannelErrorStatus,
    message: string,
    readonly code: ChannelErrorCode,
  ) {
    super(message);
    this.name = 'ChannelError';
  }
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

export async function readChannelBody(request: Request): Promise<string> {
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
    if (size > 64_000) {
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

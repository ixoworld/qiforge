import { z } from 'zod';
import type { ReplyPlan } from '../delivery/types';

export const ChannelTurnBody = z.strictObject({
  provider: z.literal('whatsapp'),
  bindingId: z.string().regex(/^chb_[A-Za-z0-9_-]{1,120}$/),
  bindingRevision: z.number().int().positive().safe(),
  requestId: z.string().min(1).max(180),
  remoteMessageRef: z.string().regex(/^hmac:[a-f0-9]{64}$/),
  sessionId: z.string().min(1).max(255).optional(),
  message: z.string().min(1).max(16_000),
  context: z.strictObject({ kind: z.literal('companion') }),
});

export type ChannelTurnInput = z.infer<typeof ChannelTurnBody>;

export const ChannelOrigin = z.strictObject({
  v: z.literal(1),
  transport: z.literal('whatsapp'),
  binding_id: ChannelTurnBody.shape.bindingId,
  remote_ref: ChannelTurnBody.shape.remoteMessageRef,
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
  provider: 'whatsapp';
  bindingId: string;
  bindingRevision: number;
}

export interface ChannelTurnResponse {
  requestId: string;
  runId: string;
  sessionId: string;
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
  /**
   * A finished turn's Reply Plan: the parts to deliver in order (short
   * messages and artefact links). `text` stays the whole reply as one
   * message for gateways that predate plans.
   */
  plan?: ReplyPlan;
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
 * (authorize the oracle again, finish setting up the Companion room) and
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
 * | `session_not_found`               | 404    | the session is not the user's Companion session       |
 * | `request_conflict`                | 409    | the request id already belongs to another message     |
 * | `session_conflict`                | 409    | the channel is already bound to another session       |
 * | `room_not_encrypted`              | 409    | the Companion room is not end-to-end encrypted        |
 * | `response_expired`                | 410    | the run was pruned; the request cannot run again      |
 * | `request_too_large`               | 413    | the body is over 64 kB                                |
 * | `room_not_ready`                  | 428    | the user has no Companion room yet                    |
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
  | 'session_not_found'
  | 'request_conflict'
  | 'session_conflict'
  | 'room_not_encrypted'
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
    'Companion delegation required: the user must authorize this oracle again',
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

/**
 * `POST /messages/:sessionId/:messageId/feedback`, after authentication:
 * validate, rate-limit, screen, reserve with the user's object, deliver to
 * the sink, settle. The feedback text lives only in this request — it is
 * never logged, never stored in the user's database and never sent to the
 * user object.
 */
import type { TurnIdentity } from '../do/contracts';
import type { FeedbackConfig } from './config';
import {
  FeedbackSubmission,
  type FeedbackDelivery,
  type FeedbackReservation,
  type FeedbackResponse,
  type FeedbackSettlement,
  type FeedbackSink,
  type FeedbackTarget,
} from './contract';
import { LinearFeedbackError } from './linear-sink';
import { feedbackFingerprint, screenFeedbackText } from './privacy';

/** What the shell needs to serve the route; absent = the feature is off. */
export interface FeedbackShellOptions {
  config: FeedbackConfig;
  sink: FeedbackSink;
}

/** The user object's feedback RPCs (`UserOracleDO`). */
export interface FeedbackUserObject {
  reserveMessageFeedback(
    identity: TurnIdentity,
    target: FeedbackTarget,
  ): Promise<FeedbackReservation>;
  settleMessageFeedback(
    identity: TurnIdentity,
    target: FeedbackTarget,
    outcome: FeedbackSettlement,
  ): Promise<void>;
}

export interface FeedbackLog {
  info(message: string): void;
  warn(message: string): void;
}

export interface SubmitFeedbackInput {
  options: FeedbackShellOptions;
  user: FeedbackUserObject;
  identity: TurnIdentity;
  sessionId: string;
  messageId: string;
  /** The parsed JSON body, or undefined when it was not JSON. */
  body: unknown;
  /** `cf-connecting-ip`; only its keyed pseudonym is used. */
  clientIp: string | undefined;
  ipLimiter: RateLimit | undefined;
  log: FeedbackLog;
}

/** Machine-readable reasons, so clients branch without matching messages. */
export type FeedbackErrorCode =
  | 'FEEDBACK_DISABLED'
  | 'FEEDBACK_INVALID'
  | 'FEEDBACK_EMPTY'
  | 'FEEDBACK_TARGET_NOT_FOUND'
  | 'FEEDBACK_IN_FLIGHT'
  | 'FEEDBACK_ALREADY_SUBMITTED'
  | 'FEEDBACK_CONTAINS_PERSONAL_DATA'
  | 'FEEDBACK_RATE_LIMITED'
  | 'FEEDBACK_DELIVERY_FAILED';

export interface FeedbackErrorBody {
  statusCode: number;
  code: FeedbackErrorCode;
  message: string;
  retryable: boolean;
}

export type FeedbackHttpResult =
  | { status: 200; body: FeedbackResponse }
  | { status: 400 | 404 | 409 | 422 | 429 | 502; body: FeedbackErrorBody };

export function feedbackFailure(
  status: 400 | 404 | 409 | 422 | 429 | 502,
  code: FeedbackErrorCode,
  message: string,
  retryable = false,
): { status: typeof status; body: FeedbackErrorBody } {
  return { status, body: { statusCode: status, code, message, retryable } };
}

const RATE_LIMITED = 'Too many feedback attempts. Please try again later.';

function errorName(error: unknown): string {
  return error instanceof Error ? error.name : 'unknown error';
}

export async function submitFeedback(
  input: SubmitFeedbackInput,
): Promise<FeedbackHttpResult> {
  const { options, identity, sessionId, messageId, log } = input;
  const { config, sink } = options;
  const parsed = FeedbackSubmission.safeParse(input.body);
  if (!parsed.success)
    return feedbackFailure(
      400,
      'FEEDBACK_INVALID',
      'Invalid feedback submission',
    );
  const { submissionId, context } = parsed.data;

  if (input.ipLimiter) {
    const ipKey = await feedbackFingerprint(
      config.hmacSecret,
      'ip',
      input.clientIp ?? 'unknown',
    );
    if (!(await input.ipLimiter.limit({ key: `feedback:${ipKey}` })).success)
      return feedbackFailure(429, 'FEEDBACK_RATE_LIMITED', RATE_LIMITED, true);
  }

  const screened = screenFeedbackText(parsed.data.feedback);
  if (!screened.ok)
    return screened.reason === 'empty'
      ? feedbackFailure(400, 'FEEDBACK_EMPTY', 'Feedback cannot be empty')
      : feedbackFailure(
          422,
          'FEEDBACK_CONTAINS_PERSONAL_DATA',
          'Remove personal information, account identifiers, or secrets before submitting feedback',
        );

  const target: FeedbackTarget = { sessionId, messageId, submissionId };
  const reservation = await input.user.reserveMessageFeedback(identity, target);
  const submitted = (submittedAt: string): FeedbackHttpResult => ({
    status: 200,
    body: { submissionId, status: 'submitted', submittedAt },
  });
  const alreadySubmitted = feedbackFailure(
    409,
    'FEEDBACK_ALREADY_SUBMITTED',
    'Feedback for this message was already submitted',
  );
  switch (reservation.kind) {
    case 'not_found':
      return feedbackFailure(
        404,
        'FEEDBACK_TARGET_NOT_FOUND',
        'Completed Agent message not found',
      );
    case 'rate_limited':
      return feedbackFailure(429, 'FEEDBACK_RATE_LIMITED', RATE_LIMITED, true);
    case 'in_flight':
      return feedbackFailure(
        409,
        'FEEDBACK_IN_FLIGHT',
        'This feedback is being delivered; retry shortly with the same submissionId',
        true,
      );
    case 'conflict':
      return alreadySubmitted;
    case 'delivered':
      return submitted(reservation.submittedAt);
    case 'reserved':
      break;
  }

  const { userDid } = identity;
  const [userPseudonym, sessionFingerprint, messageFingerprint] =
    await Promise.all([
      feedbackFingerprint(config.hmacSecret, 'user', userDid),
      feedbackFingerprint(config.hmacSecret, 'session', userDid, sessionId),
      feedbackFingerprint(
        config.hmacSecret,
        'message',
        userDid,
        sessionId,
        messageId,
      ),
    ]);
  let delivery: FeedbackDelivery;
  try {
    delivery = await sink.submit({
      submissionId,
      feedback: screened.text,
      submittedAt: reservation.submittedAt,
      userPseudonym,
      sessionFingerprint,
      messageFingerprint,
      agent: config.agent,
      context,
    });
  } catch (error) {
    // The sink's own errors carry a status and code only; anything else is
    // reduced to its class name so no upstream detail reaches the logs.
    log.warn(
      `[feedback] delivery failed: ${error instanceof LinearFeedbackError ? error.message : errorName(error)}`,
    );
    await input.user
      .settleMessageFeedback(identity, target, 'released')
      .catch((settleError: unknown) =>
        log.warn(
          `[feedback] could not release the reservation: ${errorName(settleError)}`,
        ),
      );
    return feedbackFailure(
      502,
      'FEEDBACK_DELIVERY_FAILED',
      'Feedback could not be delivered. Please try again.',
      true,
    );
  }

  // This reservation took over a stale one of another submission, and the
  // issue was already there: it is that submission's, and this text was not
  // sent. Answer like any other second feedback for the message.
  const superseded =
    reservation.replacesOtherSubmission && delivery === 'existing';
  // The issue exists either way; a settle that fails leaves a pending marker
  // that a retry reclaims once stale, and the sink finds the issue then.
  await input.user
    .settleMessageFeedback(
      identity,
      target,
      superseded ? 'superseded' : 'delivered',
    )
    .catch((settleError: unknown) =>
      log.warn(
        `[feedback] could not settle the reservation: ${errorName(settleError)}`,
      ),
    );
  if (superseded) {
    log.info('[feedback] an earlier submission already delivered the issue');
    return alreadySubmitted;
  }
  log.info('[feedback] issue delivered');
  return submitted(reservation.submittedAt);
}

/**
 * Splice the capability flag into a transcript response the user object
 * already serialised (`{"messages":...}` or a page), without re-parsing it.
 */
export function withFeedbackCapability(json: string, enabled: boolean): string {
  if (!enabled || !json.startsWith('{')) return json;
  const rest = json.slice(1).trimStart();
  return `{"capabilities":{"anonymousMessageFeedback":true}${rest.startsWith('}') ? '' : ','}${rest}`;
}

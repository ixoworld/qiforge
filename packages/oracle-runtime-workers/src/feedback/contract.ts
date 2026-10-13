/**
 * Anonymous Agent-response feedback: the wire contract of
 * `POST /messages/:sessionId/:messageId/feedback`, the issue handed to a
 * sink, and the user object's reservation outcomes.
 *
 * The request carries free text plus a small allowlisted context. Nothing
 * else a client sends is read, so no prompt, response, tool data, URL, user
 * agent or location can reach the sink through this route.
 */
import { z } from 'zod';

/**
 * The env prefix reserved for this feature (its Linear key and pseudonym
 * secret): `composeEnvSchema` refuses a plugin that declares a key under it.
 */
export const FEEDBACK_ENV_PREFIX = 'FEEDBACK_';

export const FEEDBACK_TEXT_MAX_CHARS = 2000;
/** Generous for 2000 characters of text plus the context; anything larger is not a feedback form. */
export const FEEDBACK_BODY_MAX_BYTES = 16 * 1024;

/** Language and optional region only (`en`, `en-GB`, `es-419`) — no variants or extensions. */
const LANGUAGE_REGION = /^[a-z]{2,3}(?:-(?:[A-Z]{2}|\d{3}))?$/;

/**
 * A BCP 47 tag reduced to its canonical form, accepted only as language plus
 * optional region. Variants and private-use subtags are free text a client
 * could fill with a name or a place, so they are refused.
 */
const Locale = z
  .string()
  .max(35)
  .transform((raw, ctx) => {
    let canonical: string | undefined;
    try {
      canonical = Intl.getCanonicalLocales(raw)[0];
    } catch {
      canonical = undefined;
    }
    if (canonical === undefined || !LANGUAGE_REGION.test(canonical)) {
      ctx.addIssue({
        code: 'custom',
        message: 'locale must be a language with an optional region',
      });
      return z.NEVER;
    }
    return canonical;
  });

/**
 * A release (`1.4.0`, `1.5.0-rc.2`, `1.4.0+4f2ea36`) or a commit (`4f2ea36`).
 * Pre-release labels are a fixed list so the field cannot carry free text.
 */
const PORTAL_BUILD =
  /^(?:\d+\.\d+\.\d+(?:-(?:alpha|beta|rc|next|canary)(?:\.\d+)*)?(?:\+[0-9a-f]{7,12})?|[0-9a-f]{7,40})$/;

export const FeedbackContext = z
  .object({
    surface: z.enum(['workspace', 'agentSidebar']),
    locale: Locale,
    theme: z.enum(['dark', 'light']),
    deviceClass: z.enum(['mobile', 'tablet', 'desktop']),
    viewportBucket: z.enum(['compact', 'medium', 'wide']),
    network: z.enum(['mainnet', 'testnet', 'devnet', 'unknown']),
    portalBuildVersion: z.string().max(40).regex(PORTAL_BUILD).optional(),
  })
  .strict();
export type FeedbackContext = z.output<typeof FeedbackContext>;

export const FeedbackSubmission = z
  .object({
    /** Client-generated idempotency key: a retry of one submission reuses it. */
    submissionId: z.uuidv4(),
    feedback: z.string().min(1).max(FEEDBACK_TEXT_MAX_CHARS),
    context: FeedbackContext,
  })
  .strict();
export type FeedbackSubmission = z.infer<typeof FeedbackSubmission>;

export interface FeedbackResponse {
  submissionId: string;
  status: 'submitted';
  submittedAt: string;
}

/** Everything a sink receives. Ids are keyed pseudonyms, never raw values. */
export interface FeedbackIssue {
  submissionId: string;
  /** The screened text — the only user-authored content. */
  feedback: string;
  submittedAt: string;
  userPseudonym: string;
  sessionFingerprint: string;
  /** Also the sink's idempotency marker: one issue per user message. */
  messageFingerprint: string;
  agent: {
    did: string;
    name: string;
    model: string;
    provider: string;
    runtimeBuildVersion: string;
  };
  context: FeedbackContext;
}

/**
 * `created`: this call made the issue. `existing`: an issue for the message
 * was already there, so this call sent nothing.
 */
export type FeedbackDelivery = 'created' | 'existing';

/**
 * Where feedback goes. The runtime ships a Linear sink; tests inject a fake.
 * `submit` must be idempotent per `messageFingerprint`, say whether it
 * created the issue, and throw when the outcome was not confirmed.
 */
export interface FeedbackSink {
  submit(issue: FeedbackIssue): Promise<FeedbackDelivery>;
}

/** How the shell settles a reservation (see `FeedbackMarkers.settle`). */
export type FeedbackSettlement = 'delivered' | 'superseded' | 'released';

/** The message a submission is about, as the shell names it to the user object. */
export interface FeedbackTarget {
  sessionId: string;
  messageId: string;
  submissionId: string;
}

/**
 * What the user object answers when the shell asks to submit feedback:
 * - `reserved`: deliver now, then settle the reservation.
 *   `replacesOtherSubmission` is true when it took over a stale reservation
 *   of a different submission, which may already have created the issue;
 * - `delivered`: this submission already went out — answer with it again;
 * - `in_flight`: this same submission is being delivered right now;
 * - `conflict`: different feedback for the message was delivered or is in flight;
 * - `not_found`: no such session or message, or not a completed Agent reply;
 * - `rate_limited`: the user's own submission limit.
 */
export type FeedbackReservation =
  | { kind: 'reserved'; submittedAt: string; replacesOtherSubmission: boolean }
  | { kind: 'delivered'; submittedAt: string }
  | { kind: 'in_flight' }
  | { kind: 'conflict' }
  | { kind: 'not_found' }
  | { kind: 'rate_limited' };

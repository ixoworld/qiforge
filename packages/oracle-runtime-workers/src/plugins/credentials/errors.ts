/**
 * Credentials plugin error contract.
 *
 * Every failure of a call to the Auth Hub, the Credentials worker or Self
 * becomes a {@link CredentialsServiceError} (the service, the HTTP status,
 * the service's own `error` code). Tools never throw it at the agent: they
 * answer `{ error, message, hint? }`: `error` is the code (for developers
 * and logs), `message` a plain sentence to the person (second person, ready
 * to send as it is) and `hint` what the agent should do next (never sent to
 * the person). The `message` carries no DID, code, service URL or stack; a
 * `hint` may name a reason code or a version for the agent, never for the
 * person.
 */

import { selfTimeSeconds, whenItEnds } from './times';

export type CredentialsService = 'hub' | 'credentials' | 'self';

/** A refused or failed call to one of the plugin's services. */
export class CredentialsServiceError extends Error {
  readonly service: CredentialsService;
  /** HTTP status; 0 when no answer arrived (timeout, network). */
  readonly status: number;
  /** The service's `error` code, or `timeout` / `unreachable` / `invalid_response`. */
  readonly code: string;
  /** Seconds the service asked to wait (`Retry-After`), when it said. */
  readonly retryAfterSeconds?: number;
  /** The parsed answer body, for codes that carry data (`link_active`). */
  readonly body?: Record<string, unknown>;

  constructor(params: {
    service: CredentialsService;
    status: number;
    code: string;
    retryAfterSeconds?: number;
    body?: Record<string, unknown>;
  }) {
    super(`${params.service} answered ${params.status} ${params.code}`);
    this.name = 'CredentialsServiceError';
    this.service = params.service;
    this.status = params.status;
    this.code = params.code;
    if (params.retryAfterSeconds !== undefined)
      this.retryAfterSeconds = params.retryAfterSeconds;
    if (params.body !== undefined) this.body = params.body;
  }
}

/** What a tool answers when it cannot do what was asked. */
export interface CredentialsRefusal {
  error: string;
  /** To the person, ready to send. */
  message: string;
  /** To the agent: what to do next. Never sent. */
  hint?: string;
}

/** One answer: the person's sentence and, when useful, the agent's next step. */
export interface Wording {
  message: string;
  hint?: string;
}

/**
 * Added to every hint that could suggest waiting: the oracle only ever
 * replies to a message, so it must never promise to write first.
 */
export const NO_LATER_MESSAGE =
  'Never say you will let them know or message them later; you can only reply when they write to you.';

export const MESSAGES = {
  whatsAppOnly: {
    message: "This isn't available in this chat yet.",
    hint: 'These tools work only in our WhatsApp chat; nothing was sent.',
  },
  notAvailable: {
    message: "This isn't available right now.",
    hint: 'The plugin is not fully configured for this oracle; nothing was sent.',
  },
  busy: {
    message:
      'The service is busy right now. Please try again in a few minutes.',
    hint: 'A service did not answer in time; try again later, not at once.',
  },
  ourSide: {
    message: 'Something went wrong on our side. Please try again later.',
  },
  notFound: {
    message: "I couldn't find that request. It may have ended.",
    hint: 'Use an id this person got from a tool in this chat.',
  },
  unknownCredential: {
    message: "I can't ask for that credential.",
    hint: "The Credentials catalog does not list that type for the issuer; don't retry.",
  },
  unknownClaim: {
    message: "I can't ask for one of those details.",
    hint: "One of the fields is not in the issuer's catalog entry for the type; ask for fewer.",
  },
  unnamedService: {
    message: "This service can't ask for permissions yet.",
    hint: "The oracle's entity has no name in IXO Names; an operator must set one.",
  },
  tooManyPending: {
    message:
      'You already have requests waiting. Please answer them, or wait until they end.',
  },
  rateLimited: {
    message: 'Too many requests right now. Please try again in a minute.',
  },
  blocked: {
    message: "You're not accepting requests from this service.",
    hint: 'The person blocked this oracle in their wallet; do not ask again.',
  },
  unknownPerson: {
    message: "I couldn't find your wallet.",
    hint: 'The person has no IXO wallet the Credentials worker knows.',
  },
  alreadyVerified: {
    message: 'You already have an identity credential.',
    hint: 'No identity check is needed; use credentials_check instead.',
  },
  noPermission: {
    message: 'I need your permission for this first.',
    hint: 'Ask for permission first with credentials_request_action_permission.',
  },
  permissionPending: {
    message: "You haven't answered the permission request yet.",
    hint: `Wait until they answer the card; do not ask again or poll. ${NO_LATER_MESSAGE}`,
  },
  inReview: {
    message:
      "Thanks, your identity check is sent. Someone from our support team will look at it. Please check back later. You can ask me anytime, and I'll check how it's going.",
    hint: `A person reviews it; nothing tells you when it is done and you cannot message them first. ${NO_LATER_MESSAGE} Do not send a new link. Read the status again only when they write.`,
  },
  permissionEnded: {
    message: 'Your permission for this has ended or was stopped.',
    hint: 'Ask for permission again only if they still want this.',
  },
  permissionOutdated: {
    message: 'I need your OK once more for this.',
    hint: 'What they allowed earlier no longer matches what this service needs now (the Hub marks it current: false), so it is not used. Ask again with credentials_request_permissions for the same items (one card; credentials_request_action sends it by itself); its message holds the link.',
  },
  stateUnknown: {
    message:
      "This permission is in a state this version doesn't know yet; update the runtime.",
    hint: "The Auth Hub reported a permission state this runtime doesn't recognise; no grants are used. An operator must update the runtime. Do not retry.",
  },
  declined: {
    message: 'You chose not to allow it.',
    hint: 'Respect it; ask again only if they bring it up.',
  },
  unknownAction: {
    message: "That isn't something I can ask for.",
  },
  hubUpdateNeeded: {
    message: "This isn't available yet; a service update is needed.",
    hint: 'The Auth Hub answered without the per-item card shape (it predates the one-card release, auth-hub feat/one-card-permissions); an operator must update the Hub. Do not retry.',
  },
  requestConflict: {
    message: "This request can't be set up any more. Ask again in the chat.",
    hint: 'The same request key was used for a different list of items; ask again in a new turn.',
  },
  noLongerAvailable: {
    message: "This request can't be set up any more. Ask again in the chat.",
    hint: 'Something in the request is no longer offered by the Hub; ask again in a new turn.',
  },
  duplicateItem: {
    message: "The same thing can't be asked for twice in one request.",
    hint: 'Two service-action items name the same action; send each action once.',
  },
  daysNotAllowed: {
    message: "That's longer than this permission can last.",
    hint: 'Ask for fewer days.',
  },
  notConfirmed: {
    message:
      "Something went wrong on our side, so this couldn't be sent. Please try again later.",
    hint: 'Self could not confirm the oracle (401); an operator should check its keys.',
  },
  untrustedCredential: {
    message: "I can't check that credential.",
    hint: 'This credential type is not in CREDENTIALS_TRUSTED_ISSUERS; nothing was sent.',
  },
  untrustedIssuer: {
    message: "I can't accept that issuer for this credential.",
    hint: 'Only the configured issuers of the type are accepted; leave issuers out to use them.',
  },
} as const satisfies Record<string, Wording>;

/** A refusal from a wording. */
export function refusal(error: string, wording: Wording): CredentialsRefusal {
  return {
    error,
    message: wording.message,
    ...(wording.hint ? { hint: wording.hint } : {}),
  };
}

const LOG_NAME = /^[A-Za-z][A-Za-z0-9_]{0,63}$/;
const LOG_CODE = /^[a-z0-9_]{1,64}$/;

/**
 * An error for a log line: its class name and the constant codes it carries
 * (`code`, `source`, `reason`: the Credentials kit's and ours), and the same
 * for its `cause`. Never a message, a URL, a DID or a token: only names and
 * codes in a fixed shape are kept.
 */
export function describeError(error: unknown): string {
  const one = (e: unknown): string => {
    if (!(e instanceof Error)) return typeof e;
    const name = LOG_NAME.test(e.name) ? e.name : 'Error';
    const fields: string[] = [];
    for (const key of ['code', 'source', 'reason']) {
      const value: unknown = Reflect.get(e, key);
      if (typeof value === 'string' && LOG_CODE.test(value))
        fields.push(`${key}=${value}`);
    }
    return fields.length ? `${name} ${fields.join(' ')}` : name;
  };
  const cause = error instanceof Error ? error.cause : undefined;
  return cause === undefined
    ? one(error)
    : `${one(error)} (cause ${one(cause)})`;
}

/** The sentence for an identity check Self says is in progress (409 `link_active`). */
export function checkInProgress(ends: string | null): string {
  return ends
    ? `Your identity check is already in progress; it ends ${ends}. Please carry on with it.`
    : 'Your identity check is already in progress. Please carry on with it.';
}

/**
 * Whether Self says a link's check waits for a person to review it: only
 * `review: true` beside `status: "in_progress"`. Absent, any other value or
 * any other status: not in review (an older Self never sends the field).
 */
export function isInReview(answer: unknown): boolean {
  return (
    typeof answer === 'object' &&
    answer !== null &&
    Reflect.get(answer, 'status') === 'in_progress' &&
    Reflect.get(answer, 'review') === true
  );
}

/**
 * `400 invalid_item`: the Hub names the item's position (`details.index`, from
 * 0) and a reason for developers. The person is told the item's place in
 * plain words; the reason goes to the agent's hint only.
 */
function invalidItem(error: CredentialsServiceError): CredentialsRefusal {
  const details = error.body?.details;
  const raw =
    details && typeof details === 'object'
      ? (details as Record<string, unknown>).index
      : undefined;
  const index = typeof raw === 'number' ? raw : Number.NaN;
  const reason =
    details && typeof details === 'object'
      ? (details as Record<string, unknown>).reason
      : undefined;
  const position = Number.isInteger(index) && index >= 0 ? index + 1 : null;
  return {
    error: 'invalid_item',
    message:
      position === null
        ? "One of the items in this request isn't something we can set up."
        : `Item ${position} of this request isn't something we can set up.`,
    hint: `Fix or drop ${position === null ? 'that item' : `item ${position}`} and ask again${typeof reason === 'string' && /^[a-z0-9_ .:-]{1,80}$/i.test(reason) ? ` (Hub reason: ${reason})` : ''}; nothing was sent.`,
  };
}

/**
 * The refusal a tool answers for `error`. Anything that is not a
 * {@link CredentialsServiceError} is a fault on our side; it is logged by the
 * caller, never shown.
 */
export function refusalFor(
  error: unknown,
  opts: { timeZone?: string; nowMs?: number } = {},
): CredentialsRefusal {
  if (!(error instanceof CredentialsServiceError))
    return refusal('internal_error', MESSAGES.ourSide);
  const { code, status, service } = error;
  if (code === 'hub_update_needed')
    return refusal(code, MESSAGES.hubUpdateNeeded);
  if (status === 0 || status >= 500) return refusal(code, MESSAGES.busy);
  switch (code) {
    case 'unknown_credential':
      return refusal(code, MESSAGES.unknownCredential);
    case 'unknown_claim':
      return refusal(code, MESSAGES.unknownClaim);
    case 'unnamed_service':
      return refusal(code, MESSAGES.unnamedService);
    case 'unknown_action':
      return refusal(code, MESSAGES.unknownAction);
    case 'invalid_item':
      return invalidItem(error);
    case 'request_conflict':
      return refusal(code, MESSAGES.requestConflict);
    case 'no_longer_available':
      return refusal(code, MESSAGES.noLongerAvailable);
    case 'days_not_allowed':
      return refusal(code, MESSAGES.daysNotAllowed);
    case 'too_many_pending':
      return refusal(code, MESSAGES.tooManyPending);
    case 'rate_limited':
      return refusal(code, MESSAGES.rateLimited);
    case 'blocked':
      return refusal(code, MESSAGES.blocked);
    case 'unknown_subject':
      return refusal(code, MESSAGES.unknownPerson);
    case 'already_verified':
      return refusal(code, MESSAGES.alreadyVerified);
    case 'link_active': {
      // A check waiting for a person's review has its own words.
      if (isInReview(error.body)) return refusal(code, MESSAGES.inReview);
      // Self names the open link's end beside its error (ISO 8601 text).
      const ends = selfTimeSeconds(error.body?.expiresAt);
      return {
        error: code,
        message: checkInProgress(
          ends === null
            ? null
            : whenItEnds(ends, {
                ...(opts.timeZone ? { timeZone: opts.timeZone } : {}),
                nowMs: opts.nowMs ?? Date.now(),
              }),
        ),
        hint: `Its link cannot be sent again. ${NO_LATER_MESSAGE}`,
      };
    }
    case 'offer_consent_invalid':
      // Self could not confirm the offer delegation on the card.
      return refusal(code, MESSAGES.permissionEnded);
    case 'not_found':
      return refusal(code, MESSAGES.notFound);
    default:
      break;
  }
  if (status === 429) return refusal(code, MESSAGES.rateLimited);
  // Self: 401 = the caller could not be confirmed; 403 = the delegation
  // does not allow it (ended, revoked).
  if (service === 'self' && status === 401)
    return refusal(code, MESSAGES.notConfirmed);
  if (service === 'self' && status === 403)
    return refusal(code, MESSAGES.permissionEnded);
  if (status === 404) return refusal(code, MESSAGES.notFound);
  return refusal(code, MESSAGES.ourSide);
}

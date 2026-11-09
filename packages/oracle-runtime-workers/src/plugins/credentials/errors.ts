/**
 * Credentials plugin error contract.
 *
 * Every failure of a call to the Auth Hub, the Credentials worker or Self
 * becomes a {@link CredentialsServiceError} (the service, the HTTP status,
 * the service's own `error` code). Tools never throw it at the agent: they
 * answer `{ error, message, hint? }`: `error` is the code (for developers
 * and logs), `message` a plain sentence to the person (second person, ready
 * to send as it is) and `hint` what the agent should do next (never sent).
 * Neither carries a DID, a code, a service URL or a stack.
 */

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
    hint: 'Wait until they answer the card; do not ask again or poll.',
  },
  permissionEnded: {
    message: 'Your permission for this has ended or was stopped.',
    hint: 'Ask for permission again only if they still want this.',
  },
  declined: {
    message: 'You chose not to allow it.',
    hint: 'Respect it; ask again only if they bring it up.',
  },
  unknownAction: {
    message: "That isn't something I can ask for.",
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

/** A short, local time for a moment the person reads ("14:05"), in their zone when known. */
export function shortTime(unixSeconds: number, timeZone?: string): string {
  const date = new Date(unixSeconds * 1000);
  try {
    return new Intl.DateTimeFormat('en-GB', {
      hour: '2-digit',
      minute: '2-digit',
      ...(timeZone ? { timeZone } : { timeZone: 'UTC', timeZoneName: 'short' }),
    }).format(date);
  } catch {
    // An unknown zone name: UTC, said so.
    return new Intl.DateTimeFormat('en-GB', {
      hour: '2-digit',
      minute: '2-digit',
      timeZone: 'UTC',
      timeZoneName: 'short',
    }).format(date);
  }
}

/**
 * The refusal a tool answers for `error`. Anything that is not a
 * {@link CredentialsServiceError} is a fault on our side; it is logged by the
 * caller, never shown.
 */
export function refusalFor(
  error: unknown,
  opts: { timeZone?: string } = {},
): CredentialsRefusal {
  if (!(error instanceof CredentialsServiceError))
    return refusal('internal_error', MESSAGES.ourSide);
  const { code, status, service } = error;
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
      const ends = Number(error.body?.expiresAt);
      return {
        error: code,
        message: Number.isFinite(ends)
          ? `Your identity check is already in progress; it ends at ${shortTime(ends, opts.timeZone)}.`
          : 'Your identity check is already in progress.',
      };
    }
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

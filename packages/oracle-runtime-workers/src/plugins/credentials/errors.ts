/**
 * Credentials plugin error contract.
 *
 * Every failure of a call to the Auth Hub, the Credentials worker or Self
 * becomes a {@link CredentialsServiceError} (the service, the HTTP status,
 * the service's own `error` code). Tools never throw it at the agent: they
 * answer the house shape `{ error, message }`, where `error` is the code
 * (for developers and logs) and `message` a plain sentence the agent can
 * pass on to the person. Messages never carry a DID, a code, a URL of a
 * service or a stack.
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
  message: string;
}

export const MESSAGES = {
  whatsAppOnly:
    'I can only ask for this in our WhatsApp chat for now, so nothing was sent.',
  notAvailable: "This isn't available right now, so nothing was sent.",
  busy: 'The service is busy right now. Please try again in a few minutes.',
  ourSide:
    "Something went wrong on our side, so I couldn't do this. Please try again later.",
  notFound: "I couldn't find that request. It may have ended.",
  unknownCredential:
    "I can't ask for that credential: it isn't one I can check.",
  unknownClaim: "I can't ask for one of those details for that credential.",
  unnamedService:
    'This service needs a public name before it can ask for permissions.',
  tooManyPending:
    'There are already requests waiting for this person. Please wait until they answer or those requests end.',
  rateLimited: 'Too many requests right now. Please try again in a minute.',
  blocked: "This person isn't accepting requests from this service.",
  unknownPerson: "I couldn't find this person's wallet.",
  alreadyVerified: 'They already have an identity credential.',
  noPermission:
    "I don't have their permission for this yet. Ask for permission first.",
  permissionPending:
    "They haven't answered the permission request yet. Please check again after they open the link.",
  permissionEnded:
    'The permission for this has ended or was stopped. Ask for permission again.',
  unknownAction: "That isn't an action I can request.",
  daysNotAllowed:
    "That's longer than this permission can last. Ask for fewer days.",
  notConfirmed:
    "I couldn't confirm who is asking, so nothing was sent. Please try again later.",
} as const;

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
    return { error: 'internal_error', message: MESSAGES.ourSide };
  const { code, status, service } = error;
  if (status === 0 || status >= 500)
    return { error: code, message: MESSAGES.busy };
  switch (code) {
    case 'unknown_credential':
      return { error: code, message: MESSAGES.unknownCredential };
    case 'unknown_claim':
      return { error: code, message: MESSAGES.unknownClaim };
    case 'unnamed_service':
      return { error: code, message: MESSAGES.unnamedService };
    case 'unknown_action':
      return { error: code, message: MESSAGES.unknownAction };
    case 'days_not_allowed':
      return { error: code, message: MESSAGES.daysNotAllowed };
    case 'too_many_pending':
      return { error: code, message: MESSAGES.tooManyPending };
    case 'rate_limited':
      return { error: code, message: MESSAGES.rateLimited };
    case 'blocked':
      return { error: code, message: MESSAGES.blocked };
    case 'unknown_subject':
      return { error: code, message: MESSAGES.unknownPerson };
    case 'already_verified':
      return { error: code, message: MESSAGES.alreadyVerified };
    case 'link_active': {
      const ends = Number(error.body?.expiresAt);
      return {
        error: code,
        message: Number.isFinite(ends)
          ? `A link is already open; it ends at ${shortTime(ends, opts.timeZone)}.`
          : 'A link is already open for them.',
      };
    }
    case 'not_found':
      return { error: code, message: MESSAGES.notFound };
    default:
      break;
  }
  if (status === 429) return { error: code, message: MESSAGES.rateLimited };
  // Self: 401 = the caller could not be confirmed; 403 = the delegation
  // does not allow it (ended, revoked).
  if (service === 'self' && status === 401)
    return { error: code, message: MESSAGES.notConfirmed };
  if (service === 'self' && status === 403)
    return { error: code, message: MESSAGES.permissionEnded };
  if (status === 404) return { error: code, message: MESSAGES.notFound };
  return { error: code, message: MESSAGES.ourSide };
}

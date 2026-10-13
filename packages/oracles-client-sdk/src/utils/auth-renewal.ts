/**
 * Credential renewal after the oracle refused a request for its
 * credentials, in two stages:
 *
 *   1. a fresh invocation (the cached one expired or was refused);
 *   2. a fresh delegation, then a fresh invocation — what refuses a fresh
 *      invocation is the delegation behind it (expired, revoked, or failing
 *      the runtime's checks). Minting a delegation needs the user's key (a
 *      PIN or passkey on the Portal), so it is the last resort.
 *
 * A caller runs: request → refused? → stage 1 → repeat → refused? → stage 2
 * → repeat → refused? → give up. Stage 2 runs only after the repeat that
 * followed stage 1 was refused as well, never on a first refusal.
 *
 * Repeating a refused request is safe: the Workers runtime authenticates in
 * its HTTP shell before a request reaches the user's object, so a request
 * refused for its credentials was never processed. The 403s the user's
 * object itself answers with (a cold boot that could not load the owner
 * copy) are refused before anything is written as well.
 */

export type AuthRenewalStage = 1 | 2;

/**
 * Renew the credentials before the next attempt. Resolving `false` means
 * nothing new could be minted: repeating the request would send the refused
 * credentials again, so the caller gives up instead.
 */
export type RenewAuth = (
  stage: AuthRenewalStage,
) => Promise<boolean | void> | boolean | void;

/** The credentials a refused request carried (`null`: none was sent). */
export interface RefusedCredentials {
  delegation?: string | null;
  invocation?: string | null;
}

/**
 * Runtime error codes that come with a 403 but name a cause new user
 * credentials cannot fix (`VFS_AUTH_FAILED`: the VFS refused the oracle's
 * own credentials).
 */
const NON_CREDENTIAL_403_CODES: ReadonlySet<string> = new Set([
  'VFS_AUTH_FAILED',
]);

/** A refusal (401/403) that new user credentials may get through. */
export function isCredentialRefusal(
  status: number | undefined,
  code?: unknown,
): boolean {
  if (status === 401) return true;
  if (status !== 403) return false;
  return !(typeof code === 'string' && NON_CREDENTIAL_403_CODES.has(code));
}

/** `isCredentialRefusal` for a fetch response; the body is left unread. */
export async function isCredentialRefusalResponse(
  response: Response,
): Promise<boolean> {
  if (response.status === 401) return true;
  if (response.status !== 403) return false;
  const body: unknown = await response
    .clone()
    .json()
    .catch(() => null);
  const code =
    typeof body === 'object' && body !== null && 'code' in body
      ? body.code
      : undefined;
  return isCredentialRefusal(403, code);
}

/**
 * The socket CONNECT refusals of the runtime (`Unauthorized: <reason>`) that
 * new credentials may get through. A failed session check, a failed auth
 * check (the check itself threw) and a token of another user are refused
 * with the same prefix, but renewing cannot fix them.
 */
const NON_CREDENTIAL_SOCKET_REFUSALS: readonly string[] = [
  'Unauthorized: session check failed',
  'Unauthorized: auth check failed',
  'Unauthorized: token does not belong to the routed user',
];

export function isCredentialRefusalMessage(message: string): boolean {
  return (
    message.startsWith('Unauthorized: ') &&
    !NON_CREDENTIAL_SOCKET_REFUSALS.includes(message)
  );
}

const STAGES: readonly AuthRenewalStage[] = [1, 2];

/**
 * Run `attempt`, renewing the credentials and repeating it once per stage
 * while `isRefused` says it was refused for them. Returns the last outcome
 * and whether it was refused; an outcome that is repeated is handed to
 * `discard` first (to release a response body). Without `renew`, after the
 * user's abort, or when a stage could not renew (`false`, or it threw), the
 * refused outcome is returned as it is.
 */
export async function withAuthRenewal<T>(options: {
  attempt: () => Promise<T>;
  isRefused: (outcome: T) => boolean | Promise<boolean>;
  renew?: RenewAuth;
  signal?: AbortSignal;
  discard?: (outcome: T) => void;
}): Promise<{ outcome: T; refused: boolean }> {
  const { attempt, isRefused, renew, signal, discard } = options;
  let outcome = await attempt();
  for (const stage of STAGES) {
    if (!(await isRefused(outcome))) return { outcome, refused: false };
    if (!renew || signal?.aborted) return { outcome, refused: true };
    let renewed: boolean | void;
    try {
      renewed = await renew(stage);
    } catch (error) {
      // eslint-disable-next-line no-console
      console.warn(
        `[oracles-client-sdk] credential renewal (stage ${stage}) failed:`,
        error,
      );
      return { outcome, refused: true };
    }
    if (renewed === false || signal?.aborted) return { outcome, refused: true };
    discard?.(outcome);
    outcome = await attempt();
  }
  return { outcome, refused: await isRefused(outcome) };
}

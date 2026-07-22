import type { RuntimeContext } from '../plugin-api/types.js';
import { UcanMintUnavailableError } from '../plugin-api/ucan-errors.js';

/**
 * Shared, non-throwing UCAN failure handling for plugin auth helpers
 * (composio / memory / skills, and any future minting plugin).
 *
 * Every plugin that mints a service-targeted invocation runs the same two
 * risky steps:
 *
 *   1. `runCtx.ucan.resolveServiceDid(url)` — a did:web lookup that can throw
 *      on network/DNS failure or return `null` when the document is missing.
 *   2. `runCtx.ucan.mintInvocation(...)` — which the runtime adapter throws
 *      from when the underlying service returns `null` (no signing key, no
 *      cached delegation, or an internal mint/sign failure).
 *
 * The plugin contract is safe degradation: the capability is simply absent for
 * the turn and the agent keeps running. These helpers make sure a failure
 * never escapes the plugin boundary, and that the log line distinguishes the
 * EXPECTED "this user just hasn't delegated to us" case (info/debug) from a
 * genuine ERROR ("a delegation exists but mint/resolve blew up", warn).
 */

/** Why `mintInvocation` failed to produce a usable invocation. */
type MintFailureKind =
  | 'no-signing-key' // oracle has no Ed25519 key — UCAN minting is disabled
  | 'no-delegation' // expected: this user has not delegated to the oracle
  | 'error'; // unexpected throw — delegation likely present but minting failed

/**
 * Classify a thrown value from `mintInvocation` into expected vs. error. The
 * adapter (`bootstrap/ambient-factory.ts`) throws a typed
 * `UcanMintUnavailableError` for the EXPECTED cases (no signing key / no cached
 * delegation); anything else is an unexpected failure. We refine the expected
 * case into `no-signing-key` vs `no-delegation` purely for the log message.
 */
function classifyMintError(
  runCtx: RuntimeContext,
  error: unknown,
): MintFailureKind {
  if (!(error instanceof UcanMintUnavailableError)) return 'error';
  return runCtx.ucan.hasSigningKey() ? 'no-delegation' : 'no-signing-key';
}

/** Human-readable detail string for an unknown thrown value. */
function describe(error: unknown): string {
  return error instanceof Error
    ? `${error.name}: ${error.message}`
    : String(error);
}

/**
 * Log an expected (non-error) UCAN degradation. Prefers the optional `debug`
 * channel; falls back to `log` when the logger doesn't expose `debug`, so the
 * line never lands on the `warn`/`error` channels reserved for real failures.
 */
function logExpected(runCtx: RuntimeContext, message: string): void {
  if (runCtx.logger.debug) {
    runCtx.logger.debug(message);
  } else {
    runCtx.logger.log(message);
  }
}

/**
 * Resolve a service DID without throwing. Returns `null` on a missing document
 * (expected) or on a resolution error (logged at `warn`). The boolean-less
 * `null` return keeps the existing caller contract intact.
 */
export async function resolveServiceDidSafely(
  runCtx: RuntimeContext,
  serviceUrl: string,
  plugin: string,
): Promise<string | null> {
  try {
    const did = await runCtx.ucan.resolveServiceDid(serviceUrl);
    if (!did) {
      logExpected(
        runCtx,
        `[${plugin}] UCAN unavailable: service DID could not be resolved for ${serviceUrl} (no document / no id). Degrading without auth.`,
      );
      return null;
    }
    return did;
  } catch (error) {
    runCtx.logger.warn(
      `[${plugin}] UCAN error: resolving service DID for ${serviceUrl} threw — ${describe(error)}. Degrading without auth.`,
    );
    return null;
  }
}

/**
 * Mint an invocation without throwing. Returns the token on success, or `null`
 * on any failure — logging the EXPECTED cases (no signing key / no delegation)
 * at `debug` and genuine errors (delegation present, mint/sign failed) at
 * `warn` with the underlying message.
 */
export async function mintInvocationSafely(
  runCtx: RuntimeContext,
  target: { did: string; capability: string },
  plugin: string,
  opts?: { skipCache?: boolean; can?: string },
): Promise<string | null> {
  try {
    // Forward `opts` only when supplied so the no-opts call signature stays
    // `mintInvocation(target)` — passing an explicit `undefined` second arg
    // would be a needless behavioural change for callers that don't opt out
    // of caching (memory / skills).
    const invocation = opts
      ? await runCtx.ucan.mintInvocation(target, opts)
      : await runCtx.ucan.mintInvocation(target);
    return invocation && invocation.length > 0 ? invocation : null;
  } catch (error) {
    const kind = classifyMintError(runCtx, error);
    if (kind === 'error') {
      runCtx.logger.warn(
        `[${plugin}] UCAN error: minting '${target.capability}' invocation failed — ${describe(error)}. Degrading without auth.`,
      );
    } else {
      const reason =
        kind === 'no-signing-key'
          ? 'oracle has no signing key'
          : 'no delegation present for this user';
      logExpected(
        runCtx,
        `[${plugin}] UCAN unavailable: ${reason} — skipping '${target.capability}' invocation. Degrading without auth.`,
      );
    }
    return null;
  }
}

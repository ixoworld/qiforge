import { LangChainTracer } from '@langchain/core/tracers/tracer_langchain';

/**
 * Per-request LangSmith tracing decision.
 *
 * Two mutually exclusive modes (enforced at boot by
 * `validateLangsmithTracing` in `config/base-env-schema.ts`):
 *
 *  - **Global** — `LANGSMITH_TRACING=true`: LangChain auto-attaches its own
 *    tracer to every run; this module contributes only the per-request
 *    `metadata` (user DID, ingress client, prepare/build timings) so traces
 *    are filterable per user in the LangSmith UI.
 *  - **Selective** — `LANGSMITH_TRACED_DIDS` allowlist: the global switch
 *    stays off and this module attaches an explicit `LangChainTracer`
 *    callback ONLY for turns whose (UCAN-authenticated) user DID is in the
 *    allowlist. An explicitly passed tracer uploads regardless of the
 *    `LANGSMITH_TRACING` flag — the env flag only controls LangChain's
 *    automatic attachment — which is what makes per-DID tracing possible.
 *
 * Fail-closed: no API key, no allowlist match, or no configuration at all
 * ⇒ no tracer is attached and nothing leaves the process. The tracer's
 * client is LangChain's process-wide singleton (constructed from
 * `LANGSMITH_API_KEY` / `LANGSMITH_ENDPOINT`), so per-request tracer
 * instances are cheap and share one batched upload queue.
 */

export interface LangsmithTracingEnv {
  /** Raw `LANGSMITH_TRACING`. `'true'` (LangChain's exact check) = global mode. */
  tracing?: string;
  /** Raw `LANGSMITH_API_KEY`. Selective mode refuses to attach without it. */
  apiKey?: string;
  /** Raw `LANGSMITH_PROJECT`. Forwarded to the tracer when set. */
  project?: string;
  /** Raw `LANGSMITH_TRACED_DIDS` comma-separated allowlist (`*` = everyone). */
  tracedDids?: string;
}

export interface ResolveLangsmithTracingArgs {
  /** The turn's user DID — from the authenticated payload, never client-set metadata. */
  userDid: string;
  /** Ingress surface, so latency can be sliced per client in LangSmith. */
  client: 'portal' | 'matrix' | 'slack';
  env: LangsmithTracingEnv;
  /**
   * Pre-graph wall-clock costs. The LangSmith trace only starts when the
   * graph run starts, so slow-first-turn causes (home-server lookup,
   * Matrix→SQLite sync, blocking first-contact userContext fetch) would be
   * invisible without carrying them onto the trace as metadata.
   */
  timings?: {
    prepareDurationMs?: number;
    agentBuildDurationMs?: number;
  };
}

export interface LangsmithTracingDecision {
  /**
   * Attached to the run config unconditionally — LangGraph forwards it to
   * whichever tracer ends up handling the run (global or selective), and it
   * is inert when no tracer is active.
   */
  metadata: Record<string, string | number>;
  /** Present only when this turn should be selectively traced. */
  callbacks?: [LangChainTracer];
}

/**
 * Single-slot memo for the parsed allowlist. The raw env string is stable
 * for the lifetime of a deployment, so this makes the per-request cost one
 * string identity check; if the value ever does change (tests, config
 * reload), the changed raw string repopulates the Set automatically.
 */
let memoRaw: string | undefined;
let memoSet: ReadonlySet<string> = new Set();

function parseTracedDids(raw: string | undefined): ReadonlySet<string> {
  if (raw === memoRaw) return memoSet;
  memoRaw = raw;
  memoSet = new Set(
    (raw ?? '')
      .split(',')
      .map((entry) => entry.trim())
      .filter((entry) => entry.length > 0),
  );
  return memoSet;
}

/**
 * Mirrors LangChain's own `isTracingEnabled` check (exact string `'true'`),
 * so "global mode is on" means the same thing here as it does inside the
 * callback manager that auto-attaches the env-driven tracer.
 */
function isGlobalTracingOn(tracing: string | undefined): boolean {
  return tracing?.trim() === 'true';
}

export function resolveLangsmithTracing(
  args: ResolveLangsmithTracingArgs,
): LangsmithTracingDecision {
  const { userDid, client, env, timings } = args;

  // `user_id` duplicates the DID under the key LangSmith examples use for
  // user-scoped filtering; `user_did` is the self-describing key our own
  // dashboards should standardize on.
  const metadata: Record<string, string | number> = {
    user_did: userDid,
    user_id: userDid,
    client,
    ...(timings?.prepareDurationMs !== undefined && {
      prepare_duration_ms: timings.prepareDurationMs,
    }),
    ...(timings?.agentBuildDurationMs !== undefined && {
      agent_build_duration_ms: timings.agentBuildDurationMs,
    }),
  };

  // Global mode: LangChain's callback manager attaches its own tracer for
  // every run — adding a second explicit one here would be redundant.
  if (isGlobalTracingOn(env.tracing)) {
    return { metadata };
  }

  // Selective mode. Fail-closed on a missing API key even though boot
  // validation already rejects that combination — this function must never
  // attach a tracer that cannot authenticate.
  if (!env.apiKey) {
    return { metadata };
  }

  const allowlist = parseTracedDids(env.tracedDids);
  const traced = allowlist.has('*') || allowlist.has(userDid);
  if (!traced) {
    return { metadata };
  }

  return {
    metadata,
    callbacks: [
      new LangChainTracer({
        ...(env.project && { projectName: env.project }),
      }),
    ],
  };
}

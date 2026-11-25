/**
 * Where a turn trace goes: IXO Traces, configured by the Worker env alone.
 *
 * - `TRACES_API_KEY`: the project's write key (`ixt_w_…`), sent as `x-api-key`.
 * - `TRACES` (service binding to the traces Worker) or `TRACES_ENDPOINT`
 *   (its base URL, `https://…`; plain `http://` only for a local host). With
 *   both, the binding is used: same request, no public hop.
 *
 * The tracer is on exactly when a key and a destination are configured, and
 * off otherwise. Which users it traces is `turnTracesUsersFromEnv`: by
 * default the users LangSmith traces (`LANGSMITH_TRACING` /
 * `LANGSMITH_TRACED_DIDS`), or `TRACES_TRACED_DIDS` when set
 * (`core/traced-users.ts`).
 */
import {
  describeTurnTracesUsers,
  turnTracesUsers,
  type LangsmithUserSelectionEnv,
  type TracedUsers,
} from '../core/traced-users';
import type { Logger } from '../plugin-api/types';

/** The part of a service binding the tracer uses. */
export interface TracesFetcher {
  fetch(input: Request | string, init?: RequestInit): Promise<Response>;
}

export interface TracesConfig {
  apiKey: string;
  /** Base URL without a trailing slash (`https://traces.example`). */
  baseUrl: string;
  /** The service binding, when the oracle has one. */
  binding?: TracesFetcher;
}

/** Base URL of requests sent through the binding (its host is not resolved). */
const BINDING_BASE_URL = 'https://traces.binding';

const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);

function isFetcher(value: unknown): value is TracesFetcher {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof Reflect.get(value, 'fetch') === 'function'
  );
}

let warnedEndpoint: string | undefined;

/** The endpoint's base URL, or undefined when it is not one the tracer sends to. */
function endpointBase(raw: string, logger: Logger): string | undefined {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    url = new URL('invalid:');
  }
  const ok =
    url.protocol === 'https:' ||
    (url.protocol === 'http:' && LOCAL_HOSTS.has(url.hostname));
  if (!ok || url.search || url.hash) {
    if (warnedEndpoint !== raw) {
      warnedEndpoint = raw;
      logger.warn(
        '[traces] TRACES_ENDPOINT is not an https:// base URL (http:// only for a local host); turn traces are off',
      );
    }
    return undefined;
  }
  return url.href.replace(/\/+$/, '');
}

/** The traces destination of this Worker env, or undefined when tracing is off. */
export function tracesConfigFromEnv(
  env: Record<string, unknown>,
  logger: Logger,
): TracesConfig | undefined {
  const apiKey = env.TRACES_API_KEY;
  if (typeof apiKey !== 'string' || apiKey.trim().length === 0)
    return undefined;
  const binding = env.TRACES;
  if (isFetcher(binding))
    return { apiKey: apiKey.trim(), baseUrl: BINDING_BASE_URL, binding };
  const endpoint = env.TRACES_ENDPOINT;
  if (typeof endpoint !== 'string' || endpoint.trim().length === 0)
    return undefined;
  const baseUrl = endpointBase(endpoint.trim(), logger);
  return baseUrl ? { apiKey: apiKey.trim(), baseUrl } : undefined;
}

/** Selections already logged in this isolate: one line each, at the first turn. */
const loggedSelections = new Set<string>();

/**
 * The users whose turns go to IXO Traces: `TRACES_TRACED_DIDS` when set
 * (`*` = everyone, else its DIDs), else the users LangSmith traces, else
 * (no LangSmith selection either) everyone. `langsmith` is the turn's
 * LangSmith env (`langsmithEnvFromWorkerEnv`), so both read the same values.
 *
 * Logs which mode is active once per isolate: the mode and the list size,
 * never a DID.
 */
export function turnTracesUsersFromEnv(
  env: Record<string, unknown>,
  langsmith: LangsmithUserSelectionEnv,
  logger: Logger,
): TracedUsers {
  const raw = env.TRACES_TRACED_DIDS;
  const override = typeof raw === 'string' && raw.length > 0 ? raw : undefined;
  const selection = turnTracesUsers(langsmith, override);
  const key = [langsmith.tracing, langsmith.tracedDids, override].join('\n');
  if (!loggedSelections.has(key)) {
    loggedSelections.add(key);
    logger.log(`[traces] turn traces: ${describeTurnTracesUsers(selection)}`);
  }
  return selection.users;
}

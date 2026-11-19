/**
 * The pre-turn gate: every plugin's `gateTurn`, asked before a turn of any
 * kind starts (see `TurnTrigger`), so a plugin can refuse it (402 "top up")
 * before a run is recorded, a message stored or mirrored, a file read or a
 * model called. The host builds the context and turns a refusal into the
 * entry's answer (an HTTP status, a Matrix notice, a channel refusal, a
 * skipped task run); this module owns the policy.
 *
 * - Gates run concurrently, so they never add up on the hot path; the answer
 *   is the first refusal in plugin order (deterministic whatever finishes
 *   first). Once it is known the later gates' signals are aborted and their
 *   answers ignored. Without a refusal, the most restrictive allowance wins:
 *   one gate answering `platformModels: 'deny'` restricts the turn to the
 *   person's own provider.
 * - A refusal's status is one of `REFUSAL_STATUSES` (402, 403, 429, 503);
 *   any other valid one is answered as 403 and logged.
 * - Each gate is bounded by its plugin's `turnGate.timeoutMs`. A gate that
 *   throws, times out or answers something invalid is a failure, which the
 *   plugin's `turnGate.onFailure` turns into "allow" (`open`, the default)
 *   or a `503 turn_gate_unavailable` refusal (`closed`).
 * - No plugin with a gate: nothing runs, nothing is built.
 */
import type { OraclePlugin } from '../plugin-api/oracle-plugin';
import type {
  PlatformModelsPolicy,
  TurnGateContext,
  TurnGatePolicy,
  TurnRefusal,
  TurnRefusalAction,
  TurnRefusalBody,
  TurnRefusalDetails,
} from '../plugin-api/turn-gate';

export const TURN_GATE_TIMEOUT_MS_DEFAULT = 1_000;
export const TURN_GATE_TIMEOUT_MS_MAX = 10_000;
const MAX_MESSAGE_CHARS = 2_000;
const MAX_DETAILS_BYTES = 4_096;
const CODE_RE = /^[a-z][a-z0-9_]{0,63}$/;

/**
 * The statuses a refusal is answered with: payment needed, not allowed,
 * too many, try again shortly. Every entry (HTTP, Matrix, task, channel)
 * can carry each of them.
 */
export const REFUSAL_STATUSES: readonly number[] = [402, 403, 429, 503];
/** What any other refusal status is answered as. */
const FALLBACK_REFUSAL_STATUS = 403;

/** The refusal a fail-closed gate's failure becomes. */
export const TURN_GATE_UNAVAILABLE: TurnRefusal = {
  status: 503,
  code: 'turn_gate_unavailable',
  message:
    'This request cannot be accepted right now. Please try again shortly.',
};

/** A refusal and the plugin it came from. */
export interface GateRefusal {
  plugin: string;
  refusal: TurnRefusal;
}

/** No refusal, but a gate restricted the turn to the person's own provider. */
export interface GateRestriction {
  platformModels: Extract<PlatformModelsPolicy, 'deny'>;
  /** The plugins that asked for it, in plugin order. */
  plugins: string[];
}

/**
 * What the gates decided: a refusal, a restriction, or null (the turn runs
 * with no restriction).
 */
export type TurnGateVerdict = GateRefusal | GateRestriction | null;

export function isGateRefusal(
  verdict: TurnGateVerdict,
): verdict is GateRefusal {
  return verdict !== null && 'refusal' in verdict;
}

/** The restriction a verdict puts on the turn's models (`allow` when none). */
export function platformModelsOf(
  verdict: TurnGateVerdict,
): PlatformModelsPolicy {
  return verdict !== null && 'platformModels' in verdict ? 'deny' : 'allow';
}

export interface RunTurnGatesOptions {
  /** One line per refusal and per failed gate. */
  log: (level: 'info' | 'warn', line: string) => void;
  /** For the log lines. */
  requestId: string;
  /** Aborts every gate (the request went away). */
  signal?: AbortSignal;
}

/** The plugins that gate turns, in plugin order. */
export function turnGatePlugins(
  plugins: readonly OraclePlugin[],
): OraclePlugin[] {
  return plugins.filter((plugin) => typeof plugin.gateTurn === 'function');
}

function timeoutOf(policy: TurnGatePolicy | undefined): number {
  const ms = policy?.timeoutMs;
  if (typeof ms !== 'number' || !Number.isFinite(ms) || ms <= 0)
    return TURN_GATE_TIMEOUT_MS_DEFAULT;
  return Math.min(Math.ceil(ms), TURN_GATE_TIMEOUT_MS_MAX);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** The longest `details.action.label`, in characters. */
export const MAX_ACTION_LABEL_CHARS = 40;
/** The longest `details.retryAfterSeconds` (one day). */
export const MAX_RETRY_AFTER_SECONDS = 86_400;

/**
 * The documented `details` fields checked: an invalid `action` or
 * `retryAfterSeconds` is removed (the refusal stands) and the reason noted
 * in `dropped`; a fractional `retryAfterSeconds` is rounded up.
 */
function checkedDocumentedDetails(
  details: Record<string, unknown>,
  dropped: string[],
): TurnRefusalDetails {
  const { action, retryAfterSeconds, ...rest } = details;
  const checked: TurnRefusalDetails = { ...rest };
  if (retryAfterSeconds !== undefined) {
    const seconds =
      typeof retryAfterSeconds === 'number' &&
      Number.isFinite(retryAfterSeconds)
        ? Math.ceil(retryAfterSeconds)
        : NaN;
    if (seconds >= 1 && seconds <= MAX_RETRY_AFTER_SECONDS)
      checked.retryAfterSeconds = seconds;
    else
      dropped.push(
        `details.retryAfterSeconds must be a number from 1 to ${MAX_RETRY_AFTER_SECONDS}`,
      );
  }
  if (action !== undefined) {
    const valid = checkedAction(action);
    if (typeof valid === 'string') dropped.push(`details.action ${valid}`);
    else checked.action = valid;
  }
  return checked;
}

/**
 * A `details.action` checked: the label trimmed, the URL as parsed
 * (normalised `href`), or why it is not usable.
 */
function checkedAction(action: unknown): TurnRefusalAction | string {
  if (!isRecord(action)) return 'must be an object';
  const { label, url } = action;
  if (
    typeof label !== 'string' ||
    label.trim().length === 0 ||
    label.trim().length > MAX_ACTION_LABEL_CHARS
  )
    return `label must be 1 to ${MAX_ACTION_LABEL_CHARS} characters`;
  if (typeof url !== 'string') return 'url must be a string';
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return 'url must be an absolute URL';
  }
  if (parsed.protocol !== 'https:') return 'url must be https';
  return { label: label.trim(), url: parsed.href };
}

/**
 * A checked copy of a plugin's refusal, or a reason it is not one. Invalid
 * documented `details` fields (`action`, `retryAfterSeconds`) do not
 * invalidate the refusal: they are removed and the reason is appended to
 * `dropped` (the caller logs it).
 */
export function validRefusal(
  value: unknown,
  dropped: string[] = [],
): TurnRefusal | string {
  if (!isRecord(value)) return 'refusal is not an object';
  const { status, message, code, details } = value;
  if (
    typeof status !== 'number' ||
    !Number.isInteger(status) ||
    status < 400 ||
    status > 599
  )
    return 'status must be an integer from 400 to 599';
  if (
    typeof message !== 'string' ||
    message.trim().length === 0 ||
    message.length > MAX_MESSAGE_CHARS
  )
    return `message must be 1 to ${MAX_MESSAGE_CHARS} characters`;
  if (code !== undefined && (typeof code !== 'string' || !CODE_RE.test(code)))
    return 'code must match [a-z][a-z0-9_]{0,63}';
  let checkedDetails: TurnRefusalDetails | undefined;
  if (details !== undefined) {
    if (!isRecord(details)) return 'details must be a JSON object';
    let json: string;
    try {
      json = JSON.stringify(details);
    } catch {
      return 'details must be JSON';
    }
    if (new TextEncoder().encode(json).byteLength > MAX_DETAILS_BYTES)
      return `details must be at most ${MAX_DETAILS_BYTES} bytes of JSON`;
    const parsed: unknown = JSON.parse(json);
    if (!isRecord(parsed)) return 'details must be a JSON object';
    checkedDetails = checkedDocumentedDetails(parsed, dropped);
  }
  return {
    status,
    message,
    ...(typeof code === 'string' ? { code } : {}),
    ...(checkedDetails ? { details: checkedDetails } : {}),
  };
}

type GateOutcome =
  | { kind: 'allow'; platformModels: PlatformModelsPolicy }
  | { kind: 'refuse'; refusal: TurnRefusal; dropped: string[] }
  | { kind: 'failed'; reason: string };

function outcomeOf(answer: unknown): GateOutcome {
  if (answer === undefined) return { kind: 'allow', platformModels: 'allow' };
  if (isRecord(answer) && answer.allow === true && !('refuse' in answer)) {
    const policy = answer.platformModels;
    if (policy === undefined || policy === 'allow' || policy === 'deny')
      return { kind: 'allow', platformModels: policy ?? 'allow' };
    return {
      kind: 'failed',
      reason: "platformModels must be 'allow' or 'deny'",
    };
  }
  if (isRecord(answer) && 'refuse' in answer && !('allow' in answer)) {
    const dropped: string[] = [];
    const checked = validRefusal(answer.refuse, dropped);
    return typeof checked === 'string'
      ? { kind: 'failed', reason: `invalid refusal: ${checked}` }
      : { kind: 'refuse', refusal: checked, dropped };
  }
  return { kind: 'failed', reason: 'answer is not a TurnGateResult' };
}

async function askGate(
  plugin: OraclePlugin,
  context: TurnGateContext,
  controller: AbortController,
): Promise<GateOutcome> {
  const timeoutMs = timeoutOf(plugin.turnGate);
  let timer: ReturnType<typeof setTimeout> | undefined;
  const limit = new Promise<GateOutcome>((resolve) => {
    timer = setTimeout(() => {
      controller.abort(new Error('turn gate timed out'));
      resolve({ kind: 'failed', reason: `timed out after ${timeoutMs} ms` });
    }, timeoutMs);
  });
  try {
    return await Promise.race([
      (async (): Promise<GateOutcome> => {
        try {
          return outcomeOf(
            await plugin.gateTurn?.({ ...context, signal: controller.signal }),
          );
        } catch (error) {
          return {
            kind: 'failed',
            reason: `threw: ${error instanceof Error ? error.message : String(error)}`,
          };
        }
      })(),
      limit,
    ]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Ask every gate (`gated`, from `turnGatePlugins`) about one turn. Resolves
 * with the first refusal in plugin order; else with a restriction when a
 * gate allowed the turn on the person's own provider only; else null.
 * Never rejects.
 */
export async function runTurnGates(
  gated: readonly OraclePlugin[],
  context: Omit<TurnGateContext, 'signal'>,
  options: RunTurnGatesOptions,
): Promise<TurnGateVerdict> {
  if (gated.length === 0) return null;
  const started = Date.now();
  const controllers = gated.map(() => new AbortController());
  const onAbort = (): void => {
    for (const controller of controllers)
      controller.abort(options.signal?.reason);
  };
  if (options.signal?.aborted) onAbort();
  options.signal?.addEventListener('abort', onAbort, { once: true });
  const asked = gated.map((plugin, index) =>
    askGate(
      plugin,
      { ...context, signal: controllers[index]!.signal },
      controllers[index]!,
    ),
  );
  const restrictedBy: string[] = [];
  try {
    for (let index = 0; index < gated.length; index += 1) {
      const plugin = gated[index]!;
      const outcome = await asked[index]!;
      let refusal: TurnRefusal | undefined;
      if (outcome.kind === 'refuse') {
        refusal = outcome.refusal;
        for (const note of outcome.dropped)
          options.log(
            'warn',
            `[turn-gate] ${JSON.stringify({
              plugin: plugin.name,
              trigger: context.trigger,
              requestId: options.requestId,
              dropped: note,
            })}`,
          );
        if (!REFUSAL_STATUSES.includes(refusal.status)) {
          options.log(
            'warn',
            `[turn-gate] ${JSON.stringify({
              plugin: plugin.name,
              trigger: context.trigger,
              requestId: options.requestId,
              status: refusal.status,
              answeredAs: FALLBACK_REFUSAL_STATUS,
            })}`,
          );
          refusal = { ...refusal, status: FALLBACK_REFUSAL_STATUS };
        }
      } else if (outcome.kind === 'allow') {
        if (outcome.platformModels === 'deny') restrictedBy.push(plugin.name);
      } else if (outcome.kind === 'failed') {
        const closed = plugin.turnGate?.onFailure === 'closed';
        options.log(
          'warn',
          `[turn-gate] ${JSON.stringify({
            plugin: plugin.name,
            trigger: context.trigger,
            requestId: options.requestId,
            failure: outcome.reason,
            policy: closed ? 'closed' : 'open',
          })}`,
        );
        if (closed) refusal = TURN_GATE_UNAVAILABLE;
      }
      if (!refusal) continue;
      options.log(
        'info',
        `[turn-gate] refused ${JSON.stringify({
          plugin: plugin.name,
          trigger: context.trigger,
          requestId: options.requestId,
          status: refusal.status,
          ...(refusal.code ? { code: refusal.code } : {}),
          ms: Date.now() - started,
        })}`,
      );
      // The answer is known: later gates stop.
      for (const controller of controllers.slice(index + 1))
        controller.abort(new Error('an earlier turn gate refused the turn'));
      return { plugin: plugin.name, refusal };
    }
    return restrictedBy.length > 0
      ? { platformModels: 'deny', plugins: restrictedBy }
      : null;
  } finally {
    options.signal?.removeEventListener('abort', onAbort);
  }
}

/** A refusal's call to action, when it carries a (checked) one. */
export function refusalAction(
  refusal: TurnRefusal,
): TurnRefusalAction | undefined {
  const action = refusal.details?.action;
  if (action === undefined) return undefined;
  const valid = checkedAction(action);
  return typeof valid === 'string' ? undefined : valid;
}

/** A refusal's "try again in about N seconds", when it carries a (checked) one. */
export function refusalRetryAfterSeconds(
  refusal: TurnRefusal,
): number | undefined {
  const seconds = refusal.details?.retryAfterSeconds;
  return typeof seconds === 'number' &&
    Number.isInteger(seconds) &&
    seconds >= 1 &&
    seconds <= MAX_RETRY_AFTER_SECONDS
    ? seconds
    : undefined;
}

/**
 * The HTTP answer for a refused Portal turn (streamed or not: no stream is
 * opened): the runtime's usual error body (`{ statusCode, message }`) plus
 * the refusal's `code` and `details`, the request id and the `refused: true`
 * marker (`TurnRefusalBody`: a gate's refusal, not an auth failure, so a
 * client does not renew credentials on a refused `403`); `Retry-After`
 * when the refusal carries `details.retryAfterSeconds`.
 */
export function turnRefusalResponse(
  refusal: TurnRefusal,
  requestId: string,
): Response {
  const retryAfter = refusalRetryAfterSeconds(refusal);
  const body: TurnRefusalBody = {
    statusCode: refusal.status,
    message: refusal.message,
    ...(refusal.code ? { code: refusal.code } : {}),
    ...(refusal.details ? { details: refusal.details } : {}),
    requestId,
    refused: true,
  };
  return Response.json(body, {
    status: refusal.status,
    headers: {
      'x-request-id': requestId,
      ...(retryAfter !== undefined
        ? { 'retry-after': String(retryAfter) }
        : {}),
    },
  });
}

/**
 * Wire contract of the frontend bridge: the channel over which a runtime asks
 * the user's browser to run a browser tool (`browser_tool_call` →
 * `tool_result`) or an AG-UI action (`action_call` → `action_call_result`).
 *
 * Shared by every runtime and by the clients that gate on it (the Portal
 * reads `FRONTEND_BRIDGE` from `/health` before it enables conversational
 * writes, and recovers a command whose call answered
 * `FRONTEND_OUTCOME_UNKNOWN` from its own journal instead of issuing a
 * replacement). Pure and dependency-free so it runs on Node and on workerd.
 */

/**
 * What `/health` advertises under `frontendTools`. Version 2 is the bridge
 * where every invocation has its own id, runs on exactly one authenticated
 * socket, and a missing answer is reported as an unknown outcome.
 */
export const FRONTEND_BRIDGE = {
  protocolVersion: 2,
  execution: 'single-socket',
  timeoutOutcome: 'unknown',
} as const;

export type FrontendBridgeAdvertisement = typeof FRONTEND_BRIDGE;

export const FRONTEND_OUTCOME_UNKNOWN = 'FRONTEND_OUTCOME_UNKNOWN';

/** The model-facing text of an unknown outcome. */
export const FRONTEND_OUTCOME_UNKNOWN_MESSAGE =
  'The frontend result did not arrive. The operation may still complete. Read command status using the original command ID before retrying; do not issue a replacement mutation.';

/**
 * The result of a frontend call whose answer never arrived: a deadline (or a
 * lost connection) cannot establish whether a browser-side write persisted,
 * so the call is neither a success nor a failure.
 */
export interface FrontendOutcomeUnknown {
  success: false;
  code: typeof FRONTEND_OUTCOME_UNKNOWN;
  outcome: 'unknown';
  invocationId: string;
  message: string;
}

export function frontendOutcomeUnknown(
  invocationId: string,
): FrontendOutcomeUnknown {
  return {
    success: false,
    code: FRONTEND_OUTCOME_UNKNOWN,
    outcome: 'unknown',
    invocationId,
    message: FRONTEND_OUTCOME_UNKNOWN_MESSAGE,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

/**
 * Whether a result reports an unknown outcome — the runtime's own deadline
 * result, or a client that answered `{ success: false, outcome: 'unknown' }`
 * because it could not tell whether its write landed. Such a result is
 * returned to the model, never turned into a rejection.
 */
export function reportsUnknownOutcome(value: unknown): boolean {
  return isRecord(value) && value.outcome === 'unknown';
}

/**
 * A fresh invocation id for one frontend call. The caller's id (a turn- or
 * tool-call-level id) stays readable as the prefix; the random suffix makes
 * every invocation distinct, so a result can only ever match the one call
 * that issued it.
 */
export function frontendInvocationId(callerId: string): string {
  return `${callerId}:${crypto.randomUUID()}`;
}

/** A Portal Topic command id: a SHA-256 hex digest. */
const COMMAND_ID = /^[a-f0-9]{64}$/;

/**
 * What a diagnostic action log may record about a frontend call: its
 * invocation id, a Portal command id when the result carries one, and
 * whether the outcome is unknown — never the arguments or the result body,
 * which carry user content.
 */
export interface FrontendActionLogSummary {
  invocationId?: string;
  commandId?: string;
  outcome?: 'unknown';
}

export function summarizeFrontendResult(
  result: unknown,
  invocationId: string | undefined,
): { result: FrontendActionLogSummary; success: boolean } {
  const record = isRecord(result) ? result : {};
  const commandId =
    typeof record.commandId === 'string' && COMMAND_ID.test(record.commandId)
      ? record.commandId
      : undefined;
  return {
    result: {
      ...(invocationId ? { invocationId } : {}),
      ...(commandId ? { commandId } : {}),
      ...(reportsUnknownOutcome(result) ? { outcome: 'unknown' as const } : {}),
    },
    success: record.success !== false,
  };
}

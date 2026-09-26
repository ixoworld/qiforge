/**
 * How a tool call is executed once the resume policy (tool-marks.ts) let it
 * run: charged to the turn's budget, scheduled in its lane, and — for a
 * write — claimed in the run ledger for as long as its outcome is unknown.
 *
 * The claim is a fingerprint of the tool name and its canonical arguments,
 * recorded before the write starts. A returned result (success or a
 * reported failure) releases it; a failure that says nothing about whether
 * the write happened — abort, deadline, a dropped connection, a 5xx —
 * leaves it in place, whether the tool threw it or caught it and returned
 * it as an error result (many plugin tools and adapters never throw to the
 * agent: `{ ok: false, error }`, an error-status ToolMessage, `Error: …`).
 * An identical write attempted while a claim stands is
 * not executed: the model is told the earlier outcome is unknown and asked
 * to verify with a read (a `warned` claim). A later turn that asks for the
 * same write again, after that warning, runs it — the user was informed and
 * asked again — and the ledger drops claims with the run retention.
 *
 * Placed innermost around the tool (`MainAgentHooks.toolExecution`): it
 * must see the tool's own thrown error, which the retry middlewares would
 * otherwise have turned into an error ToolMessage, and each retry attempt
 * is charged and scheduled again. Applied to every sub-agent's inner graph
 * too, so a sub-agent's own writes are claimed. Sub-agent dispatches are
 * counted as tool attempts and scheduled in their own lane, never
 * fingerprinted.
 */
import { ToolMessage } from '@langchain/core/messages';
import { type AgentMiddleware, createMiddleware } from 'langchain';
import type { Logger } from '../../plugin-api/types';
import type { ToolLane, ToolScheduler } from '../tool-scheduler';
import { isHarnessLimitError, type TurnBudget } from '../turn-budget';
import { NOOP_LOGGER } from '../utils';

export type WriteClaim =
  | { status: 'claimed' }
  | { status: 'blocked'; toolName: string; since: string };

/** The claim slice of the run ledger (see `RunStore`). */
export interface WriteClaimStore {
  claimWrite(input: {
    fingerprint: string;
    toolName: string;
    runId: string;
    sessionId: string;
  }): Promise<WriteClaim>;
  releaseWrite(fingerprint: string, runId: string): Promise<void>;
}

export interface ToolExecutionOptions {
  budget: TurnBudget;
  scheduler: ToolScheduler;
  /** Lane of a tool by name (`read`, `write`, or `subagent` for a dispatch). */
  laneOf: (toolName: string) => ToolLane;
  runId: string;
  sessionId: string;
  /** Omitted → writes are scheduled and charged but not claimed (stateless builds, tests). */
  claims?: WriteClaimStore;
  /** The turn's abort signal: waiting for a slot ends with it. */
  signal?: AbortSignal;
  logger?: Logger;
}

/** Stable text for a value: object keys sorted, arrays in order. */
export function canonicalArguments(value: unknown): string {
  if (Array.isArray(value))
    return `[${value.map(canonicalArguments).join(',')}]`;
  if (value && typeof value === 'object')
    return `{${Object.entries(value)
      .filter(([, item]) => item !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(
        ([key, item]) => `${JSON.stringify(key)}:${canonicalArguments(item)}`,
      )
      .join(',')}}`;
  return JSON.stringify(value) ?? 'null';
}

/** SHA-256 of `name:args`, hex — the write's fingerprint in the ledger. */
export async function operationKey(
  name: string,
  args: unknown,
): Promise<string> {
  const bytes = new TextEncoder().encode(`${name}:${canonicalArguments(args)}`);
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(digest), (b) =>
    b.toString(16).padStart(2, '0'),
  ).join('');
}

/** The result handed to the model for a write it must not repeat yet. */
export function uncertainWriteToolResult(toolName: string): string {
  return `An identical ${toolName} call was started earlier and its outcome is unknown (it was interrupted or its connection dropped), so it was NOT run again: running it twice could repeat its effect. Verify with a read-only call whether it already happened and tell the user; only repeat it if they confirm.`;
}

/** Failure text that says nothing about whether the side effect happened. */
const UNCERTAIN_TEXT =
  /fetch failed|network|ECONNRESET|ECONNREFUSED|ETIMEDOUT|EPIPE|socket hang up|timed? ?out|aborted|internal server error|bad gateway|service unavailable|gateway time-?out/i;

const isServerStatus = (status: unknown): boolean =>
  typeof status === 'number' && status >= 500 && status <= 599;

/**
 * `true` when a thrown error says nothing about whether the tool's side
 * effect happened: the turn was aborted or hit its deadline, the transport
 * failed, or the service answered with a server error.
 */
export function isUncertainOutcome(
  error: unknown,
  signal?: AbortSignal,
): boolean {
  if (signal?.aborted) return true;
  if (isHarnessLimitError(error)) return true;
  if (!(error instanceof Error)) return false;
  if (error.name === 'AbortError' || error.name === 'TimeoutError') return true;
  const status =
    'status' in error && typeof error.status === 'number'
      ? error.status
      : undefined;
  if (status !== undefined) return isServerStatus(status);
  return UNCERTAIN_TEXT.test(error.message);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function toolMessageText(message: ToolMessage): string {
  const { content } = message;
  if (typeof content === 'string') return content;
  return content
    .map((block) =>
      typeof block === 'string'
        ? block
        : 'text' in block && typeof block.text === 'string'
          ? block.text
          : '',
    )
    .join('\n');
}

/**
 * The failure a JSON tool result reports, when it is one: `ok`, `success` or
 * `successful` false, `isError` true, or an `error` field. The text joins
 * whatever describes it (error, message, reason, code, detail) and a server
 * status (`status` / `statusCode`) is carried apart.
 */
function reportedFailure(
  body: Record<string, unknown>,
): { text: string; serverStatus: boolean } | null {
  const failed =
    body.ok === false ||
    body.success === false ||
    body.successful === false ||
    body.isError === true ||
    (body.error !== undefined && body.error !== null && body.error !== false);
  if (!failed) return null;
  const parts: string[] = [];
  let serverStatus =
    isServerStatus(body.status) || isServerStatus(body.statusCode);
  const collect = (value: unknown): void => {
    if (typeof value === 'string') parts.push(value);
    else if (isRecord(value)) {
      if (isServerStatus(value.status) || isServerStatus(value.statusCode))
        serverStatus = true;
      for (const key of ['message', 'code', 'reason', 'detail'])
        collect(value[key]);
    }
  };
  for (const key of ['error', 'message', 'reason', 'code', 'detail'])
    collect(body[key]);
  return { text: parts.join(' '), serverStatus };
}

/**
 * Why a RETURNED tool result leaves a write's outcome unknown, or null when
 * it does not. Only an error-shaped result counts — an error-status
 * ToolMessage, a JSON failure (`reportedFailure`), or text that opens with
 * `Error` / `Failed` — and only when what it reports is the uncertain kind
 * `isUncertainOutcome` recognises in a thrown error (a timeout, a transport
 * failure, a 5xx). A failure the service did report (validation, 404, 403)
 * is a known outcome, and a success mentioning a timeout is not a failure.
 */
export function uncertainResultReason(output: unknown): string | null {
  if (!ToolMessage.isInstance(output)) return null;
  const text = toolMessageText(output).trim();
  let failure: { text: string; serverStatus: boolean } | null = null;
  try {
    const parsed: unknown = JSON.parse(text);
    if (isRecord(parsed)) failure = reportedFailure(parsed);
  } catch {
    // Not JSON: plain text, judged below.
  }
  if (
    !failure &&
    (output.status === 'error' || /^(error|failed)\b/i.test(text))
  )
    failure = { text, serverStatus: false };
  if (!failure) return null;
  if (failure.serverStatus) return 'server error';
  const match = UNCERTAIN_TEXT.exec(failure.text);
  return match ? match[0] : null;
}

export function createToolExecutionMiddleware(
  options: ToolExecutionOptions,
): AgentMiddleware {
  const logger = options.logger ?? NOOP_LOGGER;
  const { budget, scheduler, claims } = options;
  // Executions per tool call id: a second one is a retry (the log is the
  // operator's only view of a read that failed and then succeeded).
  const attempts = new Map<string, number>();
  return createMiddleware({
    name: 'ToolExecutionMiddleware',
    wrapToolCall: async (request, handler) => {
      const { toolCall } = request;
      const toolName = toolCall.name;
      const lane = options.laneOf(toolName);
      const callId = toolCall.id ?? '';
      const attempt = (attempts.get(callId) ?? 0) + 1;
      attempts.set(callId, attempt);
      if (attempt > 1)
        logger.log(
          `[tool-execution] ${toolName} (${callId}): attempt ${attempt}`,
        );
      // Refused before waiting for a slot: a turn over its limit takes no
      // more slots. The slot wait itself ends with the abort signal.
      budget.check(options.signal);
      return scheduler.run(lane, options.signal, async () => {
        budget.reserveTool(options.signal);
        if (lane !== 'write' || !claims) return handler(request);
        const fingerprint = await operationKey(toolName, toolCall.args);
        const claim = await claims.claimWrite({
          fingerprint,
          toolName,
          runId: options.runId,
          sessionId: options.sessionId,
        });
        if (claim.status === 'blocked') {
          logger.warn(
            `[tool-execution] ${toolName}: an identical write since ${claim.since} has no known outcome; not run again`,
          );
          return new ToolMessage({
            tool_call_id: toolCall.id ?? '',
            name: toolName,
            content: uncertainWriteToolResult(toolName),
            status: 'error',
          });
        }
        try {
          const output = await handler(request);
          const uncertain = uncertainResultReason(output);
          if (uncertain !== null) {
            logger.warn(
              `[tool-execution] ${toolName}: returned a failure that leaves its outcome unknown (${uncertain}); its claim stays in the ledger`,
            );
          } else {
            await claims.releaseWrite(fingerprint, options.runId);
          }
          return output;
        } catch (error) {
          if (isUncertainOutcome(error, options.signal)) {
            logger.warn(
              `[tool-execution] ${toolName}: outcome unknown (${error instanceof Error ? error.message.split('\n')[0] : String(error)}); its claim stays in the ledger`,
            );
          } else {
            await claims
              .releaseWrite(fingerprint, options.runId)
              .catch(() => undefined);
          }
          throw error;
        }
      });
    },
  });
}

/**
 * How a tool call is executed once the resume policy (tool-marks.ts) let it
 * run: charged to the turn's budget, scheduled in its lane, and — for a
 * write — claimed in the run ledger for as long as its outcome is unknown.
 *
 * The claim is a fingerprint of the tool name and its canonical arguments,
 * recorded before the write starts. A returned result (success or a
 * reported failure) releases it; a failure that says nothing about whether
 * the write happened — abort, deadline, a dropped connection, a 5xx —
 * leaves it in place. An identical write attempted while a claim stands is
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
  if (status !== undefined) return status >= 500 && status <= 599;
  return /fetch failed|network|ECONNRESET|ECONNREFUSED|ETIMEDOUT|EPIPE|socket hang up|timed? ?out|aborted/i.test(
    error.message,
  );
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
          await claims.releaseWrite(fingerprint, options.runId);
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

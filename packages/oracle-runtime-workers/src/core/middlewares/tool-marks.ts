/**
 * Write-ahead marks for tool calls, and the resume policy built on them.
 *
 * Before any tool executes, its call id is recorded (`started`) in the run's
 * marks; when it returns, the mark is closed (`done`). A run that is resumed
 * after a reset finds the marks of the previous attempt and the graph about
 * to execute the same tool calls again (LangGraph re-runs the pending node).
 * The policy:
 *
 *   - a call that never started runs normally;
 *   - a started, unfinished **write** call is NOT executed again — the model
 *     gets a synthetic result saying the outcome is unknown, so it can tell
 *     the user or verify with a read;
 *   - a started, unfinished **read** call runs again (it has no effect);
 *   - a started, unfinished **frontend** call (`PluginTool.surface`) that
 *     was never sent — it was parked waiting for a browser socket when the
 *     object restarted, so no browser saw it — runs again whatever its
 *     effect. Once sent (`markSent`, recorded by the frontend bridge when a
 *     socket receives it) it follows the read / write rules above;
 *   - a call that already finished is not executed again either (its result
 *     is in the checkpoint's pending writes; reaching here means LangGraph
 *     could not replay it) — writes get the unknown-outcome result, reads run.
 *
 * The middleware also injects, into the first model call after a resume, a
 * note carrying the tail of the reply the user had already seen, so the
 * model continues the interrupted reply instead of starting over.
 */
import {
  type BaseMessage,
  SystemMessage,
  ToolMessage,
} from '@langchain/core/messages';
import { type AgentMiddleware, createMiddleware } from 'langchain';
import type { ToolEffect, ToolMark } from '../../do/run-store';
import type { Logger } from '../../plugin-api/types';
import { NOOP_LOGGER } from '../utils';

export type { ToolEffect };

/** The mark store slice the middleware drives (see `RunStore`). */
export interface ToolMarkStore {
  startMark(input: {
    runId: string;
    toolCallId: string;
    toolName: string;
    effect: ToolEffect;
  }): Promise<ToolMark | undefined>;
  bumpMark(runId: string, toolCallId: string): Promise<void>;
  /** The call was handed to its executor outside the object (a browser socket). */
  markSent(runId: string, toolCallId: string): Promise<void>;
  finishMark(
    runId: string,
    toolCallId: string,
    outcome: 'ok' | 'error' | 'interrupted',
  ): Promise<void>;
}

export interface ToolMarksOptions {
  runId: string;
  store: ToolMarkStore;
  /** The effect of a tool by name; unknown tools are writes (see `toolEffectOf`). */
  effectOf: (toolName: string) => ToolEffect;
  /**
   * `frontend` for a tool that runs in the user's browser
   * (`PluginTool.surface`); such a call that was never sent before a restart
   * runs again whatever its effect. Omitted → no tool is a frontend tool.
   */
  surfaceOf?: (toolName: string) => 'frontend' | undefined;
  /**
   * The reply text the user already received before the run was cut off.
   * Set only on a resumed attempt; consumed by the first model call.
   */
  continuation?: string | null;
  logger?: Logger;
}

/** The result handed to the model for a write call whose outcome cannot be known. */
export function unknownOutcomeToolResult(toolName: string): string {
  return `The runtime was restarted while ${toolName} was executing, so whether it completed is unknown and it was NOT run again (running it twice could repeat its effect). Tell the user this step may or may not have happened, and verify with a read-only call before repeating it.`;
}

/** How many trailing characters of the interrupted reply the model is shown. */
export const CONTINUATION_TAIL_CHARS = 1200;

export function continuationNote(partialText: string): string {
  const tail =
    partialText.length > CONTINUATION_TAIL_CHARS
      ? `…${partialText.slice(-CONTINUATION_TAIL_CHARS)}`
      : partialText;
  return (
    'Your reply to the latest user message was interrupted by a runtime restart. ' +
    'The user has already received this beginning of it:\n\n' +
    `"""${tail}"""\n\n` +
    'Continue from exactly where it stopped, without repeating any of the text above, ' +
    'without apologising and without mentioning the interruption. If the reply above ' +
    'was already complete, respond with nothing more than a one-line closing remark.'
  );
}

/**
 * Verbs a read-only tool name starts with, in either convention: snake case
 * (`get_entity`) or camel case (`getEntity`, as browser tools are named).
 */
const READ_VERBS = [
  'list',
  'get',
  'find',
  'search',
  'read',
  'preview',
  'describe',
  'check',
  'explain',
  'validate',
  'view',
];

function startsWithReadVerb(name: string): boolean {
  for (const verb of READ_VERBS) {
    if (!name.startsWith(verb)) continue;
    const next = name.charAt(verb.length);
    if (next === '_' || (next >= 'A' && next <= 'Z')) return true;
  }
  return false;
}
const READ_NAMES = new Set([
  'requirements',
  'flow_status',
  'compatible_actions',
  'oracle_list',
  'vfs_glob',
  'vfs_grep',
  'load_capability',
  'unload_capability',
]);

/**
 * Effect classification: an explicit declaration wins; MCP annotations count
 * when the server sent them; otherwise a conservative name convention marks
 * the obvious reads and everything else is a write (never re-run on resume).
 */
export function toolEffectOf(tool: {
  name: string;
  effect?: ToolEffect;
  annotations?: { readOnlyHint?: boolean; idempotentHint?: boolean };
}): ToolEffect {
  if (tool.effect) return tool.effect;
  if (tool.annotations?.readOnlyHint === true) return 'read';
  if (READ_NAMES.has(tool.name)) return 'read';
  // MCP tools arrive as `<server>__<tool>`; classify on the tool part.
  const bare = tool.name.includes('__')
    ? tool.name.slice(tool.name.lastIndexOf('__') + 2)
    : tool.name;
  if (READ_NAMES.has(bare)) return 'read';
  return startsWithReadVerb(bare) ? 'read' : 'write';
}

/** Whether a tool call's output is an error result (`ToolMessage` status `error`). */
export function isErrorResult(output: unknown): boolean {
  if (ToolMessage.isInstance(output)) return output.status === 'error';
  return false;
}

export function createToolMarksMiddleware(
  options: ToolMarksOptions,
): AgentMiddleware {
  const logger = options.logger ?? NOOP_LOGGER;
  let continuation = options.continuation ?? null;
  return createMiddleware({
    name: 'ToolMarksMiddleware',
    wrapModelCall: async (request, handler) => {
      if (!continuation || continuation.trim().length === 0)
        return handler(request);
      const note = continuationNote(continuation);
      continuation = null;
      const messages: BaseMessage[] = [
        ...request.messages,
        new SystemMessage(note),
      ];
      logger.log(
        '[tool-marks] resumed run: continuation note added to the first model call',
      );
      return handler({ ...request, messages });
    },
    wrapToolCall: async (request, handler) => {
      const { toolCall } = request;
      const toolCallId = toolCall.id ?? '';
      const toolName = toolCall.name;
      if (!toolCallId) return handler(request);
      const effect = options.effectOf(toolName);
      const existing = await options.store.startMark({
        runId: options.runId,
        toolCallId,
        toolName,
        effect,
      });
      if (existing) {
        const neverSent =
          !existing.doneAt &&
          existing.sentAt === null &&
          options.surfaceOf?.(toolName) === 'frontend';
        if (neverSent) {
          logger.log(
            `[tool-marks] ${toolName} (${toolCallId}) was parked and never sent to a browser in an earlier attempt of run ${options.runId}; running it again`,
          );
          await options.store.bumpMark(options.runId, toolCallId);
        } else if (effect === 'write') {
          logger.warn(
            `[tool-marks] ${toolName} (${toolCallId}) was ${existing.doneAt ? 'already executed' : 'interrupted mid-execution'} in an earlier attempt of run ${options.runId}; not run again`,
          );
          await options.store.finishMark(
            options.runId,
            toolCallId,
            'interrupted',
          );
          return new ToolMessage({
            tool_call_id: toolCallId,
            name: toolName,
            content: unknownOutcomeToolResult(toolName),
            status: 'error',
          });
        } else {
          logger.log(
            `[tool-marks] ${toolName} (${toolCallId}) is read-only; running it again after the interruption`,
          );
          await options.store.bumpMark(options.runId, toolCallId);
        }
      }
      try {
        const output = await handler(request);
        await options.store.finishMark(
          options.runId,
          toolCallId,
          isErrorResult(output) ? 'error' : 'ok',
        );
        return output;
      } catch (error) {
        await options.store
          .finishMark(options.runId, toolCallId, 'error')
          .catch(() => undefined);
        throw error;
      }
    },
  });
}

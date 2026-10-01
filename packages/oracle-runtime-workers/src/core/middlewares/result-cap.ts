/**
 * Tool results larger than the turn's cap never reach the model whole.
 *
 * The cap is a fraction of the model's context window (`context-budget.ts`),
 * so it scales with the model. Above it the result is stored whole (the
 * result store: SQLite under ~1 MB, R2 beyond) and the model receives the
 * first 40% and last 60% of the visible budget with a footer naming the
 * handle, so `read_result` can page through the rest when needed. Nothing
 * is decided per tool: every large result is both truncated and preserved.
 *
 * Applied to the main agent and every sub-agent (via `toolMiddlewares`), so
 * a sub-agent's own tool calls are capped too — and the sub-agent's reply,
 * which is a tool result to the main agent, is capped in turn.
 */
import { ToolMessage } from '@langchain/core/messages';
import { type AgentMiddleware, createMiddleware } from 'langchain';
import type { Logger } from '../../plugin-api/types';
import type { StoredResultRef } from '../../do/result-store';
import { NOOP_LOGGER } from '../utils';

export interface ResultCapStore {
  put(input: {
    sessionId: string;
    toolName: string;
    content: string;
  }): Promise<StoredResultRef | undefined>;
}

export interface ResultCapOptions {
  /** Visible characters a result may have before it is capped. */
  capChars: number;
  sessionId: string;
  store?: ResultCapStore;
  /** Share of the visible budget given to the head (default 0.4, Hermes' split). */
  headRatio?: number;
  /** Tools whose results are never capped (`read_result` pages by design). */
  exempt?: ReadonlySet<string>;
  logger?: Logger;
}

/** The same configuration, as the tool wrapper takes it (see `wrapPluginTool`). */
export type ResultCapConfig = ResultCapOptions;

/**
 * Cap one result's text: store it whole (when a store is bound) and return
 * the head + tail + footer the model sees, or the text unchanged when it
 * fits. Used at the tool boundary (`wrapPluginTool`, so the SSE frame, the
 * model and the transcript all carry the capped text) and by the
 * middleware below for tools that bypass the wrapper (sub-agents).
 */
export async function capToolResult(
  text: string,
  toolName: string,
  options: ResultCapOptions,
): Promise<{ text: string; meta?: CappedResultMeta }> {
  if (text.length <= options.capChars) return { text };
  if (options.exempt?.has(toolName)) return { text };
  const logger = options.logger ?? NOOP_LOGGER;
  let ref: StoredResultRef | undefined;
  try {
    ref = await options.store?.put({
      sessionId: options.sessionId,
      toolName,
      content: text,
    });
  } catch (error) {
    logger.warn(
      `[result-cap] ${toolName}: could not save the full result: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  const meta: CappedResultMeta = {
    ...(ref ? { id: ref.id } : {}),
    size: text.length,
    shown: Math.max(200, options.capChars - 400),
  };
  logger.log(
    `[result-cap] ${toolName}: ${text.length} chars > cap ${options.capChars}; ${ref ? `saved as ${ref.id.slice(0, 12)}… (${ref.tier})` : 'not saved'}`,
  );
  return {
    text: truncateHeadTail(
      text,
      options.capChars,
      meta,
      options.headRatio ?? 0.4,
    ),
    meta,
  };
}

/** Marker kept in `additional_kwargs` so later passes know the result was capped. */
export interface CappedResultMeta {
  id?: string;
  size: number;
  shown: number;
}

export const CAPPED_META_KEY = 'capped';

export function capFooter(
  meta: CappedResultMeta,
  head: number,
  tail: number,
): string {
  const where = meta.id
    ? `The full result is saved as ${meta.id}: call read_result({ id: "${meta.id}", offset: 0 }) and follow \`next\` to read it in chunks.`
    : 'The full result could not be saved.';
  return `\n\n[Result truncated: showing the first ${head} and last ${tail} of ${meta.size} characters. ${where}]`;
}

/** Split a visible budget into head and tail lengths. */
export function headTailSplit(
  budget: number,
  headRatio = 0.4,
): { head: number; tail: number } {
  const head = Math.max(0, Math.floor(budget * headRatio));
  return { head, tail: Math.max(0, budget - head) };
}

export function truncateHeadTail(
  text: string,
  capChars: number,
  meta: CappedResultMeta,
  headRatio = 0.4,
): string {
  // Leave room for the footer inside the cap.
  const budget = Math.max(200, capChars - 400);
  const { head, tail } = headTailSplit(budget, headRatio);
  return `${text.slice(0, head)}\n\n… [${text.length - head - tail} characters omitted] …\n\n${text.slice(text.length - tail)}${capFooter(meta, head, tail)}`;
}

function contentToText(content: unknown): string {
  if (typeof content === 'string') return content;
  try {
    return JSON.stringify(content) ?? '';
  } catch {
    return String(content);
  }
}

export function createResultCapMiddleware(
  options: ResultCapOptions,
): AgentMiddleware {
  return createMiddleware({
    name: 'ResultCapMiddleware',
    wrapToolCall: async (request, handler) => {
      const output = await handler(request);
      if (!ToolMessage.isInstance(output)) return output;
      const toolName = output.name ?? request.toolCall.name;
      const capped = await capToolResult(
        contentToText(output.content),
        toolName,
        options,
      );
      if (!capped.meta) return output;
      return new ToolMessage({
        ...(output.id ? { id: output.id } : {}),
        tool_call_id: output.tool_call_id,
        name: toolName,
        status: output.status,
        content: capped.text,
        additional_kwargs: {
          ...output.additional_kwargs,
          [CAPPED_META_KEY]: capped.meta,
        },
      });
    },
  });
}

/** The cap marker of a tool message, if it was capped. */
export function cappedMetaOf(message: {
  additional_kwargs?: Record<string, unknown>;
}): CappedResultMeta | undefined {
  const raw = message.additional_kwargs?.[CAPPED_META_KEY];
  if (!raw || typeof raw !== 'object') return undefined;
  const meta = raw as Partial<CappedResultMeta>;
  return typeof meta.size === 'number'
    ? { ...meta, size: meta.size, shown: meta.shown ?? 0 }
    : undefined;
}

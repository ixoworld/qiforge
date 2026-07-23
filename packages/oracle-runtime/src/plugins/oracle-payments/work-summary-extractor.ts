import type { BaseMessage } from '@langchain/core/messages';
import { HumanMessage, SystemMessage } from '@langchain/core/messages';
import { z } from 'zod';
import { getProviderChatModel } from '../../llm/llm-provider.js';
import type { Logger } from '../../plugin-api/types.js';
import { errorMessage } from './util.js';
import { Logger as NestLogger } from '@nestjs/common';
/** Hard ceiling on the extraction call — a hung model must not hang delivery. */
const EXTRACTOR_TIMEOUT_MS = 60_000;

/**
 * Character budget for the rendered transcript. Newest messages are kept and
 * older ones dropped, so the extraction always sees how the work finished.
 */
const TRANSCRIPT_CHAR_BUDGET = 24_000;

/** Per-message clamp, so one huge tool payload can't crowd out the thread. */
const MESSAGE_CHAR_CLAMP = 2_000;

const extractionSchema = z.object({
  request: z
    .string()
    .min(1)
    .describe("What the user asked for, in the user's own terms."),
  workSummary: z
    .string()
    .min(1)
    .describe('What was actually done, per the observed activity.'),
});

/** The two claim fields the agent is never trusted to author itself. */
export type WorkSummaryExtraction = z.infer<typeof extractionSchema>;

/** Structured-output surface the extractor needs from a chat model. */
export interface ExtractorStructuredModel {
  invoke(messages: BaseMessage[]): Promise<unknown>;
}

export interface ExtractorModel {
  withStructuredOutput(schema: z.ZodType): ExtractorStructuredModel;
}

/** Model factory — `params.model` carries the plugin's extractor override. */
export type ExtractorModelFactory = (params?: {
  model?: string;
}) => ExtractorModel;

const defaultModelFactory: ExtractorModelFactory = (params) => {
  const model = getProviderChatModel('custom_medium', params);
  return {
    withStructuredOutput: (schema) => model.withStructuredOutput(schema),
  };
};

export interface WorkSummaryExtractorDeps {
  getModel?: ExtractorModelFactory;
  logger?: Logger;
}

export interface WorkSummaryExtractInput {
  /** The engagement thread's messages, oldest first (the checkpointer view). */
  messages: readonly BaseMessage[];
  serviceId: string;
  serviceName: string;
  /** Model override (`ORACLE_PAYMENTS_EXTRACTOR_MODEL`). */
  model?: string;
}

/**
 * Extracts the work claim's `request` and `workSummary` from the engagement
 * thread with a model the work agent does not control — the agent grading its
 * own homework is exactly the trust gap the evaluator exists to close, so
 * these two fields are never taken from tool arguments.
 *
 * Throws on an empty thread, a model failure, or unparseable output: a claim
 * with invented provenance must never be signed, and there is deliberately no
 * fallback to agent-supplied text.
 */
export class WorkSummaryExtractor {
  private readonly getModel: ExtractorModelFactory;
  private readonly logger?: Logger;

  constructor(deps: WorkSummaryExtractorDeps = {}) {
    this.getModel = deps.getModel ?? defaultModelFactory;
    this.logger = deps.logger;
  }

  async extract(
    input: WorkSummaryExtractInput,
  ): Promise<WorkSummaryExtraction> {
    const transcript = renderTranscript(input.messages);
    if (transcript.length === 0) {
      throw new Error(
        'Cannot summarize this work: the thread has no recorded activity to extract the request and work summary from.',
      );
    }

    let raw: unknown;
    try {
      const model = this.getModel(
        input.model ? { model: input.model } : undefined,
      ).withStructuredOutput(extractionSchema);
      raw = await withTimeout(
        model.invoke([
          new SystemMessage(buildExtractorPrompt(input)),
          new HumanMessage(transcript),
        ]),
        EXTRACTOR_TIMEOUT_MS,
      );
    } catch (error) {
      this.logger?.warn?.(
        `[oracle-payments] work summary extraction failed: ${errorMessage(error)}`,
      );
      throw new Error(
        `Could not summarize this work for the claim: ${errorMessage(error)}. Nothing was submitted — try delivering again.`,
      );
    }

    const parsed = extractionSchema.safeParse(raw);
    if (!parsed.success) {
      throw new Error(
        'Could not summarize this work for the claim: the summary model returned an unusable result. Nothing was submitted — try delivering again.',
      );
    }
    return parsed.data;
  }
}

function buildExtractorPrompt(input: WorkSummaryExtractInput): string {
  return [
    'You read the transcript of one piece of paid work an AI agent carried',
    `out for a user under the service "${input.serviceName}" (${input.serviceId}),`,
    'and write two short factual fields for the work record.',
    '',
    'request: what the USER asked for, in their own terms. Draw only from',
    'what the user actually wrote. Do not add requirements they never stated.',
    '',
    'workSummary: what was ACTUALLY DONE, per the visible activity in the',
    'transcript — the steps taken, the tools run, and what came out of them.',
    '',
    'Rules:',
    '- Report only what the transcript shows. Never invent outcomes, numbers,',
    '  files, or guarantees that are not observable in it.',
    '- If the work was partial or failed, say so plainly in workSummary.',
    '- No praise, no marketing, no promises. Plain past tense, 1-4 sentences',
    '  each.',
  ].join('\n');
}

/** `[role] text` lines, newest-biased within the character budget. */
function renderTranscript(messages: readonly BaseMessage[]): string {
  NestLogger.debug('🚀 ~ renderTranscript ~ messages:', messages);
  const lines: string[] = [];
  let budget = TRANSCRIPT_CHAR_BUDGET;

  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i];
    if (!message) continue;
    if (message.text.length === 0) continue;

    const line = `[${message.type}] ${clamp(message.text, MESSAGE_CHAR_CLAMP)}`;
    if (line.length > budget) break;
    budget -= line.length;
    lines.push(line);
  }

  return lines.reverse().join('\n');
}

function clamp(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

async function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(
          () => reject(new Error(`model call timed out after ${ms}ms`)),
          ms,
        );
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

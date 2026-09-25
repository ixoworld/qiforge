/**
 * A finished run → its Reply Plan. Built once, when the run finishes, from
 * the turn's own messages (the model's checkpointed history is never
 * rewritten; the plan is a projection of it for one chat surface):
 *
 *  - every model step with text is delivered in order, not only the last
 *    one; a short line of narration before a tool call ("Checking your
 *    calendar.") is dropped, because the typing indicator already says so;
 *  - each step goes through the shaper, which may spill it to an artefact;
 *  - a `create_artifact` call becomes its message, the link, its question.
 */
import {
  AIMessage,
  ToolMessage,
  type BaseMessage,
} from '@langchain/core/messages';
import { contentToText } from '../do/transcript';
import { CREATE_ARTIFACT_TOOL, createArtifactParts } from '../artifacts/tool';
import { shapeStep, type SpillShape } from './shaper';
import type {
  ArtifactRef,
  ChatLimits,
  ReplyContent,
  ReplyPart,
  ReplyPlan,
} from './types';

export interface TurnStep {
  text: string;
  toolCalls: Array<{ id: string; name: string; args: unknown }>;
}

export type DraftPart =
  | ReplyContent
  | { kind: 'spill'; key: string; spill: SpillShape };

const NARRATION_MAX_CHARS = 200;

/** The model steps of the turn that ended the thread, with its tool results. */
export function turnSteps(messages: readonly BaseMessage[]): {
  steps: TurnStep[];
  toolResults: Map<string, string>;
} {
  let start = 0;
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i]?.type === 'human') {
      start = i + 1;
      break;
    }
  }
  const steps: TurnStep[] = [];
  const toolResults = new Map<string, string>();
  for (const message of messages.slice(start)) {
    if (ToolMessage.isInstance(message)) {
      toolResults.set(message.tool_call_id, contentToText(message.content));
      continue;
    }
    // Extraction-lane attachment text rides as hidden AI messages.
    if (!AIMessage.isInstance(message) || message.additional_kwargs?.attachment)
      continue;
    steps.push({
      text: contentToText(message.content).trim(),
      toolCalls: (message.tool_calls ?? []).map((call) => ({
        id: call.id ?? '',
        name: call.name,
        args: call.args,
      })),
    });
  }
  return { steps, toolResults };
}

/** One short paragraph of prose: what a model says before it calls a tool. */
export function isNarration(text: string): boolean {
  return (
    text.length <= NARRATION_MAX_CHARS &&
    !text.includes('\n\n') &&
    !text.includes('```') &&
    !/^\s*([-*+]|\d+[.)])\s/m.test(text)
  );
}

/**
 * The plan before any artefact exists: spills are still drafts. `continuation`
 * is the reply a run had already produced before a reset; it belongs in front
 * of the final step.
 */
export function draftReplyPlan(input: {
  steps: TurnStep[];
  toolResults: ReadonlyMap<string, string>;
  continuation?: string | null;
  limits: ChatLimits;
  canSpill: boolean;
}): DraftPart[] {
  const parts: DraftPart[] = [];
  const last = input.steps.length - 1;
  input.steps.forEach((step, i) => {
    const text =
      i === last && input.continuation
        ? `${input.continuation}${step.text}`.trim()
        : step.text;
    if (text && !(step.toolCalls.length > 0 && isNarration(text))) {
      const shape = shapeStep(text, input.limits, input.canSpill);
      if (shape.kind === 'messages')
        parts.push(
          ...shape.messages.map((m) => ({ kind: 'text' as const, text: m })),
        );
      else parts.push({ kind: 'spill', key: `step-${i}`, spill: shape.spill });
    }
    for (const call of step.toolCalls)
      if (call.name === CREATE_ARTIFACT_TOOL)
        parts.push(
          ...createArtifactParts(call.args, input.toolResults.get(call.id)),
        );
  });
  return parts;
}

/** Over the run's cap: merge the shortest neighbouring messages, order kept. */
function capParts(parts: ReplyContent[], max: number): ReplyContent[] {
  const out = [...parts];
  while (out.length > max) {
    let best = -1;
    let bestLength = Infinity;
    for (let i = 0; i + 1 < out.length; i++) {
      const a = out[i];
      const b = out[i + 1];
      if (a?.kind !== 'text' || b?.kind !== 'text') continue;
      if (a.text.length + b.text.length < bestLength) {
        best = i;
        bestLength = a.text.length + b.text.length;
      }
    }
    const a = out[best];
    const b = out[best + 1];
    if (a?.kind !== 'text' || b?.kind !== 'text') break;
    out.splice(best, 2, { kind: 'text', text: `${a.text}\n\n${b.text}` });
  }
  return out;
}

/**
 * Turn spill drafts into artefacts. A spill whose artefact cannot be created
 * falls back to plain messages: the reply is never lost to a storage error.
 */
export async function materializeReplyPlan(
  draft: DraftPart[],
  options: {
    limits: ChatLimits;
    createSpill: (key: string, spill: SpillShape) => Promise<ArtifactRef>;
    onSpillError?: (error: unknown) => void;
  },
): Promise<ReplyPlan> {
  const parts: ReplyContent[] = [];
  for (const part of draft) {
    if (part.kind !== 'spill') {
      parts.push(part);
      continue;
    }
    const ref = await options
      .createSpill(part.key, part.spill)
      .catch((error: unknown) => {
        options.onSpillError?.(error);
        return null;
      });
    if (ref) {
      if (part.spill.lead) parts.push({ kind: 'text', text: part.spill.lead });
      parts.push({ kind: 'artifact', artifact: ref });
      if (part.spill.closing)
        parts.push({ kind: 'text', text: part.spill.closing });
    } else {
      const shape = shapeStep(part.spill.markdown, options.limits, false);
      if (shape.kind === 'messages')
        parts.push(
          ...shape.messages.map((m) => ({ kind: 'text' as const, text: m })),
        );
    }
  }
  const capped = capParts(parts, options.limits.maxPartsPerRun);
  return {
    v: 1,
    parts: capped.map(
      (part, i): ReplyPart => ({ partId: `p${i + 1}`, ...part }),
    ),
  };
}

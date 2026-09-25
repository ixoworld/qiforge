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
 * What a resumed run still has to deliver of `continuation`, the text it
 * streamed before the reset. That text starts with the steps the checkpoint
 * kept, verbatim, and those steps are in `steps` already; the rest was cut
 * off mid-step and belongs in front of the first step after them.
 */
function pendingContinuation(
  continuation: string,
  steps: readonly TurnStep[],
): { text: string; step: number } {
  let rest = continuation;
  let step = 0;
  for (const { text } of steps) {
    const trimmed = rest.trimStart();
    if (!trimmed.startsWith(text)) break;
    rest = trimmed.slice(text.length);
    step++;
  }
  return { text: rest, step: Math.min(step, steps.length - 1) };
}

/**
 * The plan before any artefact exists: spills are still drafts. `continuation`
 * is the text a run had streamed before a reset (see `pendingContinuation`).
 */
export function draftReplyPlan(input: {
  steps: TurnStep[];
  toolResults: ReadonlyMap<string, string>;
  continuation?: string | null;
  limits: ChatLimits;
  canSpill: boolean;
}): DraftPart[] {
  const parts: DraftPart[] = [];
  const pending = input.continuation
    ? pendingContinuation(input.continuation, input.steps)
    : null;
  input.steps.forEach((step, i) => {
    const text =
      pending && i === pending.step && pending.text.trim()
        ? `${pending.text}${step.text}`.trim()
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

/**
 * A part before it is numbered. `framing` marks a spill's lead or closing
 * question: its artefact holds the same text.
 */
type PlanPart = ReplyContent & { framing?: boolean };

/**
 * Over the run's cap: merge the shortest neighbouring messages while the
 * result stays within `bubbleMax`, then drop spill framing, keeping the
 * reply's last part for as long as possible. Order is kept, and text that
 * exists nowhere else is never dropped: a reply with several documents, or a
 * long one without artefact storage, can stay over the cap.
 */
function capParts(parts: PlanPart[], limits: ChatLimits): ReplyContent[] {
  const out = [...parts];
  const merge = (): boolean => {
    let best = -1;
    let bestLength = Infinity;
    for (let i = 0; i + 1 < out.length; i++) {
      const a = out[i];
      const b = out[i + 1];
      if (a?.kind !== 'text' || b?.kind !== 'text') continue;
      const length = a.text.length + 2 + b.text.length;
      if (length <= limits.bubbleMax && length < bestLength) {
        best = i;
        bestLength = length;
      }
    }
    const a = out[best];
    const b = out[best + 1];
    if (a?.kind !== 'text' || b?.kind !== 'text') return false;
    out.splice(best, 2, {
      kind: 'text',
      text: `${a.text}\n\n${b.text}`,
      framing: a.framing === true && b.framing === true,
    });
    return true;
  };
  const dropFraming = (): boolean => {
    const framing = out.flatMap((part, i) => (part.framing ? [i] : []));
    const i = framing.find((index) => index < out.length - 1) ?? framing[0];
    if (i === undefined) return false;
    out.splice(i, 1);
    return true;
  };
  while (out.length > limits.maxPartsPerRun) {
    if (!merge() && !dropFraming()) break;
  }
  return out.map(
    (part): ReplyContent =>
      part.kind === 'text'
        ? { kind: 'text', text: part.text }
        : { kind: 'artifact', artifact: part.artifact },
  );
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
  const parts: PlanPart[] = [];
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
      if (part.spill.lead)
        parts.push({ kind: 'text', text: part.spill.lead, framing: true });
      parts.push({ kind: 'artifact', artifact: ref });
      if (part.spill.closing)
        parts.push({ kind: 'text', text: part.spill.closing, framing: true });
    } else {
      const shape = shapeStep(part.spill.markdown, options.limits, false);
      if (shape.kind === 'messages')
        parts.push(
          ...shape.messages.map((m) => ({ kind: 'text' as const, text: m })),
        );
    }
  }
  const capped = capParts(parts, options.limits);
  return {
    v: 1,
    parts: capped.map(
      (part, i): ReplyPart => ({ partId: `p${i + 1}`, ...part }),
    ),
  };
}

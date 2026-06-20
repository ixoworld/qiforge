/**
 * Plain-language step explanation (spec §3.6, `explain_step`). Read-only: it
 * describes what a step will do and the inputs it will run with, so the agent
 * can explain a step to the user before they run it. The action's diff resolver
 * (Appendix A.7) is a later enhancement — this version reports intent + inputs.
 */
import type { Doc as YDoc } from 'yjs';
import { describeAction } from './actions.js';
import { readFlowSpec } from './read.js';
import type { StepStatus } from './types.js';

export interface StepExplanation {
  willDo: string;
  action: string;
  inputs: Record<string, unknown>;
  requiresConfirmation: boolean;
  status?: StepStatus;
}

export function explainStep(
  doc: YDoc,
  ref: string,
  stepId: string,
): StepExplanation | null {
  const flow = readFlowSpec(doc, ref);
  const step = flow?.steps.find((s) => s.id === stepId);
  if (!step) return null;

  const description = describeAction(step.action);
  const summary = description?.summary?.trim();
  const willDo = summary
    ? summary
    : `Runs the "${step.action}" action${step.title ? ` (${step.title})` : ''}.`;

  return {
    willDo,
    action: step.action,
    inputs: step.inputs ?? {},
    requiresConfirmation:
      step.requireConfirmation ?? description?.requiresConfirmation ?? false,
    status: step.status,
  };
}

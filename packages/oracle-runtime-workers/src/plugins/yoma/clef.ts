import { z } from 'zod';

/**
 * Cloudflare's Clef decision models on Workers AI: a state and typed
 * questions in, a probability for every allowed answer out, never text.
 * Ported from the Yoma oracle (genu-survey-oracle `src/survey/clef.ts`, itself
 * from diagnostic-oracle). The runtime has no Workers AI binding of its own,
 * so the host passes a runner (`YomaPluginOptions.getClef`); without one the
 * judge falls back to option numbers and exact option text (`judge.ts`).
 *
 * Answer shapes as the model returned them on 2026-10-13:
 *
 *   noul    → { type: "noul", noul: 0.4531 }
 *   choice  → { type: "choice", choice: "option_2",
 *               probabilities: { option_1: 0.03, ... }, confidence: 0.06 }
 */

export const CLEF_MODEL = '@cf/cloudflare/clef';

export type ClefQuestion =
  | { type: 'noul'; instructions: string }
  | { type: 'choice'; instructions: string; criteria: Record<string, string> }
  | { type: 'score'; instructions: string; criteria: string[] };

export interface ClefRequest {
  model: 'clef' | 'clef-flash';
  state: unknown;
  questions: Record<string, ClefQuestion>;
}

const probabilities = z.record(z.string(), z.number().min(0).max(1));

const noulAnswer = z.object({
  type: z.literal('noul'),
  noul: z.number().min(0).max(1),
});
const choiceAnswer = z.object({
  type: z.literal('choice'),
  choice: z.string(),
  probabilities,
  confidence: z.number().optional(),
});
const scoreAnswer = z.object({
  type: z.literal('score'),
  score: z.number(),
  probabilities,
  legend: z.record(z.string(), z.string()).optional(),
  confidence: z.number().optional(),
});

export const clefResponseSchema = z.object({
  model: z.string(),
  answers: z.record(
    z.string(),
    z.discriminatedUnion('type', [noulAnswer, choiceAnswer, scoreAnswer]),
  ),
});

export type ClefResponse = z.infer<typeof clefResponseSchema>;
export type ClefNoulAnswer = z.infer<typeof noulAnswer>;
export type ClefChoiceAnswer = z.infer<typeof choiceAnswer>;

/** One call to a Clef model. Injected, so tests never reach Workers AI. */
export type ClefRunner = (request: ClefRequest) => Promise<ClefResponse>;

/** The slice of a Workers AI binding a Clef runner needs. */
export interface WorkersAiBinding {
  run(model: string, inputs: object): Promise<unknown>;
}

/**
 * A runner over a Workers AI binding, for hosts that have one (`env.AI`).
 * The answer is parsed strictly: one that is not the documented shape is an
 * error, which the judge turns into "unclear", never a guess.
 */
export function workersAiClefRunner(
  ai: WorkersAiBinding,
  model = CLEF_MODEL,
): ClefRunner {
  return async (request) => {
    const raw = await ai.run(model, request);
    return clefResponseSchema.parse(raw);
  };
}

export function noulOf(response: ClefResponse, id: string): ClefNoulAnswer {
  const answer = response.answers[id];
  if (answer?.type !== 'noul')
    throw new Error(`Clef returned no yes/no answer for "${id}"`);
  return answer;
}

export function choiceOf(response: ClefResponse, id: string): ClefChoiceAnswer {
  const answer = response.answers[id];
  if (answer?.type !== 'choice')
    throw new Error(`Clef returned no choice answer for "${id}"`);
  return answer;
}

/**
 * Which asks skill a message needs, as a bounded Decision (the engine the
 * capability router uses), so its text can be in the prompt before the first
 * model call. Fails open: an error, a timeout, a low confidence or "none"
 * picks nothing, and the model can still call `asks_skill`.
 */
import type {
  DecisionDefinition,
  DefineDecisionOptions,
  RuntimeContext,
} from '../../plugin-api';
import { z } from 'zod';
import type { Skill } from './skills';

export const NO_SKILL = '__no_asks_skill__';
export const MIN_SKILL_CONFIDENCE = 0.5;

const inputSchema = z.object({
  text: z.string().min(1),
  skills: z
    .array(z.object({ name: z.string().min(1), description: z.string() }))
    .min(1)
    .max(30),
});

/** Passed through the runtime's `defineDecision` by the plugin (a value import tests can't load). */
export const asksSkillDecisionOptions: DefineDecisionOptions<
  typeof inputSchema
> = {
  name: 'asks.pick-skill',
  version: '1.0.0',
  description:
    'Pick the asks.world skill, if any, a user message needs before the first model call.',
  // Ahead of the first model call: a slow verdict costs more than a missed preload.
  timeoutMs: 2_000,
  inputSchema,
  project(input) {
    return {
      state: { message: input.text },
      questions: {
        skill: {
          kind: 'choice',
          instructions:
            'Which of these asks.world skills, if any, does this message need?',
          options: {
            ...Object.fromEntries(
              input.skills.map((one) => [
                one.name,
                one.description || one.name,
              ]),
            ),
            [NO_SKILL]: 'None of them: the message needs no asks skill.',
          },
        },
      },
    };
  },
};

export type AsksSkillDecision = DecisionDefinition<typeof inputSchema>;

export async function pickSkill(
  decisions: RuntimeContext['decisions'],
  definition: AsksSkillDecision,
  text: string,
  skills: readonly Skill[],
  signal?: AbortSignal,
): Promise<Skill | null> {
  if (!text.trim() || skills.length === 0) return null;
  try {
    const evaluation = await decisions.evaluate(
      definition,
      {
        text: text.slice(0, 4_000),
        skills: skills
          .slice(0, 30)
          .map(({ name, description }) => ({ name, description })),
      },
      signal ? { signal } : undefined,
    );
    const answer = evaluation.answers.skill;
    if (answer?.kind !== 'choice' || answer.confidence < MIN_SKILL_CONFIDENCE)
      return null;
    return skills.find((one) => one.name === answer.value) ?? null;
  } catch {
    return null;
  }
}

/** The text of the last human message in a model request. */
export function lastHumanText(messages: readonly unknown[]): string {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const message = messages[i] as {
      getType?: () => string;
      type?: string;
      content?: unknown;
    };
    const type =
      typeof message.getType === 'function' ? message.getType() : message.type;
    if (type !== 'human') continue;
    const { content } = message;
    if (typeof content === 'string') return content;
    if (Array.isArray(content))
      return content
        .map((part: { type?: string; text?: unknown }) =>
          part.type === 'text' && typeof part.text === 'string'
            ? part.text
            : '',
        )
        .join('\n');
    return '';
  }
  return '';
}

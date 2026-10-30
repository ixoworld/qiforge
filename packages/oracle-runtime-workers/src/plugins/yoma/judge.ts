import { choiceOf, noulOf, type ClefRequest, type ClefRunner } from './clef';

/**
 * What a person's reply to a choice question means: which option, or
 * options, it picks, or that it is unclear. Clef decides when the host gave
 * a runner; the chat model never picks the option itself. Ported from the
 * Yoma oracle's survey judge (genu-survey-oracle `src/survey/judge.ts`) with
 * wording that fits any form.
 *
 * Without Clef, or when Clef fails, only an option number ("2") or the exact
 * option text counts; anything else is unclear, so the model asks again
 * with the numbered options.
 */

/** At or above this, a choice is taken as the person's answer. */
export const ACCEPT_THRESHOLD = 0.7;
/** Between this and the accept threshold, a checkbox option is asked about. */
export const MAYBE_THRESHOLD = 0.3;
/** At or above this, a write-in ("Other") reads as a genuine answer. */
export const GENUINE_THRESHOLD = 0.6;
/** Longest wait for Clef: past it the reply is read literally (a chat turn must not hang on it). */
export const CLEF_TIMEOUT_MS = 4_500;

export interface ChoiceQuestion {
  title: string;
  description?: string;
  /** Checkbox (pick one or more) rather than single choice. */
  multiple: boolean;
  /** The options as shown and numbered, in form order; special items ("None", "Don't know") last. */
  options: string[];
  /** Checkbox options picked only on their own ("None", "Refuse to answer", "Don't know"), by index. */
  exclusive?: number[];
  otherAllowed: boolean;
}

export type Judgement =
  | {
      status: 'accepted';
      /** Indexes into the options, in form order; a write-in is `otherText`. */
      picked: number[];
      /** The person's own answer, when it is none of the options. */
      otherText?: string;
      /** How the answer was read. */
      by: 'clef' | 'number' | 'text';
    }
  | {
      status: 'unclear';
      /** What to clear up, in plain words for the chat model. */
      reason: string;
      /** The options Clef leaned towards, most likely first. */
      candidates?: string[];
    };

const optionKey = (index: number) => `option_${index + 1}`;

const UNCLEAR_CRITERION =
  'The reply does not clearly pick one answer: it is off-topic, a question back, a refusal, a joke, or it fits two options equally.';

function questionState(q: ChoiceQuestion, reply: string, otherText?: string) {
  return {
    question: q.title,
    ...(q.description ? { hint: q.description } : {}),
    optionsShownToThePerson: q.options.map((o, i) => `${i + 1}. ${o}`),
    reply,
    ...(otherText ? { writeIn: otherText } : {}),
    howPeopleAnswer:
      'The person answers in a chat. They may reply with an option number, with words from an option, in their own words, in slang, or in another language.',
  };
}

/** The Clef request for a single-choice reply. Exported for tests. */
export function singleChoiceRequest(
  q: ChoiceQuestion,
  reply: string,
  otherText?: string,
): ClefRequest {
  const criteria: Record<string, string> = {};
  q.options.forEach((option, index) => {
    criteria[optionKey(index)] = `Option ${index + 1}: "${option}"`;
  });
  if (q.otherAllowed)
    criteria.other =
      'A different answer of their own that matches none of the listed options.';
  criteria.unclear = UNCLEAR_CRITERION;
  return {
    model: 'clef',
    state: questionState(q, reply, otherText),
    questions: {
      answer: {
        type: 'choice',
        instructions: `Which answer to "${q.title}" does the person's reply give?`,
        criteria,
      },
      ...(q.otherAllowed
        ? {
            genuine_write_in: {
              type: 'noul' as const,
              instructions:
                'If the person gives an answer of their own instead of a listed option, is it a genuine, on-topic answer to the question (not junk, abuse or a joke)?',
            },
          }
        : {}),
    },
  };
}

/** The Clef request for a checkbox reply: one yes/no per option. Exported for tests. */
export function multiChoiceRequest(
  q: ChoiceQuestion,
  reply: string,
  otherText?: string,
): ClefRequest {
  const questions: ClefRequest['questions'] = {};
  q.options.forEach((option, index) => {
    questions[optionKey(index)] = {
      type: 'noul',
      instructions: `Does the reply say the person picks option ${index + 1}, "${option}"?`,
    };
  });
  if (q.otherAllowed) {
    questions.other = {
      type: 'noul',
      instructions:
        'Does the reply name something of their own that is not in the list?',
    };
    questions.genuine_write_in = {
      type: 'noul',
      instructions:
        'If the reply names something of their own, is it a genuine, on-topic answer to the question (not junk, abuse or a joke)?',
    };
  }
  return {
    model: 'clef',
    state: questionState(q, reply, otherText),
    questions,
  };
}

const ranked = (probabilities: Record<string, number>) =>
  Object.entries(probabilities).sort((a, b) => b[1] - a[1]);

function judgeSingle(
  q: ChoiceQuestion,
  response: Awaited<ReturnType<ClefRunner>>,
  reply: string,
  otherText?: string,
): Judgement {
  const answer = choiceOf(response, 'answer');
  const order = ranked(answer.probabilities);
  const [topKey, topP] = order[0] ?? [answer.choice, 0];
  const indexOf = (key: string) => Number(key.slice('option_'.length)) - 1;
  const candidates = order
    .filter(([key]) => key.startsWith('option_'))
    .slice(0, 2)
    .map(([key]) => q.options[indexOf(key)])
    .filter((o): o is string => o !== undefined);
  if (topKey.startsWith('option_') && topP >= ACCEPT_THRESHOLD) {
    const index = indexOf(topKey);
    if (q.options[index] !== undefined)
      return { status: 'accepted', picked: [index], by: 'clef' };
  }
  if (topKey === 'other' && topP >= ACCEPT_THRESHOLD && q.otherAllowed) {
    if (noulOf(response, 'genuine_write_in').noul >= GENUINE_THRESHOLD)
      return {
        status: 'accepted',
        picked: [],
        otherText: (otherText ?? reply).trim(),
        by: 'clef',
      };
    return {
      status: 'unclear',
      reason:
        'Their own answer did not read as a genuine answer to this question. Ask again, or offer the options.',
    };
  }
  return {
    status: 'unclear',
    reason:
      topKey === 'unclear'
        ? 'The reply does not clearly answer this question. Ask it again in simpler words.'
        : 'The reply could mean more than one option. Ask which one they mean.',
    ...(candidates.length ? { candidates } : {}),
  };
}

function judgeMulti(
  q: ChoiceQuestion,
  response: Awaited<ReturnType<ClefRunner>>,
  otherText?: string,
): Judgement {
  const picked: number[] = [];
  const maybe: string[] = [];
  q.options.forEach((option, index) => {
    const p = noulOf(response, optionKey(index)).noul;
    if (p >= ACCEPT_THRESHOLD) picked.push(index);
    else if (p >= MAYBE_THRESHOLD) maybe.push(option);
  });
  const namesOther = q.otherAllowed
    ? noulOf(response, 'other').noul >= ACCEPT_THRESHOLD
    : false;
  if (maybe.length)
    return {
      status: 'unclear',
      reason:
        'Some options were mentioned but not clearly picked. Ask about these.',
      candidates: maybe,
    };
  const alone = aloneConflict(q, picked, namesOther);
  if (alone) return alone;
  if (namesOther) {
    if (!otherText?.trim())
      return {
        status: 'unclear',
        reason:
          'They named something not in the list. Ask them to name it, then pass it as otherText.',
      };
    if (noulOf(response, 'genuine_write_in').noul < GENUINE_THRESHOLD)
      return {
        status: 'unclear',
        reason:
          'What they wrote in did not read as a genuine answer. Ask them to name it again, or to leave it out.',
      };
    return {
      status: 'accepted',
      picked,
      otherText: otherText.trim(),
      by: 'clef',
    };
  }
  if (!picked.length)
    return {
      status: 'unclear',
      reason:
        'No option was clearly picked. Ask again; they can pick more than one.',
    };
  return { status: 'accepted', picked, by: 'clef' };
}

/** A checkbox pick that combines an only-on-its-own option ("None") with others. */
function aloneConflict(
  q: ChoiceQuestion,
  picked: number[],
  withOther = false,
): Judgement | undefined {
  const exclusive = picked.find((index) => q.exclusive?.includes(index));
  if (exclusive === undefined || (picked.length === 1 && !withOther))
    return undefined;
  return {
    status: 'unclear',
    reason: `"${q.options[exclusive]}" goes on its own, but the reply also picks other options. Ask which is right.`,
    candidates: picked.map((index) => q.options[index]!),
  };
}

/**
 * Without Clef: the exact option text (any case), or option numbers ("2",
 * "1, 3") by position. When options are themselves numbers ("1", "5", "10")
 * a typed number is only ever read as that option's text, never as a
 * position. Anything else is unclear.
 */
export function judgeLiterally(q: ChoiceQuestion, reply: string): Judgement {
  const norm = (text: string) => text.trim().toLowerCase();
  const text = norm(reply);
  const exact = q.options.findIndex((o) => norm(o) === text);
  if (exact >= 0) return { status: 'accepted', picked: [exact], by: 'text' };
  const tokens = text.split(/[\s,;&]+|\band\b/).filter(Boolean);
  const numericOptions = q.options.some((o) =>
    /^-?\d+([.,]\d+)?$/.test(norm(o)),
  );
  if (
    tokens.length &&
    tokens.every((n) => /^\d{1,3}$/.test(n)) &&
    (q.multiple || tokens.length === 1)
  ) {
    const picked = tokens.map((n) =>
      numericOptions
        ? q.options.findIndex((o) => norm(o) === n)
        : Number(n) - 1,
    );
    if (picked.every((index) => q.options[index] !== undefined)) {
      const unique = [...new Set(picked)];
      return (
        aloneConflict(q, unique) ?? {
          status: 'accepted',
          picked: unique,
          by: numericOptions ? 'text' : 'number',
        }
      );
    }
  }
  return {
    status: 'unclear',
    reason:
      'Ask again with the options as a numbered list; they can answer with the number.',
  };
}

/** Clef's answer, or `timeout` when the tool's deadline comes first. */
function withinDeadline<T>(
  work: Promise<T>,
  deadline: number,
  signal: AbortSignal,
): Promise<T | 'timeout'> {
  const left = deadline - Date.now();
  if (left <= 0) return Promise.resolve('timeout');
  let timer: ReturnType<typeof setTimeout> | undefined;
  let onAbort: (() => void) | undefined;
  const timeout = new Promise<'timeout'>((resolve, reject) => {
    timer = setTimeout(() => resolve('timeout'), left);
    onAbort = () =>
      reject(
        signal.reason instanceof Error
          ? signal.reason
          : new DOMException('Aborted', 'AbortError'),
      );
    signal.addEventListener('abort', onAbort, { once: true });
  });
  return Promise.race([work, timeout]).finally(() => {
    clearTimeout(timer);
    if (onAbort) signal.removeEventListener('abort', onAbort);
  });
}

/**
 * What a reply means for one choice question. Clef first when the host
 * gave a runner; an option number or the exact option text is taken
 * without it. Clef is given {@link CLEF_TIMEOUT_MS} (less when the tool's
 * deadline is nearer): a failure or a late answer reads the reply literally. Only the turn's own abort is rethrown.
 */
export async function judgeChoice(
  clef: ClefRunner | undefined,
  q: ChoiceQuestion,
  reply: string,
  otherText: string | undefined,
  limits: { signal: AbortSignal; deadline: number },
): Promise<Judgement & { clefFailed?: true }> {
  const literal = judgeLiterally(q, reply);
  if (literal.status === 'accepted') return literal;
  if (!clef) return literal;
  try {
    const response = await withinDeadline(
      clef(
        q.multiple
          ? multiChoiceRequest(q, reply, otherText)
          : singleChoiceRequest(q, reply, otherText),
      ),
      Math.min(limits.deadline, Date.now() + CLEF_TIMEOUT_MS),
      limits.signal,
    );
    if (response === 'timeout') return { ...literal, clefFailed: true };
    return q.multiple
      ? judgeMulti(q, response, otherText)
      : judgeSingle(q, response, reply, otherText);
  } catch (error) {
    if (limits.signal.aborted) throw error;
    return { ...literal, clefFailed: true };
  }
}

import type {
  ChoiceDecisionAnswer,
  DecisionAnswer,
  DecisionProviderResult,
  DecisionQuestion,
  DecisionRequest,
  OrdinalDecisionAnswer,
} from './types.js';

export interface DecisionLimits {
  maxQuestions: number;
  maxChoiceOptions: number;
  maxOrdinalLevels: number;
  maxStateBytes: number;
}

export const DEFAULT_DECISION_LIMITS: DecisionLimits = {
  maxQuestions: 16,
  maxChoiceOptions: 32,
  // The Jev Score question type accepts 2..10 levels; the default limit mirrors
  // the lowest common denominator across supported providers so a decision
  // that validates locally is accepted by every adapter.
  maxOrdinalLevels: 10,
  maxStateBytes: 64 * 1024,
};

const PROBABILITY_SUM_TOLERANCE = 0.05;

export function validateDecisionRequest(
  request: DecisionRequest,
  limits: DecisionLimits = DEFAULT_DECISION_LIMITS,
): void {
  if (!request || typeof request !== 'object') {
    throw new Error('Decision request must be an object.');
  }

  const questionEntries = Object.entries(request.questions ?? {});
  if (questionEntries.length === 0) {
    throw new Error('Decision request must contain at least one question.');
  }
  if (questionEntries.length > limits.maxQuestions) {
    throw new Error(
      `Decision request has ${questionEntries.length} questions; maximum is ${limits.maxQuestions}.`,
    );
  }

  for (const [key, question] of questionEntries) {
    validateQuestion(key, question, limits);
  }

  let serialized: string;
  try {
    const json = JSON.stringify(request.state);
    if (json === undefined) {
      throw new Error('Decision state must be JSON-serializable.');
    }
    serialized = json;
  } catch {
    throw new Error('Decision state must be JSON-serializable.');
  }

  const bytes = new TextEncoder().encode(serialized).byteLength;
  if (bytes > limits.maxStateBytes) {
    throw new Error(
      `Decision state is ${bytes} bytes; maximum is ${limits.maxStateBytes}.`,
    );
  }
}

/**
 * Validates a provider result against the request it answers and returns a
 * normalized copy. The input is never mutated.
 *
 * Normalization is limited to probability maps: declared options or levels
 * the provider left out are filled with 0. A missing entry means the provider
 * assigned no mass to that outcome, so filling it with 0 makes the omission
 * explicit rather than inventing an answer. Keys that were never declared
 * still fail validation.
 */
export function validateDecisionProviderResult(
  request: DecisionRequest,
  result: DecisionProviderResult,
): DecisionProviderResult {
  if (!result || typeof result !== 'object') {
    throw new Error('Decision provider result must be an object.');
  }

  const expectedKeys = Object.keys(request.questions);
  const answerKeys = Object.keys(result.answers ?? {});

  const missing = expectedKeys.filter((key) => !answerKeys.includes(key));
  const extra = answerKeys.filter((key) => !expectedKeys.includes(key));
  if (missing.length > 0 || extra.length > 0) {
    throw new Error(
      `Decision provider answer keys do not match questions. Missing: ${missing.join(', ') || 'none'}; extra: ${extra.join(', ') || 'none'}.`,
    );
  }

  const answers: Record<string, DecisionAnswer> = {};
  for (const key of expectedKeys) {
    const question = request.questions[key]!;
    const answer = result.answers[key]!;
    answers[key] = validateAnswer(key, question, answer);
  }

  return {
    ...result,
    answers,
  };
}

function validateQuestion(
  key: string,
  question: DecisionQuestion,
  limits: DecisionLimits,
): void {
  if (!key.trim()) {
    throw new Error('Decision question keys must be non-empty.');
  }
  if (!question.instructions?.trim()) {
    throw new Error(`Decision question "${key}" must include instructions.`);
  }

  if (question.kind === 'choice') {
    const optionEntries = Object.entries(question.options);
    if (optionEntries.length < 2) {
      throw new Error(
        `Decision choice question "${key}" must contain at least two options.`,
      );
    }
    if (optionEntries.length > limits.maxChoiceOptions) {
      throw new Error(
        `Decision choice question "${key}" has ${optionEntries.length} options; maximum is ${limits.maxChoiceOptions}.`,
      );
    }
    for (const [option, description] of optionEntries) {
      if (!option.trim() || !description.trim()) {
        throw new Error(
          `Decision choice question "${key}" has an empty option or description.`,
        );
      }
    }
  }

  if (question.kind === 'ordinal') {
    if (question.levels.length < 2) {
      throw new Error(
        `Decision ordinal question "${key}" must contain at least two levels.`,
      );
    }
    if (question.levels.length > limits.maxOrdinalLevels) {
      throw new Error(
        `Decision ordinal question "${key}" has ${question.levels.length} levels; maximum is ${limits.maxOrdinalLevels}.`,
      );
    }
    if (question.levels.some((level) => !level.trim())) {
      throw new Error(
        `Decision ordinal question "${key}" contains an empty level.`,
      );
    }
  }
}

function validateAnswer(
  key: string,
  question: DecisionQuestion,
  answer: DecisionAnswer,
): DecisionAnswer {
  if (question.kind === 'boolean' && answer.kind === 'boolean') {
    assertProbability(answer.probabilityTrue, `${key}.probabilityTrue`);
    return { ...answer };
  }

  if (question.kind === 'choice' && answer.kind === 'choice') {
    assertProbability(answer.confidence, `${key}.confidence`);
    return validateChoiceAnswer(key, question.options, answer);
  }

  if (question.kind === 'ordinal' && answer.kind === 'ordinal') {
    assertProbability(answer.confidence, `${key}.confidence`);
    return validateOrdinalAnswer(key, question.levels.length, answer);
  }

  throw new Error(
    `Decision answer "${key}" kind "${answer.kind}" does not match question kind "${question.kind}".`,
  );
}

function validateChoiceAnswer(
  key: string,
  options: Record<string, string>,
  answer: ChoiceDecisionAnswer,
): ChoiceDecisionAnswer {
  if (!Object.prototype.hasOwnProperty.call(options, answer.value)) {
    throw new Error(
      `Decision choice answer "${key}" selected unknown option "${answer.value}".`,
    );
  }

  const probabilities = normalizeProbabilityMap(
    Object.keys(options),
    answer.probabilities,
    () =>
      new Error(
        `Decision choice answer "${key}" probabilities do not match options.`,
      ),
  );
  validateProbabilityMap(`${key}.probabilities`, probabilities);
  return { ...answer, probabilities };
}

function validateOrdinalAnswer(
  key: string,
  levelCount: number,
  answer: OrdinalDecisionAnswer,
): OrdinalDecisionAnswer {
  if (
    !Number.isFinite(answer.score) ||
    answer.score < 0 ||
    answer.score > levelCount - 1
  ) {
    throw new Error(
      `Decision ordinal answer "${key}" score ${answer.score} is outside 0..${levelCount - 1}.`,
    );
  }
  if (!answer.probabilities) {
    return { ...answer };
  }

  const expected = Array.from({ length: levelCount }, (_, index) =>
    String(index),
  );
  const probabilities = normalizeProbabilityMap(
    expected,
    answer.probabilities,
    () =>
      new Error(
        `Decision ordinal answer "${key}" probabilities do not match levels.`,
      ),
  );
  validateProbabilityMap(`${key}.probabilities`, probabilities);
  return { ...answer, probabilities };
}

/**
 * Returns a probability map keyed by exactly the declared keys: omitted keys
 * become 0, undeclared keys are rejected via `onUnknownKey`.
 */
function normalizeProbabilityMap(
  declaredKeys: string[],
  probabilities: Record<string, number>,
  onUnknownKey: () => Error,
): Record<string, number> {
  const returned = Object.keys(probabilities);
  if (returned.some((entry) => !declaredKeys.includes(entry))) {
    throw onUnknownKey();
  }
  return Object.fromEntries(
    declaredKeys.map((entry) => [
      entry,
      Object.prototype.hasOwnProperty.call(probabilities, entry)
        ? probabilities[entry]!
        : 0,
    ]),
  );
}

function validateProbabilityMap(
  label: string,
  probabilities: Record<string, number>,
): void {
  const values = Object.values(probabilities);
  if (values.length === 0) {
    throw new Error(`Decision probability map "${label}" must not be empty.`);
  }
  for (const [key, value] of Object.entries(probabilities)) {
    assertProbability(value, `${label}.${key}`);
  }
  const sum = values.reduce((total, value) => total + value, 0);
  if (Math.abs(sum - 1) > PROBABILITY_SUM_TOLERANCE) {
    throw new Error(
      `Decision probability map "${label}" sums to ${sum}; expected approximately 1.`,
    );
  }
}

function assertProbability(value: number, label: string): void {
  if (!Number.isFinite(value) || value < 0 || value > 1) {
    throw new Error(
      `Decision probability "${label}" must be a finite number from 0 to 1.`,
    );
  }
}

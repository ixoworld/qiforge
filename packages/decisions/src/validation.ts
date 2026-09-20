import { z } from 'zod';
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
  maxOrdinalLevels: 16,
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

  if (!z.json().safeParse(request.state).success) {
    throw new Error('Decision state must contain only JSON values.');
  }
  if (
    new TextEncoder().encode(JSON.stringify(request)).byteLength >
    128 * 1024
  ) {
    throw new Error('Decision request exceeds the 128KiB limit.');
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

export function validateDecisionProviderResult(
  request: DecisionRequest,
  result: DecisionProviderResult,
): void {
  if (!result || typeof result !== 'object') {
    throw new Error('Decision provider result must be an object.');
  }

  const expectedKeys = Object.keys(request.questions);
  const answerKeys = Object.keys(result.answers ?? {});

  const missing = expectedKeys.filter((key) => !answerKeys.includes(key));
  const extra = answerKeys.filter((key) => !expectedKeys.includes(key));
  if (missing.length > 0 || extra.length > 0) {
    throw new Error(
      `Decision provider answer keys do not match questions. Missing or unexpected answers.`,
    );
  }

  for (const key of expectedKeys) {
    const question = request.questions[key]!;
    const answer = result.answers[key]!;
    validateAnswer(key, question, answer);
  }
}

function validateQuestion(
  key: string,
  question: DecisionQuestion,
  limits: DecisionLimits,
): void {
  if (!question || !['boolean', 'choice', 'ordinal'].includes(question.kind)) {
    throw new Error('Decision question kind is invalid.');
  }
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
): void {
  if (!answer || answer.kind !== question.kind) {
    throw new Error('Decision answer kind does not match its question.');
  }

  if (answer.kind === 'boolean') {
    assertProbability(answer.probabilityTrue, `${key}.probabilityTrue`);
    return;
  }

  assertProbability(answer.confidence, `${key}.confidence`);

  if (answer.kind === 'choice' && question.kind === 'choice') {
    validateChoiceAnswer(key, question.options, answer);
    return;
  }

  if (answer.kind === 'ordinal' && question.kind === 'ordinal') {
    validateOrdinalAnswer(key, question.levels.length, answer);
  }
}

function validateChoiceAnswer(
  key: string,
  options: Record<string, string>,
  answer: ChoiceDecisionAnswer,
): void {
  if (!Object.prototype.hasOwnProperty.call(options, answer.value)) {
    throw new Error(`Decision choice answer "${key}" selected unknown option.`);
  }

  const expected = Object.keys(options);
  const returned = Object.keys(answer.probabilities);
  const missing = expected.filter((option) => !returned.includes(option));
  const extra = returned.filter((option) => !expected.includes(option));
  if (missing.length > 0 || extra.length > 0) {
    throw new Error(
      `Decision choice answer "${key}" probabilities do not match options.`,
    );
  }
  validateProbabilityMap(`${key}.probabilities`, answer.probabilities);
}

function validateOrdinalAnswer(
  key: string,
  levelCount: number,
  answer: OrdinalDecisionAnswer,
): void {
  if (
    !Number.isFinite(answer.score) ||
    answer.score < 0 ||
    answer.score > levelCount - 1
  ) {
    throw new Error(
      `Decision ordinal answer "${key}" score is outside 0..${levelCount - 1}.`,
    );
  }
  if (answer.probabilities) {
    const expected = Array.from({ length: levelCount }, (_, index) =>
      String(index),
    );
    const returned = Object.keys(answer.probabilities);
    const missing = expected.filter((level) => !returned.includes(level));
    const extra = returned.filter((level) => !expected.includes(level));
    if (missing.length > 0 || extra.length > 0) {
      throw new Error(
        `Decision ordinal answer "${key}" probabilities do not match levels.`,
      );
    }
    validateProbabilityMap(`${key}.probabilities`, answer.probabilities);
  }
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

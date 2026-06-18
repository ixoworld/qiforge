/**
 * Form read/fill (spec §2.5, §7.2). The agent can read a human form step's
 * questions and PRE-FILL answers; it never submits — the user reviews and
 * submits in the portal.
 *
 * Verified shape: the survey schema lives in `block.props.surveySchema` (a
 * JSON-stringified SurveyJS schema); the answers persist in the RUNTIME map at
 * `runtime.output.form.answers` (a JSON string). Filling writes that runtime
 * field and deliberately does NOT set `state:'completed'` (submission is the
 * user's action). We reuse the editor plugin's native survey + runtime helpers.
 */
import type { Doc as YDoc } from 'yjs';
import {
  extractBlockProperties,
  getBlockDetail,
  readRuntimeState,
  updateRuntimeState,
} from '../editor/blocknote-helper.js';
import {
  parseSurveySchema,
  type SurveySchema,
  type SurveyElement,
} from '../editor/survey-helpers.js';
import { FlowError } from './errors.js';
import { stepIdToBlockId } from './translator.js';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}
function isSurveySchema(value: unknown): value is SurveySchema {
  return isRecord(value) && Array.isArray(value.pages);
}

export interface FormQuestion {
  name: string;
  type: string;
  title?: string;
  isRequired: boolean;
  /** Allowed values for choice questions — the agent must fill the value, not the label. */
  choices?: Array<{ value: string; text: string }>;
  visibleIf?: string;
}

export interface FillFormResult {
  applied: string[];
  rejected: Array<{ name: string; reason: string }>;
  validation: { ok: boolean; warnings: string[] };
}

function readSurveySchema(
  doc: YDoc,
  stepId: string,
): { blockId: string; questions: FormQuestion[] } {
  const blockId = stepIdToBlockId(stepId);
  const detail = getBlockDetail(doc, blockId);
  if (!detail)
    throw new FlowError('step_not_found', `No step "${stepId}" in this flow.`);
  const raw = extractBlockProperties(detail).surveySchema;

  // `extractBlockProperties` parses surveySchema to an object; fall back to a raw string.
  let schema: SurveySchema | null = null;
  if (isSurveySchema(raw)) schema = raw;
  else if (typeof raw === 'string' && raw.length > 0)
    schema = parseSurveySchema(raw);
  else
    throw new FlowError(
      'validation_failed',
      `Step "${stepId}" has no form to fill.`,
    );
  if (!schema)
    throw new FlowError(
      'validation_failed',
      `Step "${stepId}"'s form schema is malformed.`,
    );

  return { blockId, questions: flattenQuestions(schema.pages ?? []) };
}

/** Flatten SurveyJS pages -> questions, descending into panels (which carry nested elements). */
function flattenQuestions(
  pages: Array<{ elements?: SurveyElement[] }>,
): FormQuestion[] {
  const out: FormQuestion[] = [];
  const visit = (elements: SurveyElement[] | undefined): void => {
    for (const el of elements ?? []) {
      if (el.elements || el.templateElements) {
        visit(el.elements);
        visit(el.templateElements);
        continue;
      }
      out.push({
        name: el.name,
        type: el.type,
        title: el.title,
        isRequired: el.isRequired ?? false,
        choices: el.choices,
        visibleIf: el.visibleIf,
      });
    }
  };
  for (const page of pages) visit(page.elements);
  return out;
}

/** Read a form step's questions with their exact fillable values. */
export function describeForm(
  doc: YDoc,
  stepId: string,
): { questions: FormQuestion[] } {
  const { questions } = readSurveySchema(doc, stepId);
  return { questions };
}

/** Existing form answers from the runtime map (if any). */
function existingAnswers(doc: YDoc, blockId: string): Record<string, unknown> {
  const runtime = readRuntimeState(doc, blockId)[blockId];
  const output =
    runtime && typeof runtime.output === 'object'
      ? (runtime.output as Record<string, unknown>)
      : undefined;
  const form =
    output && typeof output.form === 'object'
      ? (output.form as Record<string, unknown>)
      : undefined;
  if (typeof form?.answers !== 'string') return {};
  try {
    const parsed: unknown = JSON.parse(form.answers);
    return parsed && typeof parsed === 'object'
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

/**
 * Pre-fill a form step's answers. Validates against the schema (choice questions
 * accept only declared values), writes `runtime.output.form.answers`, and never
 * marks the step complete. `merge` (default true) keeps existing answers.
 */
export function fillForm(
  doc: YDoc,
  stepId: string,
  answers: Record<string, unknown>,
  merge = true,
): FillFormResult {
  const { blockId, questions } = readSurveySchema(doc, stepId);
  const byName = new Map(questions.map((q) => [q.name, q]));

  const applied: string[] = [];
  const rejected: Array<{ name: string; reason: string }> = [];
  const accepted: Record<string, unknown> = {};

  for (const [name, value] of Object.entries(answers)) {
    const question = byName.get(name);
    if (!question) {
      rejected.push({ name, reason: 'no such question' });
      continue;
    }
    if (question.choices && question.choices.length > 0) {
      const allowed = question.choices.map((c) => c.value);
      const values = Array.isArray(value) ? value : [value];
      const bad = values.find((v) => !allowed.includes(String(v)));
      if (bad !== undefined) {
        rejected.push({
          name,
          reason: `"${String(bad)}" is not an allowed value`,
        });
        continue;
      }
    }
    accepted[name] = value;
    applied.push(name);
  }

  const base = merge ? existingAnswers(doc, blockId) : {};
  const finalAnswers = { ...base, ...accepted };

  doc.transact(() => {
    const runtime = readRuntimeState(doc, blockId)[blockId] ?? {};
    const output =
      runtime.output && typeof runtime.output === 'object'
        ? (runtime.output as Record<string, unknown>)
        : {};
    const form =
      output.form && typeof output.form === 'object'
        ? (output.form as Record<string, unknown>)
        : {};
    // Write answers only — never set state:'completed' (that is the user's submit).
    updateRuntimeState(doc, blockId, {
      output: {
        ...output,
        form: { ...form, answers: JSON.stringify(finalAnswers) },
      },
    });
  });

  const requiredMissing = questions
    .filter((q) => q.isRequired && !(q.name in finalAnswers))
    .map((q) => q.name);
  const warnings =
    requiredMissing.length > 0
      ? [`Required questions still unanswered: ${requiredMissing.join(', ')}`]
      : [];

  return {
    applied,
    rejected,
    validation: { ok: rejected.length === 0, warnings },
  };
}

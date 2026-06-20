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
import { type SurveyElement } from '../editor/survey-helpers.js';
import { setStepInputs } from './edit.js';
import { FlowError } from './errors.js';
import { inferPortType } from './port-types.js';
import { readStep } from './read.js';
import { stepIdToBlockId } from './translator.js';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function safeParseObject(value: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    return undefined;
  }
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
  const props = extractBlockProperties(detail);

  // The schema location differs by form mechanism: the `form` block stores it at
  // top-level `surveySchema`; the `qi/human.form.submit` action stores it inside
  // `inputs.surveySchema`. Check both. (`extractBlockProperties` may auto-parse a
  // JSON prop to an object, so a value can arrive as an object or a string.)
  let raw: unknown = props.surveySchema;
  if (raw === undefined || raw === null || raw === '') {
    const inputs = props.inputs;
    const parsedInputs =
      typeof inputs === 'string' ? safeParseObject(inputs) : inputs;
    if (isRecord(parsedInputs)) raw = parsedInputs.surveySchema;
  }
  if (typeof raw === 'string' && raw.length > 0) raw = safeParseObject(raw);

  if (!isRecord(raw))
    throw new FlowError(
      'validation_failed',
      `Step "${stepId}" has no form to fill.`,
    );

  // Accept either the pages form (`{ pages: [{ elements }] }`) or the flat
  // elements form (`{ elements }`) — SurveyJS renders both.
  const pages = Array.isArray(raw.pages)
    ? raw.pages
    : Array.isArray(raw.elements)
      ? [{ elements: raw.elements }]
      : [];
  return { blockId, questions: flattenQuestions(pages) };
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

/** One referenceable output a form step exposes downstream. */
export interface FormOutputField {
  field: string;
  type: string;
}

/**
 * The output fields a form step exposes for downstream references. A form emits
 * a single bundled output, NOT a field per question:
 *  - `answers` — the whole answers object,
 *  - `form.answers` — that object as a JSON string (matches the form block's
 *    runtime output shape).
 * Plus, for each question, the load-bearing individual runtime path
 * `answers.<questionName>`. A scalar input (e.g. a DID for `matrix.dm.targetDid`)
 * MUST reference the single field — wiring the whole `answers` object stringifies
 * to "[object Object]" at runtime. The per-question paths resolve because the
 * form action's `run()` returns `answers` as a real object.
 *
 * Returns just the two bundle fields when the step has no readable survey schema
 * yet (so callers still get a usable answer for an unconfigured form step).
 */
export function formOutputFields(doc: YDoc, stepId: string): FormOutputField[] {
  const fields: FormOutputField[] = [
    { field: 'answers', type: 'object' },
    { field: 'form.answers', type: 'string' },
  ];
  let questions: FormQuestion[];
  try {
    questions = readSurveySchema(doc, stepId).questions;
  } catch {
    return fields;
  }
  for (const q of questions) {
    fields.push({ field: `answers.${q.name}`, type: inferPortType(q.name) });
  }
  return fields;
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

// ── Authoring a form's questions (build time) ───────────────────────────────

/** One question the agent wants on a form (friendly shape — no SurveyJS internals). */
export interface FormQuestionInput {
  /** The answer key this question produces (referenced downstream as output.<name>). */
  name: string;
  /** The question text shown to the user (defaults to the name). */
  label?: string;
  /**
   * Question type. Common SurveyJS types: text (default), comment (multi-line),
   * dropdown, radiogroup, checkbox (multi-select), boolean, rating.
   */
  type?: string;
  required?: boolean;
  /** Allowed options for choice questions (dropdown/radiogroup/checkbox). */
  choices?: string[];
}

/** Build a SurveyJS schema (pages form) from friendly questions. */
function buildSurveyJs(questions: FormQuestionInput[]): {
  pages: Array<{ name: string; elements: Array<Record<string, unknown>> }>;
} {
  return {
    pages: [
      {
        name: 'page1',
        elements: questions.map((q) => {
          const element: Record<string, unknown> = {
            type: q.type && q.type.length > 0 ? q.type : 'text',
            name: q.name,
            title: q.label ?? q.name,
          };
          if (q.required) element.isRequired = true;
          if (q.choices && q.choices.length > 0)
            element.choices = q.choices.map((c) => ({ value: c, text: c }));
          return element;
        }),
      },
    ],
  };
}

/**
 * Author a form step's questions. Builds a SurveyJS schema from the friendly
 * questions and writes it to the step's `surveySchema` input (where the
 * `qi/human.form.submit` action reads it). Without this a form step shows
 * "Configure Survey Schema JSON…" and cannot run — this is how the agent
 * actually defines the form, not just adds an empty form step.
 */
export function setFormSchema(
  doc: YDoc,
  roomId: string,
  stepId: string,
  questions: FormQuestionInput[],
): { questionCount: number } {
  const step = readStep(doc, roomId, stepId);
  if (!step)
    throw new FlowError('step_not_found', `No step "${stepId}" in this flow.`);
  const survey = buildSurveyJs(questions);
  // Preserve any existing inputs; surveySchema is stored as a JSON string.
  setStepInputs(doc, stepId, {
    ...(step.inputs ?? {}),
    surveySchema: JSON.stringify(survey),
  });
  return { questionCount: questions.length };
}

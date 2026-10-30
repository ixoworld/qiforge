import {
  ElementFactory,
  Model,
  Question,
  QuestionBooleanModel,
  QuestionCheckboxModel,
  QuestionFileModel,
  QuestionPanelDynamicModel,
  QuestionRatingModel,
  QuestionSelectBase,
  QuestionTextModel,
  Serializer,
  type ItemValue,
} from 'survey-core';
import { MAX_SECTION_ITEMS } from './drafts';
import type { ChoiceQuestion } from './judge';
import { clip } from './text';

/**
 * A job's SurveyJS form (an application `#bco` or a claim `#vct`) asked one
 * question at a time in chat, with the form's own rules: `survey-core` 2.3.11
 * (the Portal's version; Jambo renders with 1.9.101) decides which questions
 * are visible, which are required and whether an answer is valid.
 *
 * Answers are kept in SurveyJS's data shape, keyed by question name, exactly
 * what the web form would produce. Repeating sections (`paneldynamic`) are
 * stored as the array of item objects SurveyJS keeps under the section's name;
 * one question inside item 3 is addressed as `shops[2].photo`.
 */

/** Jambo's map question (`lib/here/MapGridSelector.tsx`): one cell of a geohash grid. */
export const MAP_GRID_TYPE = 'map-grid-selector';

/** Jambo's default cell size when a form names none: geohash length 7 (about 150 m). */
const DEFAULT_GRID_PRECISION = 7;

/** Choices shown per question; a longer list is cut (Yoma forms have at most a few dozen). */
const MAX_OPTIONS = 60;

class QuestionMapGridSelectorModel extends Question {
  override getType() {
    return MAP_GRID_TYPE;
  }
  override isEmpty(): boolean {
    const value: unknown = this.value;
    if (value === null || value === undefined) return true;
    return Array.isArray(value) ? value.length === 0 : false;
  }
  get gridPrecision(): number {
    return (
      Number(this.getPropertyValue('gridPrecision')) || DEFAULT_GRID_PRECISION
    );
  }
  set gridPrecision(value: number) {
    this.setPropertyValue('gridPrecision', value);
  }
  get allowMultiple(): boolean {
    return this.getPropertyValue('allowMultiple') === true;
  }
  set allowMultiple(value: boolean) {
    this.setPropertyValue('allowMultiple', value);
  }
}

if (!Serializer.findClass(MAP_GRID_TYPE)) {
  Serializer.addClass(
    MAP_GRID_TYPE,
    [
      { name: 'gridPrecision:number', default: DEFAULT_GRID_PRECISION },
      { name: 'allowMultiple:boolean', default: false },
    ],
    () => new QuestionMapGridSelectorModel(''),
    'question',
  );
  ElementFactory.Instance.registerElement(
    MAP_GRID_TYPE,
    (name) => new QuestionMapGridSelectorModel(name),
  );
}

/** How a question is answered in chat. */
export type ChatInput =
  | 'pick-one'
  | 'pick-many'
  | 'yes-no'
  | 'text'
  | 'number'
  | 'date'
  /** `inputType: datetime-local`: a date and a time of day. */
  | 'datetime'
  | 'email'
  | 'phone'
  | 'url'
  | 'rating'
  | 'location'
  | 'file'
  /** Signatures, drawings, matrices: finished on the web, not in chat. */
  | 'web-only';

export interface FormQuestion {
  /** Where the answer lives: `name`, or `section[index].name` inside a repeating section. */
  path: string;
  /** The SurveyJS question name. */
  name: string;
  type: string;
  input: ChatInput;
  title: string;
  description?: string;
  required: boolean;
  /**
   * Choice questions: the options as shown, in form order, then the special
   * items the form switches on ("None", "Refuse to answer", "Don't know"),
   * each with the value the form stores for it. `exclusive`: on a checkbox,
   * picked only on its own.
   */
  options?: ChoiceOption[];
  /** How many regular options the form has, when more than {@link MAX_OPTIONS} (the rest are not offered in chat). */
  optionsCut?: number;
  /** The form's "Other" item: its text, and its value. */
  other?: { text: string; value: unknown };
  /** Rating questions: the values the form takes, lowest first. */
  rateValues?: number[];
  rateMin?: number;
  rateMax?: number;
  /** File questions: `image/*`, `.pdf`, ... as the form accepts them. */
  acceptedTypes?: string;
  allowMultiple?: boolean;
  /** Inside a repeating section: which item, 1-based, and the section's title. */
  item?: { section: string; title: string; number: number };
}

export interface ChoiceOption {
  value: unknown;
  text: string;
  /** A checkbox's "None", "Refuse to answer" or "Don't know": only on its own. */
  exclusive?: true;
}

/** A repeating section that is ready for another item, or for the person to say they are done. */
export interface SectionPrompt {
  section: string;
  title: string;
  items: number;
  min: number;
  max: number;
}

export type FormStep =
  | { kind: 'question'; question: FormQuestion }
  | { kind: 'more'; section: SectionPrompt }
  | { kind: 'done' };

/** What the draft keeps besides answers: what the person skipped and the sections they closed. */
export interface FormProgressState {
  data: Record<string, unknown>;
  /** Paths of optional questions the person chose to skip. */
  skipped: string[];
  /** Repeating sections the person said were finished. */
  closedSections: string[];
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/** The SurveyJS JSON inside an ixo survey template (`{question: {...}}`), or the bare survey. */
export function surveyJson(template: unknown): Record<string, unknown> {
  const inner =
    isRecord(template) && isRecord(template.question)
      ? template.question
      : template;
  if (!isRecord(inner) || !Array.isArray(inner.pages))
    throw new Error('The form has no pages');
  return inner;
}

export function formTitle(template: unknown): string {
  const title = surveyJson(template).title;
  return typeof title === 'string' ? clip(title, 200) : '';
}

/**
 * The form as a live model. `data`: a saved draft's answers, which replace
 * everything (a draft saves the form's default values when it is started,
 * so they are part of it). Without it the model holds the form's defaults,
 * as the web form starts.
 */
export function openModel(
  template: unknown,
  data?: Record<string, unknown>,
): Model {
  const model = new Model(surveyJson(template));
  if (data) model.data = structuredClone(data);
  return model;
}

/** The model's answers in SurveyJS's data shape. */
export function dataOf(model: Model): Record<string, unknown> {
  const data: unknown = model.data;
  return isRecord(data) ? data : {};
}

const INPUT_BY_TEXT_TYPE: Record<string, ChatInput> = {
  number: 'number',
  range: 'number',
  date: 'date',
  'datetime-local': 'datetime',
  email: 'email',
  tel: 'phone',
  url: 'url',
};

/** A rating whose scale is all numbers is a number; one with words is a choice. */
function numericRating(question: QuestionRatingModel): number[] | undefined {
  const values = question.visibleRateValues.map((item) => item.value);
  if (!values.length) return undefined;
  const numbers = values.map((value) =>
    typeof value === 'number' ? value : Number(value),
  );
  return numbers.every(Number.isFinite) &&
    values.every(
      (value) => typeof value === 'number' || /^-?\d+$/.test(String(value)),
    )
    ? [...numbers].sort((a, b) => a - b)
    : undefined;
}

function inputFor(question: Question): ChatInput | undefined {
  if (question instanceof QuestionTextModel)
    return INPUT_BY_TEXT_TYPE[question.inputType] ?? 'text';
  if (question instanceof QuestionMapGridSelectorModel) return 'location';
  if (question instanceof QuestionRatingModel)
    return numericRating(question) ? 'rating' : 'pick-one';
  switch (question.getType()) {
    case 'comment':
      return 'text';
    case 'radiogroup':
    case 'dropdown':
      return 'pick-one';
    case 'checkbox':
    case 'tagbox':
      return 'pick-many';
    case 'boolean':
      return 'yes-no';
    case 'file':
      return 'file';
    // Not asked: shown text, computed values and images carry no answer.
    case 'html':
    case 'expression':
    case 'image':
      return undefined;
    default:
      return 'web-only';
  }
}

/**
 * The special items a choice list carries, by identity (a regular choice
 * may have the value `none` or `other` too): "None", "Refuse to answer" and
 * "Don't know" are offered as options; "Other" through `other`; "Select
 * all" is not offered.
 */
function specialItems(question: QuestionSelectBase): {
  extras: ItemValue[];
  other: ItemValue;
  skipped: Set<ItemValue>;
} {
  const extras = [
    question.noneItem,
    question.refuseItem,
    question.dontKnowItem,
  ];
  const skipped = new Set<ItemValue>([...extras, question.otherItem]);
  if (question instanceof QuestionCheckboxModel)
    skipped.add(question.selectAllItem);
  return { extras, other: question.otherItem, skipped };
}

const optionOf = (item: ItemValue): ChoiceOption => ({
  value: item.value,
  text: clip(item.text || String(item.value), 200),
});

function describe(
  question: Question,
  path: string,
  item?: FormQuestion['item'],
): FormQuestion | undefined {
  const input = inputFor(question);
  if (!input) return undefined;
  const view: FormQuestion = {
    path,
    name: question.name,
    type: question.getType(),
    input,
    // A form is written by its operator: clipped, and shown as data.
    title: clip(
      question.processedTitle || question.title || question.name,
      200,
    ),
    ...(question.description
      ? { description: clip(question.description, 500) }
      : {}),
    required: question.isRequired,
    ...(item ? { item } : {}),
  };
  if (question instanceof QuestionSelectBase) {
    const { extras, other, skipped } = specialItems(question);
    const shown = new Set<ItemValue>(question.visibleChoices);
    const regular = question.visibleChoices.filter((c) => !skipped.has(c));
    view.options = [
      ...regular.slice(0, MAX_OPTIONS).map(optionOf),
      ...extras
        .filter((c) => shown.has(c))
        .map((c) => ({
          ...optionOf(c),
          ...(view.input === 'pick-many' ? { exclusive: true as const } : {}),
        })),
    ];
    if (regular.length > MAX_OPTIONS) view.optionsCut = regular.length;
    if (shown.has(other))
      view.other = {
        text: clip(other.text || 'Other', 200),
        value: other.value,
      };
  }
  if (question instanceof QuestionBooleanModel)
    view.options = [
      {
        value: question.getValueTrue(),
        text: clip(question.labelTrue || 'Yes', 200),
      },
      {
        value: question.getValueFalse(),
        text: clip(question.labelFalse || 'No', 200),
      },
    ];
  if (question instanceof QuestionRatingModel) {
    const values = numericRating(question);
    if (values) {
      view.rateValues = values;
      view.rateMin = values[0];
      view.rateMax = values[values.length - 1];
    } else view.options = question.visibleRateValues.map(optionOf);
  }
  if (question instanceof QuestionFileModel) {
    if (question.acceptedTypes) view.acceptedTypes = question.acceptedTypes;
    view.allowMultiple = question.allowMultiple;
  }
  if (question instanceof QuestionMapGridSelectorModel)
    view.allowMultiple = question.allowMultiple;
  return view;
}

const sectionTitle = (section: QuestionPanelDynamicModel) =>
  clip(section.processedTitle || section.title || section.name, 200);

/**
 * Whether a question is on the form as the person sees it: itself, its
 * panel and page, and for a question inside a repeating section the section
 * and that item (`isVisibleInSurvey`).
 */
const shown = (question: Question) => question.isVisibleInSurvey;

/** One step of the form in order: a question, or the end of a repeating section's items. */
type Walked =
  | { kind: 'question'; view: FormQuestion }
  | { kind: 'section-end'; section: QuestionPanelDynamicModel };

/**
 * The form in order: every visible question that takes an answer, the
 * items of a repeating section inline (each followed by the section's end,
 * where "add another?" is asked), never a question the form hides.
 */
function* walk(model: Model): Generator<Walked> {
  for (const question of model.getAllQuestions(false)) {
    if (!shown(question)) continue;
    if (question instanceof QuestionPanelDynamicModel) {
      const title = sectionTitle(question);
      for (const [index, panel] of question.panels.entries()) {
        if (!panel.isVisible) continue;
        for (const inner of panel.questions) {
          if (!shown(inner)) continue;
          const view = describe(
            inner,
            `${question.name}[${index}].${inner.name}`,
            {
              section: question.name,
              title,
              number: index + 1,
            },
          );
          if (view) yield { kind: 'question', view };
        }
      }
      yield { kind: 'section-end', section: question };
      continue;
    }
    // A question inside a repeating section's template has no place of its own.
    if (question.parentQuestion) continue;
    const view = describe(question, question.name);
    if (view) yield { kind: 'question', view };
  }
}

/** Every visible question that takes an answer, in form order, items of repeating sections inline. */
export function visibleQuestions(model: Model): FormQuestion[] {
  const out: FormQuestion[] = [];
  for (const step of walk(model))
    if (step.kind === 'question') out.push(step.view);
  return out;
}

/** The visible repeating sections, in form order. */
function visibleSections(model: Model): QuestionPanelDynamicModel[] {
  const out: QuestionPanelDynamicModel[] = [];
  for (const step of walk(model))
    if (step.kind === 'section-end') out.push(step.section);
  return out;
}

function parsePath(path: string): {
  section?: string;
  index?: number;
  name: string;
} {
  const match = /^(.+)\[(\d+)\]\.(.+)$/.exec(path);
  if (!match) return { name: path };
  return { section: match[1], index: Number(match[2]), name: match[3]! };
}

function dynamicSection(
  model: Model,
  name: string,
): QuestionPanelDynamicModel | undefined {
  const question = model.getQuestionByName(name);
  return question instanceof QuestionPanelDynamicModel ? question : undefined;
}

/** The live survey-core question at a path, or undefined when the form has none. */
export function questionAt(model: Model, path: string): Question | undefined {
  const { section, index, name } = parsePath(path);
  if (section === undefined) return model.getQuestionByName(name) ?? undefined;
  const panel = dynamicSection(model, section)?.panels[index!];
  return panel?.getQuestionByName(name) ?? undefined;
}

export function viewAt(model: Model, path: string): FormQuestion | undefined {
  return visibleQuestions(model).find((question) => question.path === path);
}

/** The most items a repeating section takes: the form's own maximum, never above {@link MAX_SECTION_ITEMS}. */
function maxItems(section: QuestionPanelDynamicModel): number {
  return Math.min(
    section.maxPanelCount || MAX_SECTION_ITEMS,
    MAX_SECTION_ITEMS,
  );
}

/** The fewest items a section needs: its `minPanelCount`, or one when it is required. */
function minItems(section: QuestionPanelDynamicModel): number {
  return Math.max(section.minPanelCount || 0, section.isRequired ? 1 : 0);
}

/** "Another item?" for a section that can take one and was not closed; below its minimum it is asked even when closed. */
function sectionPrompt(
  section: QuestionPanelDynamicModel,
  closed: string[],
): SectionPrompt | undefined {
  const max = maxItems(section);
  const min = minItems(section);
  if (section.panelCount >= max) return undefined;
  if (closed.includes(section.name) && section.panelCount >= min)
    return undefined;
  return {
    section: section.name,
    title: sectionTitle(section),
    items: section.panelCount,
    min,
    max,
  };
}

/** Whether a question still waits for an answer: empty, and not skipped (a skipped question that has become required is asked again). */
function waiting(
  model: Model,
  view: FormQuestion,
  skipped: readonly string[],
): boolean {
  if (skipped.includes(view.path) && !view.required) return false;
  return questionAt(model, view.path)?.isEmpty() ?? false;
}

/**
 * The next thing to ask, in form order: the first visible question with no
 * answer that was not skipped; at the end of a repeating section's items,
 * whether there is another item (until the section is closed or full),
 * before any question after the section; then done.
 */
export function nextStep(
  model: Model,
  state: Omit<FormProgressState, 'data'>,
): FormStep {
  for (const step of walk(model)) {
    if (step.kind === 'question') {
      if (waiting(model, step.view, state.skipped))
        return { kind: 'question', question: step.view };
      continue;
    }
    const prompt = sectionPrompt(step.section, state.closedSections);
    if (prompt) return { kind: 'more', section: prompt };
  }
  return { kind: 'done' };
}

export function progressOf(
  model: Model,
  skipped: string[],
): { answered: number; total: number } {
  const views = visibleQuestions(model).filter(
    (view) => view.input !== 'web-only',
  );
  return {
    answered: views.filter((view) => !waiting(model, view, skipped)).length,
    total: views.length,
  };
}

/** Longest form-author validation message passed on. */
const MAX_ERROR_CHARS = 200;

/** The errors survey-core gives for one question's value, in the form's own words (clipped: the form's author wrote them). */
function errorsFor(question: Question): string[] {
  question.validate(true);
  // Headless, survey-core may leave an error's text empty (no locale strings
  // rendered yet): getText() fills it, and a plain fallback covers the rest.
  return question.errors.map((error) =>
    clip(
      error.getText() ||
        error.text ||
        (question.isEmpty()
          ? 'This question needs an answer.'
          : 'This answer is not valid.'),
      MAX_ERROR_CHARS,
    ),
  );
}

export type SetResult =
  | { ok: true; data: Record<string, unknown> }
  | { ok: false; errors: string[] };

/**
 * Sets one answer on the open model and checks it the way the web form
 * would. `otherText`: the person's own answer for the form's "Other" item
 * (the value holds that item's value), stored where the form stores it (a
 * `-Comment` value, or the value itself when `storeOthersAsComment` is
 * off). Accepted: the model now holds it, and the data comes back with
 * every value SurveyJS keeps (computed expressions included). Refused: the
 * model is put back as it was.
 */
export function setAnswer(
  model: Model,
  path: string,
  value: unknown,
  otherText?: string,
): SetResult {
  const question = questionAt(model, path);
  if (!question || !shown(question))
    return {
      ok: false,
      errors: [`There is no question "${path}" to answer now.`],
    };
  const before = structuredClone(dataOf(model));
  question.value = value;
  if (otherText !== undefined && question instanceof QuestionSelectBase)
    question.otherValue = otherText;
  const errors = errorsFor(question);
  if (errors.length) {
    model.data = before;
    return { ok: false, errors };
  }
  return { ok: true, data: dataOf(model) };
}

export type SectionResult =
  | { ok: true; data: Record<string, unknown> }
  | { ok: false; detail: string };

/** Adds an empty item to a repeating section, within its maximum. */
export function addSectionItem(model: Model, section: string): SectionResult {
  const dynamic = dynamicSection(model, section);
  if (!dynamic || !shown(dynamic))
    return { ok: false, detail: `There is no repeating section "${section}".` };
  if (dynamic.panelCount >= maxItems(dynamic))
    return {
      ok: false,
      detail: `This section takes at most ${maxItems(dynamic)} items.`,
    };
  dynamic.addPanel();
  return { ok: true, data: dataOf(model) };
}

/** Why a section cannot be closed yet, or undefined when it can. */
export function sectionBelowMinimum(
  model: Model,
  section: string,
): string | undefined {
  const dynamic = dynamicSection(model, section);
  if (!dynamic || !shown(dynamic))
    return `There is no repeating section "${section}".`;
  const min = minItems(dynamic);
  return dynamic.panelCount < min
    ? `This section needs at least ${min} item${min === 1 ? '' : 's'}.`
    : undefined;
}

/**
 * Whether the whole form would submit on the web: every visible required
 * question answered (a skipped one included: skipping never hides that it
 * is required), every value valid, and every repeating section with at
 * least its minimum items. Web-only questions count as missing here: such a
 * form cannot be sent from chat.
 */
export function formErrors(
  model: Model,
): Array<{ path: string; errors: string[] }> {
  const out: Array<{ path: string; errors: string[] }> = [];
  for (const section of visibleSections(model)) {
    const below = sectionBelowMinimum(model, section.name);
    if (below) out.push({ path: section.name, errors: [below] });
  }
  for (const view of visibleQuestions(model)) {
    const question = questionAt(model, view.path);
    if (!question) continue;
    const errors = errorsFor(question);
    if (errors.length) out.push({ path: view.path, errors });
  }
  return out;
}

/** Another visible question keeps its answer under the same value name (SurveyJS keeps it then too). */
function valueKeptByAnother(model: Model, question: Question): boolean {
  if (question.parentQuestion) return false;
  return model
    .getQuestionsByValueName(question.getValueName())
    .some(
      (other) => other !== question && !other.parentQuestion && shown(other),
    );
}

/**
 * Clears the answers of every question the form hides now (itself, its
 * panel or page, a repeating section or one of its items: `isVisibleInSurvey`,
 * nested questions included), whatever the form's `clearInvisibleValues`
 * says: what is read back, shown on the card and sent is the same, and
 * nothing the person cannot see goes out. The saved draft keeps them, so
 * they come back if the person changes the answer that hid them.
 */
export function clearHiddenAnswers(model: Model): void {
  for (const question of model.getAllQuestions(false, false, true))
    if (
      !question.isEmpty() &&
      !shown(question) &&
      !valueKeptByAnother(model, question)
    )
      question.clearValue();
}

/**
 * The answers the Hub files, from a model whose hidden answers were
 * cleared: what the form keeps, without file questions (sent separately).
 * Changes the model: read anything else from it first.
 */
export function submittableData(model: Model): Record<string, unknown> {
  for (const view of visibleQuestions(model))
    if (view.input === 'file') questionAt(model, view.path)?.clearValue();
  return dataOf(model);
}

/** A choice question as the judge reads it (`judge.ts`): every option offered, special items last. */
export function asChoiceQuestion(view: FormQuestion): ChoiceQuestion {
  const options = view.options ?? [];
  const exclusive = options.flatMap((option, index) =>
    option.exclusive ? [index] : [],
  );
  return {
    title: view.title,
    ...(view.description ? { description: view.description } : {}),
    multiple: view.input === 'pick-many',
    options: options.map((option) => option.text),
    ...(exclusive.length ? { exclusive } : {}),
    otherAllowed: view.other !== undefined,
  };
}

/* ── typed answers ────────────────────────────────────────────────────── */

export type Typed = { ok: true; value: unknown } | { ok: false; say: string };

const pad = (n: number) => String(n).padStart(2, '0');

/** A real calendar date `YYYY-MM-DD` (`-`, `/` or `.` between the parts), or undefined. */
function calendarDate(text: string): string | undefined {
  const match = /^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})$/.exec(text);
  if (!match) return undefined;
  const [year, month, day] = [
    Number(match[1]),
    Number(match[2]),
    Number(match[3]),
  ];
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year &&
    date.getUTCMonth() === month - 1 &&
    date.getUTCDate() === day
    ? `${match[1]}-${pad(month)}-${pad(day)}`
    : undefined;
}

/**
 * A number as people write it: `12`, `-3.5`, `1 500`, `1,5` (a decimal
 * comma). `1,500` is refused: it is 1.5 in some places and 1500 in others.
 */
export function parseNumber(raw: string | number): number | undefined {
  if (typeof raw === 'number') return Number.isFinite(raw) ? raw : undefined;
  const text = raw.trim().replace(/\s/g, '');
  if (/^-?\d+(\.\d+)?$/.test(text)) return Number(text);
  if (/^-?\d+,\d+$/.test(text) && !/^-?\d{1,3},\d{3}$/.test(text))
    return Number(text.replace(',', '.'));
  return undefined;
}

/**
 * A typed answer (number, rating, date, date and time, email, link, phone)
 * checked and put in the form's own format before the form's rules see it:
 * survey-core takes `abc` for a date and drops it for a number without an
 * error. Anything else is the reply as written, trimmed.
 */
export function typedAnswer(
  view: FormQuestion,
  reply: string,
  value: string | number | undefined,
): Typed {
  const raw = value ?? reply;
  const text = typeof raw === 'string' ? raw.trim() : String(raw);
  switch (view.input) {
    case 'number': {
      const n = parseNumber(raw);
      return n === undefined
        ? {
            ok: false,
            say: 'This needs a number, like 12 or 2.5 (no thousands commas).',
          }
        : { ok: true, value: n };
    }
    case 'rating': {
      const n = parseNumber(raw);
      const allowed = view.rateValues ?? [];
      return n !== undefined && allowed.includes(n)
        ? { ok: true, value: n }
        : {
            ok: false,
            say: `This needs one of these numbers: ${allowed.join(', ')}.`,
          };
    }
    case 'date': {
      const date = calendarDate(text);
      return date
        ? { ok: true, value: date }
        : { ok: false, say: 'This needs a date, as YYYY-MM-DD (2026-10-30).' };
    }
    case 'datetime': {
      const match = /^(.+?)[T\s](\d{1,2}):(\d{2})(?::\d{2})?$/.exec(text);
      const date = match ? calendarDate(match[1]!) : undefined;
      const hours = Number(match?.[2]);
      const minutes = Number(match?.[3]);
      return date && hours < 24 && minutes < 60
        ? { ok: true, value: `${date}T${pad(hours)}:${pad(minutes)}` }
        : {
            ok: false,
            say: 'This needs a date and a time, as YYYY-MM-DD HH:mm (2026-10-30 14:30).',
          };
    }
    case 'email':
      return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(text)
        ? { ok: true, value: text }
        : { ok: false, say: 'This needs an email address.' };
    case 'url': {
      try {
        const url = new URL(text);
        if (url.protocol === 'https:' || url.protocol === 'http:')
          return { ok: true, value: text };
      } catch {
        // falls through
      }
      return { ok: false, say: 'This needs a link starting with https://.' };
    }
    case 'phone': {
      const digits = text.replace(/\D/g, '');
      return /^\+?[\d\s().-]+$/.test(text) &&
        digits.length >= 7 &&
        digits.length <= 15
        ? { ok: true, value: text }
        : { ok: false, say: 'This needs a phone number.' };
    }
    default:
      return { ok: true, value: text };
  }
}

const GEOHASH_BASE32 = '0123456789bcdefghjkmnpqrstuvwxyz';

/** Standard geohash, as Jambo's `lib/here/grid.service.ts` `encodeGeohash`. */
export function encodeGeohash(
  lat: number,
  lon: number,
  precision: number,
): string {
  let idx = 0;
  let bit = 0;
  let evenBit = true;
  let geohash = '';
  let latMin = -90;
  let latMax = 90;
  let lonMin = -180;
  let lonMax = 180;
  while (geohash.length < precision) {
    if (evenBit) {
      const mid = (lonMin + lonMax) / 2;
      if (lon >= mid) {
        idx = idx * 2 + 1;
        lonMin = mid;
      } else {
        idx *= 2;
        lonMax = mid;
      }
    } else {
      const mid = (latMin + latMax) / 2;
      if (lat >= mid) {
        idx = idx * 2 + 1;
        latMin = mid;
      } else {
        idx *= 2;
        latMax = mid;
      }
    }
    evenBit = !evenBit;
    if (++bit === 5) {
      geohash += GEOHASH_BASE32.charAt(idx);
      bit = 0;
      idx = 0;
    }
  }
  return geohash;
}

/** A shared WhatsApp pin, as the gateway writes it: `📍 <lat>, <long>` then ` — name` and/or `, address`. */
export function parsePin(
  text: string,
): { latitude: number; longitude: number; placeName?: string } | undefined {
  const match =
    /📍\s*(-?\d{1,2}(?:\.\d+)?)\s*,\s*(-?\d{1,3}(?:\.\d+)?)(?:\s*—\s*(.+))?/u.exec(
      text,
    );
  if (!match) return undefined;
  const latitude = Number(match[1]);
  const longitude = Number(match[2]);
  if (!Number.isFinite(latitude) || !Number.isFinite(longitude))
    return undefined;
  if (Math.abs(latitude) > 90 || Math.abs(longitude) > 180) return undefined;
  const placeName = match[3]?.trim();
  return {
    latitude,
    longitude,
    ...(placeName ? { placeName: clip(placeName, 200) } : {}),
  };
}

/** Geohash lengths a map question may use; anything else is clamped into range. */
const MIN_GRID_PRECISION = 1;
const MAX_GRID_PRECISION = 12;

/** The value Jambo's map question stores for one picked point. */
export function gridCell(
  model: Model,
  path: string,
  pin: { latitude: number; longitude: number; placeName?: string },
): Record<string, unknown> {
  const question = questionAt(model, path);
  const asked =
    question instanceof QuestionMapGridSelectorModel
      ? question.gridPrecision
      : DEFAULT_GRID_PRECISION;
  const precision = Math.min(
    MAX_GRID_PRECISION,
    Math.max(MIN_GRID_PRECISION, Math.round(asked)),
  );
  return {
    geoId: encodeGeohash(pin.latitude, pin.longitude, precision),
    latitude: pin.latitude,
    longitude: pin.longitude,
    gridPrecision: precision,
    ...(pin.placeName ? { placeName: pin.placeName } : {}),
  };
}

/** Whether a file the person sent fits the question's `acceptedTypes` (`image/*`, `.pdf`, `application/pdf`). */
export function fileAccepted(
  acceptedTypes: string | undefined,
  mimetype: string,
  filename: string,
): boolean {
  if (!acceptedTypes?.trim()) return true;
  const type = mimetype.toLowerCase();
  const name = filename.toLowerCase();
  return acceptedTypes
    .split(',')
    .map((entry) => entry.trim().toLowerCase())
    .filter(Boolean)
    .some((entry) =>
      entry.startsWith('.')
        ? name.endsWith(entry)
        : entry.endsWith('/*')
          ? type.startsWith(entry.slice(0, -1))
          : type === entry,
    );
}

import {
  ElementFactory,
  Model,
  Question,
  QuestionBooleanModel,
  QuestionFileModel,
  QuestionPanelDynamicModel,
  QuestionRatingModel,
  QuestionSelectBase,
  QuestionTextModel,
  Serializer,
  type PanelModel,
} from 'survey-core';
import { MAX_SECTION_ITEMS } from './drafts';
import type { ChoiceQuestion } from './judge';
import { clip } from './text';

/**
 * A job's SurveyJS form (an application `#bco` or a claim `#vct`) asked one
 * question at a time in chat, with the form's own rules: `survey-core` (the
 * library the Portal and Jambo render with) decides which questions are
 * visible, which are required and whether an answer is valid, so web and chat
 * can never disagree about a form.
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
  /** Choice questions: the options as shown, in form order. */
  options?: Array<{ value: unknown; text: string }>;
  otherAllowed?: boolean;
  noneText?: string;
  /** Rating questions. */
  rateMin?: number;
  rateMax?: number;
  /** File questions: `image/*`, `.pdf`, ... as the form accepts them. */
  acceptedTypes?: string;
  allowMultiple?: boolean;
  /** Inside a repeating section: which item, 1-based, and the section's title. */
  item?: { section: string; title: string; number: number };
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

export function openModel(
  template: unknown,
  data: Record<string, unknown>,
): Model {
  const model = new Model(surveyJson(template));
  model.data = structuredClone(data);
  return model;
}

/** The model's answers in SurveyJS's data shape. */
function dataOf(model: Model): Record<string, unknown> {
  const data: unknown = model.data;
  return isRecord(data) ? data : {};
}

const INPUT_BY_TEXT_TYPE: Record<string, ChatInput> = {
  number: 'number',
  range: 'number',
  date: 'date',
  'datetime-local': 'date',
  email: 'email',
  tel: 'phone',
  url: 'url',
};

function inputFor(question: Question): ChatInput | undefined {
  if (question instanceof QuestionTextModel)
    return INPUT_BY_TEXT_TYPE[question.inputType] ?? 'text';
  if (question instanceof QuestionMapGridSelectorModel) return 'location';
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
    case 'rating':
      return 'rating';
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

/** The special items SurveyJS adds to a choice list; asked about through `otherAllowed`/`noneText`. */
const SPECIAL_CHOICES = new Set([
  'other',
  'none',
  'selectall',
  'refused',
  'dontknow',
]);

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
    view.options = question.visibleChoices
      .filter((choice) => !SPECIAL_CHOICES.has(String(choice.value)))
      .slice(0, MAX_OPTIONS)
      .map((choice) => ({ value: choice.value, text: clip(choice.text, 200) }));
    if (question.showOtherItem) view.otherAllowed = true;
    if (question.showNoneItem)
      view.noneText = clip(question.noneText || 'None of these', 200);
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
    const values = question.visibleRateValues
      .map((v) => Number(v.value))
      .filter(Number.isFinite);
    view.rateMin = values.length ? Math.min(...values) : question.rateMin;
    view.rateMax = values.length ? Math.max(...values) : question.rateMax;
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

/** Every visible question that takes an answer, in form order, items of repeating sections inline. */
export function visibleQuestions(model: Model): FormQuestion[] {
  const out: FormQuestion[] = [];
  for (const question of model.getAllQuestions(true)) {
    if (question instanceof QuestionPanelDynamicModel) {
      question.panels.forEach((panel: PanelModel, index: number) => {
        for (const inner of panel.questions) {
          if (!inner.isVisible) continue;
          const view = describe(
            inner,
            `${question.name}[${index}].${inner.name}`,
            {
              section: question.name,
              title: sectionTitle(question),
              number: index + 1,
            },
          );
          if (view) out.push(view);
        }
      });
      continue;
    }
    const view = describe(question, question.name);
    if (view) out.push(view);
  }
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

/** The live survey-core question at a path, or undefined when the form has none (or it is hidden). */
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

function sectionPrompts(model: Model, closed: string[]): SectionPrompt[] {
  const out: SectionPrompt[] = [];
  for (const question of model.getAllQuestions(true)) {
    if (
      !(question instanceof QuestionPanelDynamicModel) ||
      closed.includes(question.name)
    )
      continue;
    const max = maxItems(question);
    if (question.panelCount >= max) continue;
    out.push({
      section: question.name,
      title: sectionTitle(question),
      items: question.panelCount,
      min: minItems(question),
      max,
    });
  }
  return out;
}

/** The fewest items a section needs: its `minPanelCount`, or one when it is required. */
function minItems(section: QuestionPanelDynamicModel): number {
  return Math.max(section.minPanelCount || 0, section.isRequired ? 1 : 0);
}

/**
 * The next thing to ask: the first visible question with no answer that was
 * not skipped, then any repeating section that can take another item and was
 * not closed, then done.
 */
export function nextStep(
  model: Model,
  state: Omit<FormProgressState, 'data'>,
): FormStep {
  for (const view of visibleQuestions(model)) {
    if (state.skipped.includes(view.path)) continue;
    if (questionAt(model, view.path)?.isEmpty())
      return { kind: 'question', question: view };
  }
  const [section] = sectionPrompts(model, state.closedSections);
  if (section) return { kind: 'more', section };
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
    answered: views.filter(
      (view) =>
        !questionAt(model, view.path)?.isEmpty() || skipped.includes(view.path),
    ).length,
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
 * would. Accepted: the model now holds it, and the data comes back with
 * every value SurveyJS keeps (computed expressions included). Refused: the
 * model is put back as it was.
 */
export function setAnswer(
  model: Model,
  path: string,
  value: unknown,
  comment?: string,
): SetResult {
  const question = questionAt(model, path);
  if (!question || !question.isVisible)
    return {
      ok: false,
      errors: [`There is no question "${path}" to answer now.`],
    };
  const before = { value: question.value, comment: question.comment };
  question.value = value;
  if (comment !== undefined) question.comment = comment;
  const errors = errorsFor(question);
  if (errors.length) {
    question.value = before.value;
    question.comment = before.comment;
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
  if (!dynamic)
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
  if (!dynamic) return `There is no repeating section "${section}".`;
  const min = minItems(dynamic);
  return dynamic.panelCount < min
    ? `This section needs at least ${min} item${min === 1 ? '' : 's'}.`
    : undefined;
}

/**
 * Whether the whole form would submit on the web: every visible required
 * question answered, every value valid, and every repeating section with at
 * least its minimum items. Web-only questions count as missing here: such a
 * form cannot be sent from chat.
 */
export function formErrors(
  model: Model,
): Array<{ path: string; errors: string[] }> {
  const out: Array<{ path: string; errors: string[] }> = [];
  for (const question of model.getAllQuestions(true)) {
    if (!(question instanceof QuestionPanelDynamicModel)) continue;
    const below = sectionBelowMinimum(model, question.name);
    if (below) out.push({ path: question.name, errors: [below] });
  }
  for (const view of visibleQuestions(model)) {
    const question = questionAt(model, view.path);
    if (!question) continue;
    const errors = errorsFor(question);
    if (errors.length) out.push({ path: view.path, errors });
  }
  return out;
}

/**
 * The answers the Hub files: what the form keeps, without file questions
 * (sent separately) and without answers to questions hidden since, as the
 * web form drops them on complete. Changes the model: pass a fresh one.
 */
export function submittableData(model: Model): Record<string, unknown> {
  for (const question of model.getAllQuestions(false))
    if (!question.isVisible) question.clearValue();
  for (const view of visibleQuestions(model))
    if (view.input === 'file') questionAt(model, view.path)?.clearValue();
  return dataOf(model);
}

/** A choice question as the judge reads it (`judge.ts`). */
export function asChoiceQuestion(view: FormQuestion): ChoiceQuestion {
  return {
    title: view.title,
    ...(view.description ? { description: view.description } : {}),
    multiple: view.input === 'pick-many',
    options: (view.options ?? []).map((option) => option.text),
    otherAllowed: view.otherAllowed === true,
    ...(view.noneText ? { noneText: view.noneText } : {}),
  };
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

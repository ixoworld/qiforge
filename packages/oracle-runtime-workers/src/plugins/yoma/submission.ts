import {
  submissionDisplayValue,
  submissionSummaryIssue,
  type BidSubmitOperation,
  type ClaimSubmitOperation,
  type SubmissionSummaryRow,
} from '@ixo/action-protocol';
import {
  QuestionPanelDynamicModel,
  type Model,
  type Question,
} from 'survey-core';
import type { ChainCall } from '../ixo-chain/http';
import type { Draft, Evidence } from './drafts';
import {
  clearHiddenAnswers,
  questionAt,
  submittableData,
  visibleQuestions,
  type FormQuestion,
} from './engine';
import { clip } from './text';

/**
 * Turning a finished draft into the Auth Hub card the person approves
 * (`@ixo/action-protocol` 0.7.0, Hub level 5): `ixo.bid.submit.v1` for an
 * application, `ixo.claim.submit.v1` for a claim. The card carries what the
 * person sees (title, and exactly one row per answer of `data`, which the
 * Hub checks) and what the Hub files as them:
 * the answers as JSON, and for a claim each file's gateway link, size and
 * SHA-256. File questions are left out of the answers; the Hub uploads the
 * files to the claims lane when the person confirms and puts the references
 * in, then signs the answers, saves the claim and submits it on chain.
 */

/** What a file question holds in the draft until submit, so the form's rules count it as answered. */
export const PENDING_FILE_PREFIX = 'pending:';

export function pendingFileValue(
  evidence: Pick<Evidence, 'filename' | 'mimetype' | 'sha256'>,
) {
  return {
    name: evidence.filename,
    type: evidence.mimetype,
    content: `${PENDING_FILE_PREFIX}${evidence.sha256}`,
  };
}

/**
 * The card's summary limits (`@ixo/action-protocol` 0.7.0): 0–100 rows, one
 * per answer of `data`; a label of 1–200 characters; a value of at most 2,000.
 */
export const MAX_CARD_ROWS = 100;
export const MAX_CARD_VALUE = 2_000;
const MAX_LABEL = 200;

/** A string field of a stored answer object, if it has one. */
function field(value: unknown, key: string): string | undefined {
  if (typeof value !== 'object' || value === null || !(key in value))
    return undefined;
  const found: unknown = Reflect.get(value, key);
  return typeof found === 'string' ? found : undefined;
}

/** A stored choice value as its option's text; a value the list does not hold (an own answer) as itself. */
function choiceText(view: FormQuestion, value: unknown): string {
  if (view.other && value === view.other.value) return view.other.text;
  return (
    view.options?.find((option) => option.value === value)?.text ??
    String(value)
  );
}

/** What a choice answer means in the form's words ("South Africa" for `ZA`). */
function choiceMeaning(view: FormQuestion, value: unknown): string {
  return (Array.isArray(value) ? value : [value])
    .map((item) => choiceText(view, item))
    .join(', ');
}

/** A file answer as the person reads it back: icon and name, never the link. */
function fileText(value: unknown): string {
  return (Array.isArray(value) ? value : [value])
    .map((file) => {
      const type = field(file, 'type') ?? '';
      const icon = type.startsWith('image/')
        ? '📷'
        : type.startsWith('video/')
          ? '🎬'
          : '📄';
      return `${icon} ${field(file, 'name') ?? 'file'}`;
    })
    .join(', ');
}

/** One row of the card: an answer's path in `data`, its label, and its display form. */
export type CardRow = SubmissionSummaryRow;

/** A read-back row: the card's row, and what a choice means when its stored value reads differently. */
export interface ReviewRow extends CardRow {
  means?: string;
}

const plainObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/** Why the answers cannot go on one card. */
export type RowProblem = 'rows' | 'value' | 'key' | 'shape';

/**
 * The answers of `data` as the protocol reads them
 * (`submissionSummaryIssue`): objects walked key by key, arrays of objects
 * index by index, every other value an answer at its dot path, shown as
 * `submissionDisplayValue` gives it.
 */
function answersOf(
  data: Record<string, unknown>,
):
  | { ok: true; answers: Array<{ path: string[]; value: string }> }
  | { ok: false; problem: RowProblem } {
  const answers: Array<{ path: string[]; value: string }> = [];
  const walk = (
    node: Record<string, unknown>,
    prefix: string[],
  ): RowProblem | undefined => {
    for (const [key, value] of Object.entries(node)) {
      if (key === '' || key.includes('.')) return 'key';
      const path = [...prefix, key];
      if (plainObject(value)) {
        const problem = walk(value, path);
        if (problem) return problem;
      } else if (
        Array.isArray(value) &&
        value.length &&
        value.every(plainObject)
      ) {
        for (const [index, item] of value.entries()) {
          const problem = walk(item, [...path, String(index)]);
          if (problem) return problem;
        }
      } else {
        const shown = submissionDisplayValue(value);
        if (shown === undefined) return 'shape';
        answers.push({ path, value: shown });
      }
    }
    return undefined;
  };
  const problem = walk(data, []);
  return problem ? { ok: false, problem } : { ok: true, answers };
}

/** Readable names for the parts of Jambo's map cell. */
const CELL_PARTS: Record<string, string> = {
  geoId: 'grid cell',
  gridPrecision: 'grid size',
  placeName: 'place',
};

const titleOf = (question: Question) =>
  question.processedTitle || question.title || question.name;

interface Container {
  getQuestionByValueName(valueName: string): Question | null | undefined;
}

/**
 * A row's label from the form: the question's title; a repeating section's
 * item as the section's title and item number, then the question inside
 * ("Participants 2 · Email"); a part of an object answer after its question
 * ("Where · latitude", "Where 2 · place"); an own "Other" answer as
 * "(own answer)".
 */
function labelFor(
  container: Container,
  parts: string[],
  suffix: string,
): string {
  const [head, ...rest] = parts;
  if (head === undefined) return '';
  const own = head.endsWith(suffix) ? head.slice(0, -suffix.length) : undefined;
  const question =
    container.getQuestionByValueName(head) ??
    (own ? container.getQuestionByValueName(own) : undefined) ??
    undefined;
  const base = question
    ? `${titleOf(question)}${own && question.getValueName() === own ? ' (own answer)' : ''}`
    : head;
  if (
    question instanceof QuestionPanelDynamicModel &&
    rest.length > 1 &&
    /^\d+$/.test(rest[0]!)
  ) {
    const index = Number(rest[0]);
    const panel = question.panels[index];
    const inner = panel
      ? labelFor(panel, rest.slice(1), suffix)
      : rest.slice(1).join(' · ');
    return `${base} ${index + 1} · ${inner}`;
  }
  const segments = [base];
  for (const part of rest) {
    if (/^\d+$/.test(part))
      segments[segments.length - 1] += ` ${Number(part) + 1}`;
    else segments.push(CELL_PARTS[part] ?? part);
  }
  return segments.join(' · ');
}

/** `shops.0.name` (a data path) as the question path `shops[0].name`, when it names one. */
function questionPath(parts: string[]): string | undefined {
  if (parts.length === 1) return parts[0];
  if (parts.length === 3 && /^\d+$/.test(parts[1]!))
    return `${parts[0]}[${parts[1]}].${parts[2]}`;
  return undefined;
}

/**
 * Exactly one row per answer of `data`, in its order: the row the card
 * shows (`field` its path, `value` its display form, the label from the
 * form), and for a choice what it means in the form's words. `problem`
 * when they cannot go on one card: more than {@link MAX_CARD_ROWS}, a value
 * past {@link MAX_CARD_VALUE}, a key the protocol refuses, a value with no
 * display form.
 */
export function rowsOf(
  model: Model,
  data: Record<string, unknown>,
): { rows: ReviewRow[]; problem?: RowProblem } {
  const read = answersOf(data);
  if (!read.ok) return { rows: [], problem: read.problem };
  const views = new Map(
    visibleQuestions(model).map((view) => [view.path, view]),
  );
  const container: Container = {
    getQuestionByValueName: (name) => model.getQuestionByValueName(name),
  };
  const rows = read.answers.map(({ path, value }): ReviewRow => {
    const view = views.get(questionPath(path) ?? '');
    const stored: unknown = view
      ? questionAt(model, view.path)?.value
      : undefined;
    const means =
      view &&
      (view.input === 'pick-one' ||
        view.input === 'pick-many' ||
        view.input === 'yes-no')
        ? choiceMeaning(view, stored)
        : undefined;
    return {
      field: path.join('.'),
      label:
        clip(labelFor(container, path, model.commentSuffix), MAX_LABEL) ||
        clip(path.join('.'), MAX_LABEL),
      value,
      ...(means !== undefined && means !== value ? { means } : {}),
    };
  });
  const problem =
    rows.length > MAX_CARD_ROWS
      ? 'rows'
      : rows.some((row) => row.value.length > MAX_CARD_VALUE)
        ? 'value'
        : undefined;
  return { rows, ...(problem ? { problem } : {}) };
}

/** The file answers still on the form, as the person reads them back (the card shows the files themselves). */
function fileRows(model: Model): Array<{ label: string; value: string }> {
  return visibleQuestions(model).flatMap((view) => {
    if (view.input !== 'file') return [];
    const question = questionAt(model, view.path);
    if (!question || question.isEmpty()) return [];
    return [
      {
        label: view.item
          ? `${view.item.title} ${view.item.number} · ${view.title}`
          : view.title,
        value: fileText(question.value),
      },
    ];
  });
}

/**
 * What a finished draft sends, from its open model, in one pass: hidden
 * answers cleared, the files listed, then the answers the Hub files (file
 * questions left out) and their rows. The read-back, the card and the data
 * all come from here. Changes the model.
 */
export function readBack(model: Model) {
  clearHiddenAnswers(model);
  const files = fileRows(model);
  const data = submittableData(model);
  return { files, data, ...rowsOf(model, data) };
}

/** Rows for one review answer: pages of at most this many JSON characters each. */
export const REVIEW_PAGE_CHARS = 8_000;

/** The rows in pages that each fit {@link REVIEW_PAGE_CHARS}, nothing cut; at least one (maybe empty) page. */
export function reviewPages<T>(rows: T[]): T[][] {
  const pages: T[][] = [[]];
  let size = 0;
  for (const row of rows) {
    const rowSize = JSON.stringify(row).length + 1;
    if (size + rowSize > REVIEW_PAGE_CHARS && pages[pages.length - 1]!.length) {
      pages.push([]);
      size = 0;
    }
    pages[pages.length - 1]!.push(row);
    size += rowSize;
  }
  return pages;
}

type Network = ChainCall['network'];

export type HubNetwork = 'ixo mainnet' | 'ixo testnet' | 'ixo devnet';

export function networkLabel(network: Network): HubNetwork {
  return `ixo ${network}`;
}

/** The card's `data` limit (`string(2, 60000)` in the protocol). */
export const MAX_CARD_DATA = 60_000;
/** The card's evidence limits: 30 files, a field of at most 200 characters. */
export const MAX_CARD_EVIDENCE = 30;
const MAX_EVIDENCE_FIELD = 200;

/** `shops[2].photo` as the card's evidence field: `shops.2.photo`. */
export function evidenceField(path: string): string {
  return path.replace(/\[(\d+)\]\./g, '.$1.');
}

/**
 * The files still answering a visible question: a file replaced since, or one
 * whose question is now hidden, is left out.
 */
export function liveEvidence(
  model: Model,
  draft: Pick<Draft, 'evidence'>,
): Evidence[] {
  const paths = new Set(
    visibleQuestions(model)
      .filter((view) => view.input === 'file')
      .map((view) => view.path),
  );
  return draft.evidence.filter((item) => {
    if (!paths.has(item.path)) return false;
    const value: unknown = questionAt(model, item.path)?.value;
    return (Array.isArray(value) ? value : []).some(
      (file) =>
        field(file, 'content') === `${PENDING_FILE_PREFIX}${item.sha256}`,
    );
  });
}

/**
 * How long a file's gateway link must still be valid when a card is sent:
 * the card's review window (15 minutes) and a margin for the Hub's upload.
 */
export const EVIDENCE_LINK_MARGIN_S = 60 * 60;

/**
 * Files whose gateway link (`<origin>/media/<binding>/<id>?exp=<unix s>&sig=…`,
 * valid 30 days) lapses before the Hub could fetch it; a link without `exp`
 * is left to the Hub's own check.
 */
export function lapsedEvidence(
  evidence: Evidence[],
  nowMs: number,
): Evidence[] {
  return evidence.filter((item) => {
    let exp: string | null;
    try {
      exp = new URL(item.url).searchParams.get('exp');
    } catch {
      return true;
    }
    if (exp === null) return false;
    const at = Number(exp);
    return !Number.isFinite(at) || at < nowMs / 1000 + EVIDENCE_LINK_MARGIN_S;
  });
}

export type Built<T> =
  | { ok: true; operation: T; rows: ReviewRow[] }
  | { ok: false; why: RowProblem | 'files' | 'data' };

const cardRows = (rows: ReviewRow[]): CardRow[] =>
  rows.map(({ field: path, label, value }) => ({ field: path, label, value }));

/**
 * The card, checked as the Hub checks it (`submissionSummaryIssue`): a
 * mismatch is a bug here, refused rather than sent.
 */
function checked<T extends BidSubmitOperation | ClaimSubmitOperation>(
  operation: T,
  rows: ReviewRow[],
): Built<T> {
  const issue = submissionSummaryIssue(operation);
  if (issue) {
    console.warn(`[yoma] card rows refused: ${issue.slice(0, 120)}`);
    return { ok: false, why: 'shape' };
  }
  return { ok: true, operation, rows };
}

/** The application card for a finished application draft. */
export function buildApplicationOperation(input: {
  network: HubNetwork;
  model: Model;
  draft: Pick<Draft, 'collectionId' | 'title'>;
}): Built<BidSubmitOperation> {
  const { data, rows, problem } = readBack(input.model);
  if (problem) return { ok: false, why: problem };
  const json = JSON.stringify(data);
  if (json.length > MAX_CARD_DATA) return { ok: false, why: 'data' };
  return checked(
    {
      kind: 'ixo.bid.submit.v1',
      network: input.network,
      collectionId: input.draft.collectionId,
      title: clip(input.draft.title, 120),
      role: 'SA',
      summary: cardRows(rows),
      data: json,
    },
    rows,
  );
}

/** The claim card for a finished claim draft, with one evidence entry per file still answering a visible question. */
export function buildClaimOperation(input: {
  network: HubNetwork;
  model: Model;
  draft: Pick<Draft, 'collectionId' | 'title' | 'evidence'>;
}): Built<ClaimSubmitOperation> {
  clearHiddenAnswers(input.model);
  const evidence = liveEvidence(input.model, input.draft).map((item) => ({
    field: evidenceField(item.path),
    url: item.url,
    filename: item.filename,
    mimetype: item.mimetype,
    size: item.size,
    sha256: item.sha256,
  }));
  if (
    evidence.length > MAX_CARD_EVIDENCE ||
    evidence.some((item) => item.field.length > MAX_EVIDENCE_FIELD)
  )
    return { ok: false, why: 'files' };
  const { data, rows, problem } = readBack(input.model);
  if (problem) return { ok: false, why: problem };
  const json = JSON.stringify(data);
  if (json.length > MAX_CARD_DATA) return { ok: false, why: 'data' };
  return checked(
    {
      kind: 'ixo.claim.submit.v1',
      network: input.network,
      collectionId: input.draft.collectionId,
      title: clip(input.draft.title, 120),
      summary: cardRows(rows),
      data: json,
      evidence,
    },
    rows,
  );
}

/**
 * The Hub's idempotency key for one send: the run and tool call that sent
 * it, the draft's `cardAttempt` (bumped after a send fails, and when a card
 * is cleared) and the owner, hashed to 64 hex characters (the Hub takes
 * 1–120; its keys are unique per oracle account, so two people never share
 * one). Every send gets a key of its own: the runtime binds a key to the run
 * that reserved it, so a retry in a later run needs a new one. What stops a
 * second card is the draft's `card`, set as soon as one was made.
 */
export async function cardRequestKey(input: {
  ownerDid: string;
  runId: string;
  toolCallId: string;
  cardAttempt: number;
}): Promise<string> {
  const bytes = new Uint8Array(
    await crypto.subtle.digest(
      'SHA-256',
      new TextEncoder().encode(
        JSON.stringify([
          'yoma-card',
          input.ownerDid,
          input.runId,
          input.toolCallId,
          input.cardAttempt,
        ]),
      ),
    ),
  );
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

/** Known reward tokens, so pay reads as an amount, never as a token name. */
const DENOMS: Record<
  string,
  { label: string; decimals: number; prefix?: string }
> = {
  // USDC on ixo (Noble, via IBC), as Jambo's wallet shows it.
  'ibc/6BBE9BD4246F8E04948D5A4EEE7164B2630263B9EBB5E7DC5F0A46C62A2FF97B': {
    label: 'USD',
    decimals: 6,
    prefix: '$',
  },
  uixo: { label: 'IXO', decimals: 6 },
};

/** What a job pays, in words: "$1.27", or undefined when it lists no reward. */
export function describeReward(
  reward: Array<{ denom: string; amount: string }>,
): string | undefined {
  const parts = reward.map((coin) => {
    const known = DENOMS[coin.denom];
    if (!known) return undefined;
    const value = Number(coin.amount) / 10 ** known.decimals;
    const amount = value.toLocaleString('en-US', { maximumFractionDigits: 2 });
    return known.prefix
      ? `${known.prefix}${amount}`
      : `${amount} ${known.label}`;
  });
  if (!parts.length || parts.some((part) => part === undefined))
    return parts.length ? 'a reward' : undefined;
  return parts.join(' + ');
}

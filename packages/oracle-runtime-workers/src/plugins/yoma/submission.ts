import type {
  BidSubmitOperation,
  ClaimSubmitOperation,
} from '@ixo/action-protocol';
import { QuestionSelectBase, type Model, type Question } from 'survey-core';
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
 * person sees (title and one row per answer) and what the Hub files as them:
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

/** The card's summary limits (`@ixo/action-protocol` 0.7.0): 1–60 rows, a label of 1–200 characters, a value of at most 500. */
export const MAX_CARD_ROWS = 60;
const MAX_LABEL = 200;
const MAX_VALUE = 500;

/** A string field of a stored answer object, if it has one. */
function field(value: unknown, key: string): string | undefined {
  if (typeof value !== 'object' || value === null || !(key in value))
    return undefined;
  const found: unknown = Reflect.get(value, key);
  return typeof found === 'string' ? found : undefined;
}

function coordinate(value: unknown, key: 'latitude' | 'longitude'): string {
  if (typeof value !== 'object' || value === null) return '?';
  const found: unknown = Reflect.get(value, key);
  return typeof found === 'number' ? found.toFixed(5) : '?';
}

/** A stored choice value as its option's text; a value the list does not hold (an own answer) as itself. */
function choiceText(view: FormQuestion, value: unknown): string {
  if (view.other && value === view.other.value) return view.other.text;
  return (
    view.options?.find((option) => option.value === value)?.text ??
    String(value)
  );
}

/** The person's own "Other" answer, wherever the form keeps it. */
function ownAnswer(question: Question): string | undefined {
  if (!(question instanceof QuestionSelectBase) || !question.isOtherSelected)
    return undefined;
  const text = question.otherValue;
  return typeof text === 'string' && text ? text : undefined;
}

/** One answer as the person reads it back: in full (never cut). */
export function answerText(view: FormQuestion, question: Question): string {
  const value: unknown = question.value;
  if (value === undefined || value === null || value === '') return '';
  switch (view.input) {
    case 'pick-one':
    case 'yes-no': {
      const own = ownAnswer(question);
      return own ?? choiceText(view, value);
    }
    case 'pick-many': {
      const own = ownAnswer(question);
      const items = Array.isArray(value) ? value : [value];
      const shown = items
        .filter(
          (item) => !(own && (item === view.other?.value || item === own)),
        )
        .map((item) => choiceText(view, item));
      return [...shown, ...(own ? [own] : [])].join(', ');
    }
    case 'file': {
      const files = Array.isArray(value) ? value : [value];
      return files
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
    case 'location': {
      const cells = Array.isArray(value) ? value : [value];
      return cells
        .map((cell) => {
          const place = field(cell, 'placeName');
          return `📍 ${coordinate(cell, 'latitude')}, ${coordinate(cell, 'longitude')}${place ? ` (${place})` : ''}`;
        })
        .join('; ');
    }
    default:
      return typeof value === 'object' ? JSON.stringify(value) : String(value);
  }
}

function labelOf(view: FormQuestion): string {
  return view.item
    ? `${view.item.title} ${view.item.number} · ${view.title}`
    : view.title;
}

export interface AnswerRow {
  label: string;
  value: string;
}

/**
 * Every answered question in form order, each value in full, from a model
 * whose hidden answers were cleared (`clearHiddenAnswers`): what the person
 * reads back is what is sent. Labels are the form's titles (already clipped).
 */
export function answerRows(model: Model): AnswerRow[] {
  const rows: AnswerRow[] = [];
  for (const view of visibleQuestions(model)) {
    const question = questionAt(model, view.path);
    if (!question || question.isEmpty()) continue;
    rows.push({ label: labelOf(view), value: answerText(view, question) });
  }
  return rows;
}

/**
 * The card's rows, with nothing left out or cut: a value longer than the
 * card takes is split over rows ("Describe it (2/3)"). Undefined when that
 * is more rows than one card takes: such a form is not sent from chat.
 */
export function cardSummary(rows: AnswerRow[]): AnswerRow[] | undefined {
  const out: AnswerRow[] = [];
  for (const row of rows) {
    const parts = pieces(row.value);
    parts.forEach((part, index) =>
      out.push({
        label: clip(
          parts.length > 1
            ? `${row.label} (${index + 1}/${parts.length})`
            : row.label,
          MAX_LABEL,
        ),
        value: part,
      }),
    );
  }
  if (out.length > MAX_CARD_ROWS) return undefined;
  return out.length ? out : [{ label: 'Answers', value: 'No answers' }];
}

/** A value in pieces of at most {@link MAX_VALUE} characters, never splitting a surrogate pair. */
function pieces(value: string): string[] {
  if (!value) return [''];
  const out: string[] = [];
  let at = 0;
  while (at < value.length) {
    let end = Math.min(at + MAX_VALUE, value.length);
    const last = value.charCodeAt(end - 1);
    if (end < value.length && last >= 0xd800 && last <= 0xdbff) end -= 1;
    out.push(value.slice(at, end));
    at = end;
  }
  return out;
}

/** Rows for one review answer: pages of at most this many JSON characters each. */
export const REVIEW_PAGE_CHARS = 8_000;

/** The rows in pages that each fit {@link REVIEW_PAGE_CHARS}, nothing cut; at least one (maybe empty) page. */
export function reviewPages(rows: AnswerRow[]): AnswerRow[][] {
  const pages: AnswerRow[][] = [[]];
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
  | { ok: true; operation: T; rows: AnswerRow[] }
  | { ok: false; why: 'rows' | 'files' | 'data' };

/**
 * What a finished draft sends, from its open model: hidden answers cleared
 * first, then the rows read back and shown on the card, then the answers
 * the Hub files (file questions left out), all from that same model.
 */
function sendable(model: Model) {
  clearHiddenAnswers(model);
  const rows = answerRows(model);
  return { rows, summary: cardSummary(rows) };
}

/** The application card for a finished application draft. */
export function buildApplicationOperation(input: {
  network: HubNetwork;
  model: Model;
  draft: Pick<Draft, 'collectionId' | 'title'>;
}): Built<BidSubmitOperation> {
  const { rows, summary } = sendable(input.model);
  if (!summary) return { ok: false, why: 'rows' };
  const data = JSON.stringify(submittableData(input.model));
  if (data.length > MAX_CARD_DATA) return { ok: false, why: 'data' };
  return {
    ok: true,
    rows,
    operation: {
      kind: 'ixo.bid.submit.v1',
      network: input.network,
      collectionId: input.draft.collectionId,
      title: clip(input.draft.title, 120),
      role: 'SA',
      summary,
      data,
    },
  };
}

/** The claim card for a finished claim draft, with one evidence entry per file still answering a visible question. */
export function buildClaimOperation(input: {
  network: HubNetwork;
  model: Model;
  draft: Pick<Draft, 'collectionId' | 'title' | 'evidence'>;
}): Built<ClaimSubmitOperation> {
  const { rows, summary } = sendable(input.model);
  if (!summary) return { ok: false, why: 'rows' };
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
  const data = JSON.stringify(submittableData(input.model));
  if (data.length > MAX_CARD_DATA) return { ok: false, why: 'data' };
  return {
    ok: true,
    rows,
    operation: {
      kind: 'ixo.claim.submit.v1',
      network: input.network,
      collectionId: input.draft.collectionId,
      title: clip(input.draft.title, 120),
      summary,
      data,
      evidence,
    },
  };
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

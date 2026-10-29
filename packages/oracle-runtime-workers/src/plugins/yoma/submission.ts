import type {
  BidSubmitOperation,
  ClaimSubmitOperation,
} from '@ixo/action-protocol';
import type { Model } from 'survey-core';
import type { ChainCall } from '../ixo-chain/http';
import type { Draft, Evidence } from './drafts';
import {
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

const MAX_ROWS = 60;
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

function choiceText(view: FormQuestion, value: unknown): string {
  return (
    view.options?.find((option) => option.value === value)?.text ??
    String(value)
  );
}

/** One answer as the person would read it back. */
export function answerText(
  view: FormQuestion,
  value: unknown,
  comment?: unknown,
): string {
  if (value === undefined || value === null || value === '') return '';
  switch (view.input) {
    case 'pick-one':
      return value === 'other' && comment
        ? String(comment)
        : choiceText(view, value);
    case 'yes-no':
      return choiceText(view, value);
    case 'pick-many':
      return (Array.isArray(value) ? value : [value])
        .map((item) =>
          item === 'other' && comment
            ? String(comment)
            : item === 'none'
              ? (view.noneText ?? 'None')
              : choiceText(view, item),
        )
        .join(', ');
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

/** The rows the card shows: every answered question in form order, at most 60. */
export function summaryRows(
  model: Model,
): Array<{ label: string; value: string }> {
  const rows: Array<{ label: string; value: string }> = [];
  for (const view of visibleQuestions(model)) {
    const question = questionAt(model, view.path);
    if (!question || question.isEmpty()) continue;
    rows.push({
      label: clip(labelOf(view), MAX_LABEL),
      value: clip(
        answerText(view, question.value, question.comment),
        MAX_VALUE,
      ),
    });
  }
  if (rows.length > MAX_ROWS) {
    const rest = rows.length - (MAX_ROWS - 1);
    return [
      ...rows.slice(0, MAX_ROWS - 1),
      { label: 'More answers', value: `${rest} more answers are included` },
    ];
  }
  return rows.length ? rows : [{ label: 'Answers', value: 'No answers' }];
}

type Network = ChainCall['network'];

export function networkLabel(
  network: Network,
): 'ixo mainnet' | 'ixo testnet' | 'ixo devnet' {
  return `ixo ${network}`;
}

/**
 * The application card for a finished application draft, from its open
 * model: the rows first, then the answers to send (which clears hidden and
 * file questions on that model).
 */
export function buildApplicationOperation(input: {
  network: Network;
  model: Model;
  draft: Pick<Draft, 'collectionId' | 'title'>;
}): BidSubmitOperation {
  const summary = summaryRows(input.model);
  return {
    kind: 'ixo.bid.submit.v1',
    network: networkLabel(input.network),
    collectionId: input.draft.collectionId,
    title: clip(input.draft.title, 120),
    role: 'SA',
    summary,
    data: JSON.stringify(submittableData(input.model)),
  };
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
 * The claim card for a finished claim draft, from its open model: rows and
 * files first, then the answers to send (which clears hidden and file
 * questions on that model). Undefined when it cannot fit the card: more
 * files than the card takes, or a question name too long to address one.
 */
export function buildClaimOperation(input: {
  network: Network;
  model: Model;
  draft: Pick<Draft, 'collectionId' | 'title' | 'evidence'>;
}): ClaimSubmitOperation | undefined {
  const summary = summaryRows(input.model);
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
    return undefined;
  return {
    kind: 'ixo.claim.submit.v1',
    network: networkLabel(input.network),
    collectionId: input.draft.collectionId,
    title: clip(input.draft.title, 120),
    summary,
    data: JSON.stringify(submittableData(input.model)),
    evidence,
  };
}

/**
 * The Hub's idempotency key: the same answers give the same card; changed
 * answers give a new one, and so does sending again after a card was
 * declined, expired or failed (`cardAttempt` counts those).
 */
export async function cardRequestKey(
  draft: Pick<Draft, 'form' | 'collectionId' | 'updatedAt' | 'cardAttempt'>,
): Promise<string> {
  const bytes = new Uint8Array(
    await crypto.subtle.digest(
      'SHA-256',
      new TextEncoder().encode(
        `${draft.form}:${draft.collectionId}:${draft.updatedAt}:${draft.cardAttempt}`,
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

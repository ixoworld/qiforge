import { findMessageForValue, type FieldSpec } from './catalog.js';
import { DAODAO_PROPOSAL_ACTION_ACTORS } from './daodao-schemas.js';
import type { ITrxMsg } from './schemas.js';

/** The most characters one field's value takes in a description. */
export const DESCRIBED_VALUE_MAX_CHARS = 120;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** `toAddress` as `to address`. */
function fieldWords(name: string): string {
  return name.replace(/([a-z0-9])([A-Z])/g, '$1 $2').toLowerCase();
}

function clipped(text: string): string {
  const line = text.replace(/\s+/g, ' ').trim();
  return line.length <= DESCRIBED_VALUE_MAX_CHARS
    ? line
    : `${line.slice(0, DESCRIBED_VALUE_MAX_CHARS - 1)}…`;
}

/** Each `{ amount, <key> }` of a list as `<amount> <label>`; undefined when one is not. */
function amounts(
  value: unknown,
  key: 'denom' | 'id',
  label: (name: string) => string,
): string | undefined {
  if (!Array.isArray(value)) return undefined;
  const parts: string[] = [];
  for (const item of value) {
    if (
      !isRecord(item) ||
      typeof item.amount !== 'string' ||
      typeof item[key] !== 'string'
    )
      return undefined;
    parts.push(`${item.amount} ${label(item[key])}`);
  }
  return parts.join(' + ');
}

/** A field's value in plain text, by its catalog kind. */
function valueText(field: FieldSpec, value: unknown): string {
  if (field.kind === 'coinArray') {
    const coins = amounts(value, 'denom', (denom) => denom);
    if (coins !== undefined) return coins || 'none';
  }
  if (field.kind === 'tokenBatchArray') {
    const tokens = amounts(value, 'id', (id) => `of token ${id}`);
    if (tokens !== undefined) return tokens;
  }
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean')
    return String(value);
  return JSON.stringify(value) ?? String(value);
}

/**
 * A catalog message with the values it carries, in one line: its message
 * name, then each field the catalog lists for it (in the catalog's order, as
 * words) with its value — coins as `<amount> <denom>`, token batches as
 * `<amount> of token <id>`, any other value as its text or JSON, each clipped
 * to {@link DESCRIBED_VALUE_MAX_CHARS}; a field without a value (absent or
 * an empty string, as a decoded message has it) is left out. `omit` leaves fields out (a proposal
 * action's actor, which the sentence around it names). A message the catalog
 * has no route for is named by its type url, with no values.
 */
export function describeMessageValues(
  message: ITrxMsg,
  options: { omit?: readonly string[] } = {},
): string {
  const spec = findMessageForValue(message);
  if (!spec) return message.typeUrl;
  const omit = new Set(options.omit ?? []);
  const parts = spec.fields
    .filter((field) => {
      const value = message.value[field.name];
      return !omit.has(field.name) && value !== undefined && value !== '';
    })
    .map(
      (field) =>
        `${fieldWords(field.name)} ${clipped(valueText(field, message.value[field.name]))}`,
    );
  return parts.length > 0
    ? `${spec.messageName} (${parts.join(', ')})`
    : spec.messageName;
}

/**
 * A DAO DAO proposal action as {@link describeMessageValues} words it,
 * without the field that names the group as its actor (the group's own
 * account does every action).
 */
export function describeDaoDaoProposalAction(action: ITrxMsg): string {
  const actor = Object.entries(DAODAO_PROPOSAL_ACTION_ACTORS).find(
    ([typeUrl]) => typeUrl === action.typeUrl,
  )?.[1];
  return describeMessageValues(action, actor ? { omit: [actor] } : {});
}

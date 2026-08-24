/**
 * What the assistant may write, and what it may see.
 *
 * The assistant is a *content* assistant: it owns prose. Custom IXO blocks are
 * behaviour — their props configure actions, authorisation, conditions, and
 * delegation — so only their two human-readable labels are writable, and two of
 * them are off limits entirely.
 */

import { proseBlockTypes } from './blocknote-bridge.js';

/**
 * The custom blocks the IXO editor registers on top of BlockNote's own set,
 * from `packages/editor/src/mantine/blocks/index.ts` (`blockSpecs`). All of
 * them declare `content: 'none'` — they carry no inline text, only props.
 */
export const IXO_BLOCK_TYPES: readonly string[] = [
  'action',
  'apiRequest',
  'checkbox',
  'claim',
  'domainCardViewer',
  'domainCreator',
  'domainCreatorSign',
  'dynamicList',
  'email',
  'embed',
  'enumChecklist',
  'evaluator',
  'flowLink',
  'form',
  'governanceGroup',
  'list',
  'location',
  'notify',
  'overview',
  'proposal',
  'protocolSelector',
  'secrets',
  'skills',
  'visualization',
];

/** Blocks the assistant never writes to, whatever the prop. */
export const LOCKED_BLOCK_TYPES: readonly string[] = ['secrets', 'skills'];

/** Blocks whose prop values are withheld on read. */
export const REDACTED_BLOCK_TYPES: readonly string[] = ['secrets'];

/** The only props writable on a custom IXO block. */
export const IXO_WRITABLE_PROPS: readonly string[] = ['title', 'description'];

/** Placeholder shown instead of a redacted prop value. */
export const REDACTED_VALUE = '[redacted]';

export type BlockClass = 'prose' | 'ixo' | 'locked' | 'unknown';

/**
 * Classify a block type.
 *
 * `unknown` covers block types this runtime has never heard of — a newer editor
 * version, or a block from another schema. They are treated like IXO blocks
 * (labels only, no text) rather than like prose, because assuming a block is
 * inert prose is the destructive assumption.
 */
export function classifyBlockType(blockType: string): BlockClass {
  if (LOCKED_BLOCK_TYPES.includes(blockType)) return 'locked';
  if (proseBlockTypes().has(blockType)) return 'prose';
  if (IXO_BLOCK_TYPES.includes(blockType)) return 'ixo';
  return 'unknown';
}

/** Prose blocks own their inline content; everything else has none. */
export function isTextEditable(blockType: string): boolean {
  return classifyBlockType(blockType) === 'prose';
}

export interface PropFilterResult {
  /** Props that may be written, normalised to attribute strings. */
  allowed: Record<string, string>;
  /** Props refused, with the reason to report to the agent. */
  rejected: Array<{ prop: string; reason: string }>;
}

function normalise(value: unknown): string {
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') {
    return String(value);
  }
  return JSON.stringify(value) ?? '';
}

/**
 * Split a requested prop patch into what may be written and what may not.
 *
 * - prose blocks: every prop (they are presentation only — alignment, colour,
 *   heading level).
 * - IXO blocks and unknown types: `title` and `description` only. Behavioural
 *   props (`conditions`, `authorisedActors`, action `type`, `inputs`,
 *   delegation config, …) are refused by falling outside that pair.
 * - locked blocks: nothing.
 */
export function filterWritableProps(
  blockType: string,
  props: Record<string, unknown>,
): PropFilterResult {
  const result: PropFilterResult = { allowed: {}, rejected: [] };
  const blockClass = classifyBlockType(blockType);

  for (const [prop, value] of Object.entries(props)) {
    if (blockClass === 'locked') {
      result.rejected.push({
        prop,
        reason: `'${blockType}' blocks are never editable by the assistant`,
      });
      continue;
    }
    if (blockClass === 'prose' || IXO_WRITABLE_PROPS.includes(prop)) {
      result.allowed[prop] = normalise(value);
      continue;
    }
    result.rejected.push({
      prop,
      reason:
        `'${prop}' configures how the '${blockType}' block behaves — only ` +
        `${IXO_WRITABLE_PROPS.join(' and ')} are editable on this block type`,
    });
  }

  return result;
}

/**
 * Redact prop values the assistant must not relay. Keys stay visible so the
 * agent can still describe the block's shape.
 */
export function redactProps(
  blockType: string,
  props: Record<string, unknown>,
): Record<string, unknown> {
  if (!REDACTED_BLOCK_TYPES.includes(blockType)) return props;
  const redacted: Record<string, unknown> = {};
  for (const key of Object.keys(props)) {
    redacted[key] = REDACTED_VALUE;
  }
  return redacted;
}

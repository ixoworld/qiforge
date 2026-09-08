/**
 * Low-level Y.Doc block helpers for the flows plugin.
 *
 * These moved here from the editor plugin when it became a content assistant:
 * they read and write flow **run state** (`Y.Map('runtime')`) and the compiled
 * action blocks' `attrs` wrapper, which the content assistant must never touch.
 * The flows plugin owns run state, so it owns these.
 *
 * Everything here operates on an already-synced `Y.Doc` — no Matrix I/O.
 */

import * as Y from 'yjs';

const DEFAULT_FRAGMENT_NAME = 'document';
const DEFAULT_BLOCK_TYPE = 'paragraph';
const MUTATION_ORIGIN = 'ixo-oracle-flows';

// ── Attribute access ─────────────────────────────────────────────────
// BlockNote stores a block's canonical props under an `attrs` attribute whose
// value is an object, while yjs types XmlElement attributes as strings. The
// readers below narrow at runtime instead of asserting; the writer takes the
// element through a structural interface whose method signature is bivariant,
// so an object value is accepted without widening yjs's own types.

const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

interface AttributeWritable {
  setAttribute(attributeName: string, attributeValue: unknown): void;
}

const setAnyAttribute = (
  element: Y.XmlElement,
  key: string,
  value: unknown,
): void => {
  const target: AttributeWritable = element;
  target.setAttribute(key, value);
};

/** A block's `id`, whether stored on the element or inside `attrs`. */
function readIdAttribute(element: Y.XmlElement): string | undefined {
  const attrs = readAttrsObject(element);
  const fromAttrs = attrs?.id;
  if (typeof fromAttrs === 'string') return fromAttrs;
  const direct = element.getAttribute('id');
  return typeof direct === 'string' ? direct : undefined;
}

/** The `attrs` object BlockNote keeps a block's canonical props in. */
function readAttrsObject(
  element: Y.XmlElement,
): Record<string, unknown> | undefined {
  const attributes: Record<string, unknown> = element.getAttributes();
  const attrs = attributes.attrs;
  return isPlainObject(attrs) ? attrs : undefined;
}

function safeParseJson(value: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    return undefined;
  }
}

// ── Traversal ────────────────────────────────────────────────────────

export interface BlockDetail {
  id: string;
  blockType: string;
  nodeName: string;
  attributes: Record<string, unknown>;
  text?: string;
  children?: BlockDetail[];
}

export interface BlockSnapshot {
  id: string;
  type: string;
  text: string;
  attributes: Record<string, unknown>;
}

export interface ParentResult {
  parent: Y.XmlElement | Y.XmlFragment;
  index: number;
}

function findBlockById(
  container: Y.XmlElement | Y.XmlFragment,
  blockId: string,
): Y.XmlElement | null {
  for (const node of container.toArray()) {
    if (!(node instanceof Y.XmlElement)) continue;
    if (readIdAttribute(node) === blockId) return node;
    const nested = findBlockById(node, blockId);
    if (nested) return nested;
  }
  return null;
}

/** Walk the tree to find a block's parent container and its index within it. */
export const findParentOf = (
  container: Y.XmlElement | Y.XmlFragment,
  blockId: string,
): ParentResult | null => {
  const nodes = container.toArray();
  for (let i = 0; i < nodes.length; i += 1) {
    const node = nodes[i];
    if (!(node instanceof Y.XmlElement)) continue;
    if (readIdAttribute(node) === blockId)
      return { parent: container, index: i };
    const nested = findParentOf(node, blockId);
    if (nested) return nested;
  }
  return null;
};

function extractText(element: Y.XmlElement): string {
  const parts: string[] = [];
  const visit = (node: Y.XmlElement | Y.XmlText): void => {
    if (node instanceof Y.XmlText) {
      parts.push(node.toString());
      return;
    }
    for (const child of node.toArray()) {
      if (child instanceof Y.XmlElement || child instanceof Y.XmlText) {
        visit(child);
      }
    }
  };
  visit(element);
  return parts.join('');
}

function extractBlockDetail(
  element: Y.XmlElement | Y.XmlText,
): BlockDetail | null {
  if (element instanceof Y.XmlText) {
    return {
      id: '',
      nodeName: '#text',
      blockType: '',
      attributes: {},
      children: [],
      text: element.toString(),
    };
  }

  const detail: BlockDetail = {
    id: element.getAttribute('id') || '',
    nodeName: element.nodeName,
    blockType: '',
    attributes: {},
  };

  for (const [key, value] of Object.entries(element.getAttributes())) {
    detail.attributes[key] = value;
  }

  const attrsValue = readAttrsObject(element);
  if (attrsValue) {
    detail.attributes.attrs = attrsValue;
    const attrsType = attrsValue.type;
    if (typeof attrsType === 'string') detail.blockType = attrsType;
  }

  detail.children = [];
  for (const child of element.toArray()) {
    if (child instanceof Y.XmlElement || child instanceof Y.XmlText) {
      const childDetail = extractBlockDetail(child);
      if (childDetail) detail.children.push(childDetail);
    }
  }

  const textContent = extractText(element);
  if (textContent.length > 0) detail.text = textContent;

  return detail;
}

/** Every `blockContainer` in the document, depth-first. */
export function collectAllBlocks(fragment: Y.XmlFragment): BlockDetail[] {
  const results: BlockDetail[] = [];

  const walk = (container: Y.XmlElement | Y.XmlFragment): void => {
    for (const node of container.toArray()) {
      if (!(node instanceof Y.XmlElement)) continue;
      if (node.nodeName === 'blockContainer') {
        const detail = extractBlockDetail(node);
        if (detail) results.push(detail);
      }
      walk(node);
    }
  };

  walk(fragment);
  return results;
}

/** One block's detail, or `null` when the id is not in the document. */
export function getBlockDetail(
  doc: Y.Doc,
  blockId: string,
): BlockDetail | null {
  const container = findBlockById(
    doc.getXmlFragment(DEFAULT_FRAGMENT_NAME),
    blockId,
  );
  return container ? extractBlockDetail(container) : null;
}

/**
 * Flatten a block's props out of the CRDT structure:
 *   1. every entry from `attrs.props` (canonical)
 *   2. gaps filled from the content element's direct attributes
 *   3. JSON-string props (`surveySchema`, `answers`, `inputs`, `links`) parsed
 *
 * Generic — no per-block-type field names.
 */
export function extractBlockProperties(
  detail: BlockDetail,
): Record<string, unknown> {
  const merged: Record<string, unknown> = {};

  const directAttrs = detail.attributes || {};
  const attrsObj = isPlainObject(directAttrs.attrs) ? directAttrs.attrs : {};
  const attrsProps = isPlainObject(attrsObj.props) ? attrsObj.props : {};
  for (const [key, value] of Object.entries(attrsProps)) {
    merged[key] = value;
  }

  const contentChild = detail.children?.find(
    (child) =>
      child.nodeName &&
      child.nodeName !== '#text' &&
      child.nodeName !== 'blockGroup' &&
      child.nodeName !== 'blockContainer',
  );
  if (contentChild) {
    for (const [key, value] of Object.entries(contentChild.attributes || {})) {
      if (key === 'id' || key === 'attrs') continue;
      if (!(key in merged)) merged[key] = value;
    }
  }

  for (const key of ['surveySchema', 'answers', 'inputs'] as const) {
    const raw = merged[key];
    if (typeof raw !== 'string') continue;
    const parsed = safeParseJson(raw);
    if (isPlainObject(parsed)) merged[key] = parsed;
  }
  if (typeof merged.links === 'string') {
    const parsed = safeParseJson(merged.links);
    if (Array.isArray(parsed)) merged.links = parsed;
  }

  return merged;
}

// ── Run state ────────────────────────────────────────────────────────

/**
 * Read per-block run state from `Y.Map('runtime')`. Scoped to one block when
 * `nodeId` is given.
 */
export function readRuntimeState(
  doc: Y.Doc,
  nodeId?: string,
): Record<string, Record<string, unknown>> {
  const runtimeMap = doc.getMap('runtime');
  if (nodeId) {
    const state = runtimeMap.get(nodeId);
    return isPlainObject(state) ? { [nodeId]: state } : {};
  }
  const result: Record<string, Record<string, unknown>> = {};
  runtimeMap.forEach((value, key) => {
    if (isPlainObject(value)) result[key] = value;
  });
  return result;
}

/**
 * Merge updates into a block's run state. Must be called inside a
 * `doc.transact()` by the caller.
 */
export function updateRuntimeState(
  doc: Y.Doc,
  blockId: string,
  updates: Record<string, unknown>,
): Record<string, unknown> {
  const runtimeMap = doc.getMap('runtime');
  const existing = runtimeMap.get(blockId);
  const merged = { ...(isPlainObject(existing) ? existing : {}), ...updates };
  runtimeMap.set(blockId, merged);
  return merged;
}

// ── Mutations ────────────────────────────────────────────────────────

function snapshotBlock(element: Y.XmlElement): BlockSnapshot {
  const attrs = readAttrsObject(element) ?? {};
  const blockId = readIdAttribute(element);
  if (!blockId) throw new Error('Unable to derive block id from element');

  const blockType =
    (typeof attrs.type === 'string' ? attrs.type : undefined) ??
    element.nodeName;
  const textNode = element
    .toArray()
    .find(
      (node): node is Y.XmlElement =>
        node instanceof Y.XmlElement && node.nodeName !== 'blockGroup',
    );

  return {
    id: blockId,
    type: blockType,
    text: textNode ? extractText(textNode) : '',
    attributes: attrs,
  };
}

function applyAttributeUpdates(
  element: Y.XmlElement,
  updates: Record<string, unknown> = {},
  removals: string[] = [],
): void {
  const existing = readAttrsObject(element) ?? {};
  const { props: propsUpdates, ...rest } = updates;
  const next: Record<string, unknown> = { ...existing, ...rest };

  if (isPlainObject(propsUpdates)) {
    const existingProps = isPlainObject(existing.props) ? existing.props : {};
    const mergedProps: Record<string, unknown> = { ...existingProps };

    for (const [key, value] of Object.entries(propsUpdates)) {
      // Auto-serialize: when the stored value is a JSON string and the new
      // value is structured, merge (objects) or replace (arrays) and write the
      // JSON string back.
      if (
        typeof existingProps[key] === 'string' &&
        value !== null &&
        typeof value === 'object'
      ) {
        if (Array.isArray(value)) {
          mergedProps[key] = JSON.stringify(value);
        } else {
          const parsed = safeParseJson(String(existingProps[key]));
          const existingObj = isPlainObject(parsed) ? parsed : {};
          mergedProps[key] = JSON.stringify({ ...existingObj, ...value });
        }
      } else {
        mergedProps[key] = value;
      }
    }

    next.props = mergedProps;
  }

  for (const key of removals) {
    if (key.startsWith('props.')) {
      const propKey = key.slice('props.'.length);
      if (isPlainObject(next.props)) delete next.props[propKey];
      continue;
    }
    delete next[key];
  }

  setAnyAttribute(element, 'attrs', next);

  const nextId = next.id;
  if (typeof nextId === 'string') element.setAttribute('id', nextId);

  const blockContent = element
    .toArray()
    .find(
      (node): node is Y.XmlElement =>
        node instanceof Y.XmlElement && node.nodeName !== 'blockGroup',
    );

  // Mirror the post-merge props onto the content element so JSON-string props
  // carry their serialized value.
  if (
    blockContent &&
    isPlainObject(next.props) &&
    isPlainObject(propsUpdates)
  ) {
    const finalProps = next.props;
    for (const key of Object.keys(propsUpdates)) {
      const value = finalProps[key];
      blockContent.setAttribute(
        key,
        typeof value === 'string' ? value : JSON.stringify(value),
      );
    }
  }

  if (blockContent) {
    for (const key of removals) {
      if (!key.startsWith('props.')) continue;
      blockContent.removeAttribute(key.slice('props.'.length));
    }
  }
}

function applyTextUpdate(
  element: Y.XmlElement,
  text: string | null | undefined,
): void {
  if (typeof text === 'undefined') return;

  const blockContent = element
    .toArray()
    .find(
      (node): node is Y.XmlElement =>
        node instanceof Y.XmlElement && node.nodeName !== 'blockGroup',
    );

  if (!blockContent) {
    if (text === null || text === '') return;
    const contentNode = new Y.XmlElement(DEFAULT_BLOCK_TYPE);
    const inlineText = new Y.XmlText();
    inlineText.insert(0, text);
    contentNode.push([inlineText]);
    element.push([contentNode]);
    return;
  }

  const textNode = blockContent
    .toArray()
    .find((child): child is Y.XmlText => child instanceof Y.XmlText);

  if (!textNode) {
    if (text === null || text === '') return;
    const inlineText = new Y.XmlText();
    inlineText.insert(0, text);
    blockContent.push([inlineText]);
    return;
  }

  textNode.delete(0, textNode.length);
  if (text && text.length > 0) textNode.insert(0, text);
}

export interface EditBlockOptions {
  blockId: string;
  attributes?: Record<string, unknown>;
  removeAttributes?: string[];
  text?: string | null;
  /** Fragment to edit; defaults to the document fragment. */
  docName?: string;
}

/** Update a block's `attrs`/props and optionally its plain text. */
export const editBlock = (
  doc: Y.Doc,
  options: EditBlockOptions,
): BlockSnapshot => {
  const {
    blockId,
    attributes = {},
    removeAttributes = [],
    text,
    docName = DEFAULT_FRAGMENT_NAME,
  } = options;

  let snapshot: BlockSnapshot | undefined;

  doc.transact(() => {
    const fragment = doc.getXmlFragment(docName);
    const target = findBlockById(fragment, blockId);
    if (!target) throw new Error(`Block with id ${blockId} not found`);

    applyAttributeUpdates(target, attributes, removeAttributes);
    applyTextUpdate(target, text);
    snapshot = snapshotBlock(target);
  }, MUTATION_ORIGIN);

  if (!snapshot) throw new Error('Failed to update block snapshot');
  return snapshot;
};

export interface DeleteBlockOptions {
  blockId: string;
  /** Fragment to delete from; defaults to the document fragment. */
  docName?: string;
}

/** Remove a block by id. Returns `false` when the id is not in the document. */
export const deleteBlock = (
  doc: Y.Doc,
  options: DeleteBlockOptions,
): boolean => {
  const { blockId, docName = DEFAULT_FRAGMENT_NAME } = options;
  let deleted = false;

  const deleteFromContainer = (
    container: Y.XmlElement | Y.XmlFragment,
  ): boolean => {
    const nodes = container.toArray();
    for (let i = 0; i < nodes.length; i += 1) {
      const node = nodes[i];
      if (!(node instanceof Y.XmlElement)) continue;
      if (readIdAttribute(node) === blockId) {
        container.delete(i, 1);
        return true;
      }
      if (deleteFromContainer(node)) return true;
    }
    return false;
  };

  doc.transact(() => {
    deleted = deleteFromContainer(doc.getXmlFragment(docName));
  }, MUTATION_ORIGIN);

  return deleted;
};

// ── Survey shapes ────────────────────────────────────────────────────

/** One question in a form step's SurveyJS schema. */
export interface SurveyElement {
  type: string;
  name: string;
  title?: string;
  description?: string;
  isRequired?: boolean;
  visibleIf?: string;
  defaultValue?: unknown;
  defaultValueExpression?: string;
  inputType?: string;
  choices?: Array<{ value: string; text: string }>;
  choicesByUrl?: {
    url: string;
    valueName: string;
    titleName: string;
  };
  templateElements?: SurveyElement[];
  elements?: SurveyElement[];
}

/**
 * Helper functions for Y.js BlockNote operations
 *
 * These functions handle the low-level Y.Doc operations
 * that the LangChain tools use.
 *
 * Matches the pattern from the CLI commands (runAddBlock, runEditBlock, etc.)
 */

import type { MatrixClient } from 'matrix-js-sdk';
import * as Y from 'yjs';

import type { AppConfig } from './provider.js';
import { MatrixProviderManager } from './provider.js';
import { parseSurveyAnswers, parseSurveySchema } from './survey-helpers.js';

// Re-export helpers from blockActions for consistency
export {
  appendBlock,
  editBlock,
  deleteBlock,
  type BlockSnapshot,
} from './block-actions.js';

// ─── Core Block Detail ───────────────────────────────────────────────

export interface BlockDetail {
  id: string;
  blockType: string;
  nodeName: string;
  attributes: Record<string, unknown>;
  text?: string;
  children?: BlockDetail[];
}

// ─── Condition System (stable structural types needed for evaluation) ─

export type ConditionOperator =
  | 'equals'
  | 'not_equals'
  | 'greater_than'
  | 'less_than'
  | 'contains'
  | 'not_contains'
  | 'is_empty'
  | 'is_not_empty';

export type ConditionEffect = 'enable' | 'disable' | 'hide' | 'show';

export interface BlockCondition {
  id: string;
  name: string;
  description?: string;
  sourceBlockId: string;
  sourceBlockType: string;
  rule: {
    type: 'property_value';
    property: string;
    operator: ConditionOperator;
    value: string | number | boolean;
  };
  effect: {
    action: ConditionEffect;
    message?: string;
  };
}

export interface ConditionConfig {
  enabled: boolean;
  mode: 'all_must_pass' | 'any_can_pass';
  conditions: BlockCondition[];
}

export interface ConditionEvaluationResult {
  isVisible: boolean;
  isEnabled: boolean;
  actions: Array<{
    action: ConditionEffect;
    message?: string;
    conditionName: string;
  }>;
}

/**
 * Initialize provider, do work, and dispose
 * This matches the pattern from runAddBlock.ts exactly
 */
export async function withProvider<T>(
  matrixClient: MatrixClient,
  config: AppConfig,
  work: (doc: Y.Doc) => T | Promise<T>,
): Promise<T> {
  const providerManager = new MatrixProviderManager(matrixClient, config);

  try {
    const { doc } = await providerManager.init();
    const result = await work(doc);
    return result;
  } finally {
    await providerManager.dispose();
  }
}

/**
 * Find a block container by ID
 */
export function findBlockById(
  container: Y.XmlElement | Y.XmlFragment,
  blockId: string,
): Y.XmlElement | null {
  const nodes = container.toArray();

  for (const node of nodes) {
    if (!(node instanceof Y.XmlElement)) {
      continue;
    }

    const candidateId = node.getAttribute('id');
    if (candidateId === blockId) {
      return node;
    }

    // Recursively search nested structures
    const nested = findBlockById(node, blockId);
    if (nested) {
      return nested;
    }
  }

  return null;
}

// Helper to get any attribute (same as blockActions.ts)
export const getAnyAttribute = <T>(
  element: Y.XmlElement,
  key: string,
): T | undefined => {
  return element.getAttribute(key) as unknown as T | undefined;
};

/**
 * Extract text content from an element (EXACT copy from runListBlocks.ts)
 */
export function extractText(element: Y.XmlElement): string {
  const parts: string[] = [];
  const visit = (node: Y.XmlElement | Y.XmlText) => {
    if (node instanceof Y.XmlText) {
      parts.push(node.toString());
      return;
    }
    node.toArray().forEach((child) => {
      if (child instanceof Y.XmlElement || child instanceof Y.XmlText) {
        visit(child);
      }
    });
  };
  visit(element);
  return parts.join('');
}

/**
 * Extract complete block details (EXACT copy from runListBlocks.ts - THE WORKING VERSION!)
 */
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

  const xmlAttrs = element.getAttributes();
  for (const [key, value] of Object.entries(xmlAttrs)) {
    detail.attributes[key] = value;
  }

  const attrsValue = getAnyAttribute<Record<string, unknown>>(element, 'attrs');
  if (attrsValue) {
    detail.attributes.attrs = attrsValue;
    // Extract blockType from attrs if available
    const attrsType = attrsValue.type;
    if (typeof attrsType === 'string') {
      detail.blockType = attrsType;
    }
  }

  const children = element.toArray();
  detail.children = [];
  for (const child of children) {
    if (child instanceof Y.XmlElement || child instanceof Y.XmlText) {
      const childDetail = extractBlockDetail(child);
      if (childDetail) {
        detail.children.push(childDetail);
      }
    }
  }

  const textContent = extractText(element);
  if (textContent.length > 0) {
    detail.text = textContent;
  }

  return detail;
}

/**
 * Extract user-facing properties from a block.
 * Flattens the internal CRDT structure so ALL block properties are visible:
 *   1. Extracts every entry from attrs.props (the canonical source)
 *   2. Fills gaps from child element direct attributes (BlockNote mirrors props there)
 *   3. Parses surveySchema and answers from JSON strings when present
 *
 * Generic — works for any block type without hardcoding field names.
 */
export function extractBlockProperties(
  detail: BlockDetail,
): Record<string, unknown> {
  const merged: Record<string, unknown> = {};

  // --- Source 1: attrs.props on the blockContainer (canonical) ---
  const directAttrs = detail.attributes || {};
  const attrsObj =
    (directAttrs.attrs as Record<string, unknown> | undefined) || {};
  const attrsProps =
    (attrsObj.props as Record<string, unknown> | undefined) || {};

  for (const [key, value] of Object.entries(attrsProps)) {
    merged[key] = value;
  }

  // --- Source 2: child element direct attributes ---
  // BlockNote mirrors props as direct attributes on the typed child element
  const contentChild = detail.children?.find(
    (c) =>
      c.nodeName &&
      c.nodeName !== '#text' &&
      c.nodeName !== 'blockGroup' &&
      c.nodeName !== 'blockContainer',
  );
  if (contentChild) {
    for (const [key, value] of Object.entries(contentChild.attributes || {})) {
      // Skip structural keys that are not user-facing props
      if (key === 'id' || key === 'attrs') continue;
      if (!(key in merged)) {
        merged[key] = value;
      }
    }
  }

  // --- Parse JSON strings for known structured fields ---
  if (typeof merged.surveySchema === 'string') {
    const parsedSchema = parseSurveySchema(merged.surveySchema);
    if (parsedSchema) {
      merged.surveySchema = parsedSchema;
    }
  }

  if (typeof merged.answers === 'string') {
    const parsedAnswers = parseSurveyAnswers(merged.answers);
    if (parsedAnswers && Object.keys(parsedAnswers).length > 0) {
      merged.answers = parsedAnswers;
    }
  }

  // Parse `inputs` JSON string so agents see structured data
  if (typeof merged.inputs === 'string') {
    try {
      const parsed = JSON.parse(merged.inputs);
      if (parsed && typeof parsed === 'object') {
        merged.inputs = parsed;
      }
    } catch {
      // keep raw string if not valid JSON
    }
  }

  // Parse `links` JSON string so agents see structured data
  if (typeof merged.links === 'string') {
    try {
      const parsed = JSON.parse(merged.links);
      if (Array.isArray(parsed)) {
        merged.links = parsed;
      }
    } catch {
      // keep raw string if not valid JSON
    }
  }

  return merged;
}

/**
 * Transform block detail into agent-friendly format
 */
export function simplifyBlockForAgent(detail: BlockDetail): {
  id: string;
  type: string;
  properties: Record<string, unknown>;
  text?: string;
} {
  // Use detail.blockType (already extracted in extractBlockDetail)
  // If not available, check first child element's nodeName
  // Fallback to nodeName
  let blockType = detail.blockType;

  if (!blockType && detail.children && detail.children.length > 0) {
    const firstChild = detail.children.find(
      (c) =>
        c.nodeName && c.nodeName !== '#text' && c.nodeName !== 'blockGroup',
    );
    if (firstChild) {
      blockType = firstChild.nodeName;
    }
  }

  if (!blockType) {
    blockType = detail.nodeName;
  }

  const properties = extractBlockProperties(detail);

  return {
    id: detail.id,
    type: blockType,
    properties,
    ...(detail.text && { text: detail.text }),
  };
}

/**
 * Collect all block containers from the document (EXACT copy from runListBlocks.ts)
 */
export function collectAllBlocks(
  fragment: Y.XmlFragment,
  _includeText: boolean = true,
): BlockDetail[] {
  const results: BlockDetail[] = [];

  function collectBlockContainers(
    container: Y.XmlElement | Y.XmlFragment,
    results: BlockDetail[],
  ): void {
    const nodes = container.toArray();
    for (const node of nodes) {
      if (!(node instanceof Y.XmlElement)) {
        continue;
      }

      if (node.nodeName === 'blockContainer') {
        const detail = extractBlockDetail(node);
        if (detail) {
          results.push(detail);
        }
      }
      collectBlockContainers(node, results);
    }
  }

  collectBlockContainers(fragment, results);
  return results;
}

/**
 * Get block by ID and return its details
 */
export function getBlockDetail(
  doc: Y.Doc,
  blockId: string,
  _includeText: boolean = true,
): BlockDetail | null {
  const fragment = doc.getXmlFragment('document');
  const blockContainer = findBlockById(fragment, blockId);

  if (!blockContainer) {
    return null;
  }

  return extractBlockDetail(blockContainer);
}

// ─── Y.Doc Namespace Helpers ─────────────────────────────────────────
// Pure functions that read from Y.Doc namespaces beyond 'document'.
// Each operates on an already-synced Y.Doc — no Matrix I/O.

/**
 * Read flow metadata from Y.Map('root') + Y.Text('title').
 * Returns ALL entries from the root map — no field filtering.
 */
export function readFlowMetadata(doc: Y.Doc): Record<string, unknown> {
  const root = doc.getMap('root');
  const titleText = doc.getText('title');
  const result: Record<string, unknown> = {};
  root.forEach((value, key) => {
    result[key] = value;
  });
  // Title from Y.Text takes precedence over root map entry
  const titleStr = titleText.toString();
  if (titleStr) {
    result.title = titleStr;
  }
  return result;
}

/**
 * Read all flow nodes from Y.Array('flow').
 * Returns raw entries without type casting.
 */
export function readFlowNodes(doc: Y.Doc): Record<string, unknown>[] {
  const flowArray = doc.getArray('flow');
  return flowArray.toArray() as Record<string, unknown>[];
}

/**
 * Read runtime state from Y.Map('runtime').
 * If nodeId provided, returns only that node's state.
 * Returns raw objects — no type filtering.
 */
export function readRuntimeState(
  doc: Y.Doc,
  nodeId?: string,
): Record<string, Record<string, unknown>> {
  const runtimeMap = doc.getMap('runtime');
  if (nodeId) {
    const state = runtimeMap.get(nodeId) as Record<string, unknown> | undefined;
    return state ? { [nodeId]: state } : {};
  }
  const result: Record<string, Record<string, unknown>> = {};
  runtimeMap.forEach((value, key) => {
    if (value && typeof value === 'object') {
      result[key] = value as Record<string, unknown>;
    }
  });
  return result;
}

/**
 * Merge updates into a block's runtime state in Y.Map('runtime').
 * Reads existing state first, spreads, then writes the merged result.
 * Must be called inside a doc.transact() by the caller.
 */
export function updateRuntimeState(
  doc: Y.Doc,
  blockId: string,
  updates: Record<string, unknown>,
): Record<string, unknown> {
  const runtimeMap = doc.getMap('runtime');
  const existing = (runtimeMap.get(blockId) as Record<string, unknown>) || {};
  const merged = { ...existing, ...updates };
  runtimeMap.set(blockId, merged);
  return merged;
}

/**
 * Read audit trail events for a specific block from Y.Map('auditTrail').
 * Returns raw entries without type casting.
 */
export function readAuditTrailForBlock(
  doc: Y.Doc,
  blockId: string,
): Record<string, unknown>[] {
  const auditTrailMap = doc.getMap('auditTrail');
  const eventsArray = auditTrailMap.get(blockId);
  if (!eventsArray || !(eventsArray instanceof Y.Array)) {
    return [];
  }
  return eventsArray
    .toArray()
    .filter(
      (e): e is Record<string, unknown> => e != null && typeof e === 'object',
    );
}

/**
 * Read invocations from Y.Map('invocations'), optionally filtered by blockId.
 * Sorted by executedAt descending (most recent first) if the field exists.
 * Returns raw entries without type casting.
 */
export function readInvocations(
  doc: Y.Doc,
  blockId?: string,
): Record<string, unknown>[] {
  const invocationsMap = doc.getMap('invocations');
  const all: Record<string, unknown>[] = [];
  invocationsMap.forEach((value) => {
    if (value && typeof value === 'object') {
      all.push(value as Record<string, unknown>);
    }
  });
  // Sort by executedAt if present (entries without it sort last)
  const sorted = all.sort((a, b) => {
    const aTime = typeof a.executedAt === 'number' ? a.executedAt : 0;
    const bTime = typeof b.executedAt === 'number' ? b.executedAt : 0;
    return bTime - aTime;
  });
  return blockId ? sorted.filter((i) => i.blockId === blockId) : sorted;
}

/**
 * Read delegations from Y.Map('delegations').
 * Handles both v2 StoredEntry { v: 2, data: ... } and legacy JSON strings.
 * Returns raw entries without type casting.
 */
export function readDelegations(doc: Y.Doc): {
  rootCid: string | null;
  delegations: Record<string, unknown>[];
} {
  const ROOT_KEY = '__root__';
  const VERSION_KEY = '__version__';
  const delegationsMap = doc.getMap('delegations');
  const rootCid = (delegationsMap.get(ROOT_KEY) as string) || null;
  const delegations: Record<string, unknown>[] = [];

  delegationsMap.forEach((value, key) => {
    if (key === ROOT_KEY || key === VERSION_KEY) return;

    // New v2 format: { v: 2, data: {...} }
    if (
      value &&
      typeof value === 'object' &&
      (value as Record<string, unknown>).v === 2 &&
      (value as Record<string, unknown>).data
    ) {
      delegations.push(
        (value as { v: number; data: Record<string, unknown> }).data,
      );
      return;
    }

    // Legacy format: JSON string — normalize + spread all original fields
    if (typeof value === 'string') {
      try {
        const parsed = JSON.parse(value) as Record<string, unknown>;
        delegations.push({
          ...parsed,
          cid: parsed.id || key,
          issuerDid: parsed.issuer || '',
          audienceDid: parsed.audience || '',
          capabilities: parsed.capabilities || [],
          expiration: parsed.expiration,
          createdAt: parsed.issuedAt
            ? new Date(parsed.issuedAt as string).getTime()
            : 0,
          format: 'legacy',
          proofCids: parsed.proofs || [],
        });
      } catch {
        /* skip malformed entries */
      }
    }
  });

  return { rootCid, delegations };
}

/**
 * Evaluate a block's condition config against all blocks in the document.
 * Returns computed visibility and enabled state.
 */
export function evaluateBlockConditions(
  conditionConfig: ConditionConfig,
  allBlocks: BlockDetail[],
): ConditionEvaluationResult {
  if (!conditionConfig.enabled || conditionConfig.conditions.length === 0) {
    return { isVisible: true, isEnabled: true, actions: [] };
  }

  // Build a props map keyed by block ID for fast lookup
  const blockPropsMap = new Map<string, Record<string, unknown>>();
  allBlocks.forEach((b) => {
    // Merge direct attributes and nested attrs.props
    const attrs = b.attributes || {};
    const attrsObj = (attrs.attrs as Record<string, unknown> | undefined) || {};
    const props = (attrsObj.props as Record<string, unknown> | undefined) || {};
    blockPropsMap.set(b.id, { ...attrs, ...attrsObj, ...props });
  });

  const results = conditionConfig.conditions.map((condition) => {
    const sourceProps = blockPropsMap.get(condition.sourceBlockId);
    if (!sourceProps) return { condition, passes: false };

    const sourceValue = sourceProps[condition.rule.property];
    const ruleValue = condition.rule.value;
    let passes = false;

    switch (condition.rule.operator) {
      case 'equals':
        passes = String(sourceValue) === String(ruleValue);
        break;
      case 'not_equals':
        passes = String(sourceValue) !== String(ruleValue);
        break;
      case 'greater_than':
        passes = Number(sourceValue) > Number(ruleValue);
        break;
      case 'less_than':
        passes = Number(sourceValue) < Number(ruleValue);
        break;
      case 'contains':
        passes = String(sourceValue ?? '')
          .toLowerCase()
          .includes(String(ruleValue).toLowerCase());
        break;
      case 'not_contains':
        passes = !String(sourceValue ?? '')
          .toLowerCase()
          .includes(String(ruleValue).toLowerCase());
        break;
      case 'is_empty':
        passes =
          sourceValue === undefined ||
          sourceValue === null ||
          String(sourceValue).trim() === '';
        break;
      case 'is_not_empty':
        passes =
          sourceValue !== undefined &&
          sourceValue !== null &&
          String(sourceValue).trim() !== '';
        break;
    }
    return { condition, passes };
  });

  // Aggregate based on mode
  const allPass =
    conditionConfig.mode === 'all_must_pass'
      ? results.every((r) => r.passes)
      : results.some((r) => r.passes);

  const passingResults =
    conditionConfig.mode === 'all_must_pass'
      ? allPass
        ? results
        : []
      : results.filter((r) => r.passes);

  const actions = passingResults.map((r) => ({
    action: r.condition.effect.action,
    message: r.condition.effect.message,
    conditionName: r.condition.name,
  }));

  // Derive visibility and enabled state from actions
  const hasVisibilityConditions = conditionConfig.conditions.some(
    (c) => c.effect.action === 'show' || c.effect.action === 'hide',
  );
  const hasEnableConditions = conditionConfig.conditions.some(
    (c) => c.effect.action === 'enable' || c.effect.action === 'disable',
  );

  const hideActions = actions.filter((a) => a.action === 'hide');
  const showActions = actions.filter((a) => a.action === 'show');
  const disableActions = actions.filter((a) => a.action === 'disable');

  const isVisible = hasVisibilityConditions
    ? hideActions.length === 0 && (showActions.length > 0 || !allPass)
    : true;
  const isEnabled = hasEnableConditions ? disableActions.length === 0 : true;

  return { isVisible, isEnabled, actions };
}

/**
 * Resolve {{blockId.propPath}} template references in a string.
 * Returns the string with all references replaced by their resolved values.
 */
export function resolveBlockReferences(
  template: string,
  allBlocks: BlockDetail[],
): string {
  const REFERENCE_REGEX = /\{\{([a-zA-Z0-9_-]+)\.([a-zA-Z0-9_.]+)\}\}/g;

  // Build a props map for all blocks
  const blockPropsMap = new Map<string, Record<string, unknown>>();
  allBlocks.forEach((b) => {
    const attrs = b.attributes || {};
    const attrsObj = (attrs.attrs as Record<string, unknown> | undefined) || {};
    const props = (attrsObj.props as Record<string, unknown> | undefined) || {};
    blockPropsMap.set(b.id, { ...attrs, ...attrsObj, ...props });
  });

  return template.replace(REFERENCE_REGEX, (fullMatch, blockId, propPath) => {
    const props = blockPropsMap.get(blockId as string);
    if (!props) return fullMatch;

    // Navigate nested path (e.g. "response.data.items")
    const pathParts = (propPath as string).split('.');
    let value: unknown = props;

    for (const part of pathParts) {
      if (value && typeof value === 'object') {
        value = (value as Record<string, unknown>)[part];
      } else {
        return '';
      }
    }

    // For response props stored as JSON strings, parse and navigate
    if (pathParts[0] === 'response' && typeof props['response'] === 'string') {
      try {
        const parsed = JSON.parse(props['response']);
        let innerValue: unknown = parsed;
        for (const part of pathParts.slice(1)) {
          if (innerValue && typeof innerValue === 'object') {
            innerValue = (innerValue as Record<string, unknown>)[part];
          } else {
            return '';
          }
        }
        if (innerValue === undefined || innerValue === null) return '';
        if (typeof innerValue === 'object') return JSON.stringify(innerValue);
        return String(innerValue);
      } catch {
        /* fall through to default */
      }
    }

    if (value === undefined || value === null) return '';
    if (typeof value === 'object') return JSON.stringify(value);
    return String(value);
  });
}

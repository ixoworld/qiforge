/**
 * Test support: build a compiled-flow Y.Doc offline (no Matrix). Used by the
 * read/edit unit tests so they exercise the real compiled-flow shape.
 *
 * Why we hydrate with oracle-runtime's own yjs instead of the editor's
 * `hydrateYDocFromCompiledFlow`: the editor bundles a different yjs minor than
 * oracle-runtime, and inserting the editor's Y.Map/Y.XmlElement instances into
 * a doc created here throws ("Unexpected content type"). In production the
 * plugin never does that — flows are authored in the editor's own doc and reach
 * the plugin's provider doc as version-agnostic binary CRDT updates, so the
 * plugin's doc is always natively this yjs. We reproduce that native doc here.
 *
 * Only the trivial Y.Doc *writing* is mirrored (the layout is verified and
 * guarded by the read round-trip + the action snapshot canary); the compiler
 * itself is still `compileBaseUcanFlow`. Not a `*.test.ts` file.
 */
import * as Y from 'yjs';
import {
  compileBaseUcanFlow,
  getActionByCan,
  getAllActions,
  typeToCan,
} from '@ixo/editor/core';
import type {
  BaseUcanFlow,
  CompiledFlow,
  FlowNodeRuntimeState,
} from '@ixo/editor/core';
import { isEventCapable } from './actions.js';
import { stepIdToBlockId } from './translator.js';

/** A real registry action type with a `can`, picked dynamically so tests never hardcode a stale name. */
export function someActionType(): string {
  const withCan = getAllActions().find(
    (a) => typeof typeToCan(a.type) === 'string',
  );
  if (!withCan) throw new Error('no action with a `can` in the registry');
  return withCan.type;
}

/** A registry action that can source an `onEvent` trigger (event-capable, with a `can`). */
export function someEventCapableActionType(): string {
  const match = getAllActions().find(
    (a) => typeof typeToCan(a.type) === 'string' && isEventCapable(a),
  );
  if (!match) throw new Error('no event-capable action in the registry');
  return match.type;
}

/** A registry action that can NOT source an `onEvent` trigger, if the registry has one. */
export function someNonEventActionType(): string | undefined {
  return getAllActions().find(
    (a) => typeof typeToCan(a.type) === 'string' && !isEventCapable(a),
  )?.type;
}

function writeNodeMap(doc: Y.Doc, compiled: CompiledFlow): void {
  const nodes = doc.getMap('qi.flow.nodes');
  for (const nodeId of Object.keys(compiled.nodes)) {
    const node = compiled.nodes[nodeId];
    if (!node) continue;
    const yNode = new Y.Map<unknown>();
    yNode.set('id', node.id);
    yNode.set('blockId', node.blockId);
    yNode.set('can', node.can);
    yNode.set('with', node.with);
    yNode.set('registryType', node.registryType);
    yNode.set('title', node.title);
    yNode.set('description', node.description);
    if (node.phase) yNode.set('phase', node.phase);
    if (node.parallelGroup) yNode.set('parallelGroup', node.parallelGroup);
    if (node.actor) yNode.set('actor', node.actor);
    nodes.set(nodeId, yNode);
  }
}

function writeFragment(doc: Y.Doc, compiled: CompiledFlow): void {
  // Mirror documentFragment.ts `createBlockContainer`: blockGroup > blockContainer[id] >
  // blockContent[type] with each prop as a direct attribute (no `attrs` wrapper).
  const fragment = doc.getXmlFragment('document');
  const blockGroup = new Y.XmlElement('blockGroup');
  for (const block of compiled.blocks) {
    const props = block.props as Record<string, unknown>;
    const { backgroundColor, textColor, ...contentProps } = props;
    const container = new Y.XmlElement('blockContainer');
    container.setAttribute('id', block.id);
    container.setAttribute(
      'textColor',
      typeof textColor === 'string' ? textColor : 'default',
    );
    container.setAttribute(
      'backgroundColor',
      typeof backgroundColor === 'string' ? backgroundColor : 'default',
    );
    const content = new Y.XmlElement(block.type);
    for (const [key, value] of Object.entries(contentProps)) {
      if (value === '' || value == null) continue;
      content.setAttribute(
        key,
        typeof value === 'string' ? value : JSON.stringify(value),
      );
    }
    container.insert(0, [content]);
    blockGroup.insert(blockGroup.length, [container]);
  }
  fragment.insert(0, [blockGroup]);
}

/** Compile + hydrate a BaseUcanFlow plan into a standalone, natively-this-yjs Y.Doc. */
export function hydrateFlowDoc(plan: BaseUcanFlow): Y.Doc {
  const compiled = compileBaseUcanFlow(plan, { getActionByCan });
  const doc = new Y.Doc();
  doc.transact(() => {
    const meta = doc.getMap('qi.flow.meta');
    for (const [key, value] of Object.entries(compiled.meta)) {
      if (value !== undefined) meta.set(key, value);
    }
    writeNodeMap(doc, compiled);

    const edges = doc.getMap('qi.flow.edges');
    for (const edge of compiled.edges) {
      const yEdge = new Y.Map<unknown>();
      yEdge.set('id', edge.id);
      yEdge.set('source', edge.source);
      yEdge.set('target', edge.target);
      yEdge.set('kind', edge.kind);
      if (edge.condition) yEdge.set('condition', edge.condition);
      edges.set(edge.id, yEdge);
    }

    const order = doc.getArray<string>('qi.flow.order');
    for (const nodeId of compiled.order) order.push([nodeId]);

    const blockIndex = doc.getMap('qi.flow.blockIndex');
    for (const [nodeId, blockId] of Object.entries(compiled.blockIndex))
      blockIndex.set(nodeId, blockId);

    writeFragment(doc, compiled);

    const runtime = doc.getMap('runtime');
    for (const nodeId of compiled.order) {
      const blockId = compiled.blockIndex[nodeId];
      if (blockId) runtime.set(blockId, { state: 'idle' });
    }
  });
  return doc;
}

/** Seed a step's runtime entry (keyed by block id) to simulate a portal run. */
export function setStepRuntime(
  doc: Y.Doc,
  stepId: string,
  state: Partial<FlowNodeRuntimeState>,
): void {
  const runtime = doc.getMap('runtime');
  doc.transact(() => {
    const blockId = stepIdToBlockId(stepId);
    const existing = runtime.get(blockId);
    const base =
      existing && typeof existing === 'object'
        ? (existing as Record<string, unknown>)
        : {};
    runtime.set(blockId, { ...base, ...state });
  });
}

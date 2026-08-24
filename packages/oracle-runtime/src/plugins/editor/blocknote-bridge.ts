/**
 * The only place new BlockNote structure is created.
 *
 * Markdown is parsed and materialised by `@blocknote/server-util` — the
 * upstream BlockNote ↔ Y.js bridge — into a throwaway `Y.Doc`, then the
 * resulting nodes are cloned out as detached values the caller inserts into the
 * live document. Nothing here hand-builds `blockContainer` / `blockContent`
 * XML, and nothing here round-trips an existing document: `yXmlFragmentToBlocks`
 * silently drops any block type outside the default schema, so feeding a real
 * document (which carries custom IXO blocks) through it would delete them.
 *
 * `@blocknote/server-util` resolves the same yjs instance as this package, so
 * the nodes it produces can be inserted into our docs — unlike `@ixo/editor`'s
 * fragment helpers, which carry their own yjs copy.
 */

import { ServerBlockNoteEditor } from '@blocknote/server-util';
import * as Y from 'yjs';
import {
  DOCUMENT_FRAGMENT_NAME,
  getContentElement,
  getRootGroup,
} from './document-model.js';

/**
 * Building a `ServerBlockNoteEditor` spins up a JSDOM, so it is created once
 * and shared. It is stateless across calls.
 */
let cachedEditor: ServerBlockNoteEditor | undefined;

function serverEditor(): ServerBlockNoteEditor {
  cachedEditor ??= ServerBlockNoteEditor.create();
  return cachedEditor;
}

/**
 * The block types BlockNote itself provides (`paragraph`, `heading`,
 * `bulletListItem`, …). Read off the server editor's schema so the set always
 * matches the installed BlockNote version instead of a copied literal.
 */
export function proseBlockTypes(): ReadonlySet<string> {
  return new Set(Object.keys(serverEditor().editor.schema.blockSchema));
}

/**
 * Parse markdown into detached `blockContainer` elements ready to be inserted
 * into a live document.
 *
 * Returns `[]` for markdown that yields no blocks.
 */
export async function markdownToBlockContainers(
  markdown: string,
): Promise<Y.XmlElement[]> {
  const editor = serverEditor();
  const blocks = await editor.tryParseMarkdownToBlocks(markdown);
  if (blocks.length === 0) return [];

  const scratch = new Y.Doc();
  try {
    const fragment = scratch.getXmlFragment(DOCUMENT_FRAGMENT_NAME);
    editor.blocksToYXmlFragment(blocks, fragment);
    const group = getRootGroup(fragment);
    if (!group) return [];

    const containers: Y.XmlElement[] = [];
    for (const node of group.toArray()) {
      if (node instanceof Y.XmlElement && node.nodeName === 'blockContainer') {
        containers.push(node.clone());
      }
    }
    return containers;
  } finally {
    scratch.destroy();
  }
}

/**
 * Parse markdown into detached inline nodes for a single block's content —
 * `edit_block`'s text path. Multi-block markdown is flattened into the inline
 * content of every parsed block, so a caller replacing one paragraph's text
 * gets one paragraph's worth of inline nodes.
 */
export async function markdownToInlineContent(
  markdown: string,
): Promise<Array<Y.XmlText | Y.XmlElement>> {
  if (markdown.length === 0) return [];

  const editor = serverEditor();
  const blocks = await editor.tryParseMarkdownToBlocks(markdown);
  if (blocks.length === 0) return [];

  const scratch = new Y.Doc();
  try {
    const fragment = scratch.getXmlFragment(DOCUMENT_FRAGMENT_NAME);
    editor.blocksToYXmlFragment(blocks, fragment);
    const group = getRootGroup(fragment);
    if (!group) return [];

    const nodes: Array<Y.XmlText | Y.XmlElement> = [];
    for (const node of group.toArray()) {
      if (!(node instanceof Y.XmlElement)) continue;
      if (node.nodeName !== 'blockContainer') continue;
      const content = getContentElement(node);
      if (!content) continue;
      for (const inline of content.toArray()) {
        if (inline instanceof Y.XmlText || inline instanceof Y.XmlElement) {
          nodes.push(inline.clone());
        }
      }
    }
    return nodes;
  } finally {
    scratch.destroy();
  }
}

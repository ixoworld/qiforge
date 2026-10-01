/**
 * Block-tree mapping and mutation, against a plain `Y.Doc` with no Matrix.
 *
 * The fixture builds documents through `@blocknote/server-util` (the same path
 * production uses for new content) so the tests exercise the real BlockNote
 * CRDT layout rather than a hand-drawn approximation of it.
 */

import { describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import {
  markdownToBlockContainers,
  markdownToInlineContent,
} from './blocknote-bridge.js';
import {
  DOCUMENT_FRAGMENT_NAME,
  appendBlocks,
  ensureRootGroup,
  flattenBlocks,
  getChildGroup,
  getContentElement,
  insertBlocksRelativeTo,
  isDescendantBlock,
  locateBlock,
  moveBlock,
  readBlockById,
  readDocumentBlocks,
  readDocumentMetadata,
  readDocumentTitle,
  readInlineMarkdown,
  removeBlock,
  replaceTextInDocument,
  writeBlockInlineContent,
  writeBlockProps,
} from './document-model.js';

/** Build a document from markdown, the way `insert_content` does. */
async function docFromMarkdown(markdown: string): Promise<Y.Doc> {
  const doc = new Y.Doc();
  const containers = await markdownToBlockContainers(markdown);
  doc.transact(() => {
    appendBlocks(doc, containers);
  });
  return doc;
}

/** Attach a content-less custom block, as the Portal's editor stores them. */
function addCustomBlock(
  doc: Y.Doc,
  id: string,
  type: string,
  props: Record<string, string>,
): void {
  doc.transact(() => {
    const group = ensureRootGroup(doc.getXmlFragment(DOCUMENT_FRAGMENT_NAME));
    const container = new Y.XmlElement('blockContainer');
    container.setAttribute('id', id);
    container.setAttribute('textColor', 'default');
    container.setAttribute('backgroundColor', 'default');
    const content = new Y.XmlElement(type);
    for (const [key, value] of Object.entries(props)) {
      content.setAttribute(key, value);
    }
    container.insert(0, [content]);
    group.insert(group.length, [container]);
  });
}

/** Nest `childId` inside `parentId`, the way a nested list is stored. */
function nestBlock(doc: Y.Doc, parentId: string, childId: string): void {
  doc.transact(() => {
    const parent = locateBlock(
      doc.getXmlFragment(DOCUMENT_FRAGMENT_NAME),
      parentId,
    );
    if (!parent) throw new Error(`missing parent ${parentId}`);
    const group = new Y.XmlElement('blockGroup');
    const container = new Y.XmlElement('blockContainer');
    container.setAttribute('id', childId);
    container.setAttribute('textColor', 'default');
    container.setAttribute('backgroundColor', 'default');
    const content = new Y.XmlElement('paragraph');
    const text = new Y.XmlText();
    text.insert(0, 'nested child');
    content.insert(0, [text]);
    container.insert(0, [content]);
    group.insert(0, [container]);
    parent.container.insert(parent.container.length, [group]);
  });
}

describe('document-model: reads', () => {
  it('maps the block tree with ids, types, props and markdown text', async () => {
    const doc = await docFromMarkdown(
      '# Title\n\nSome **bold** and *italic* text.\n\n- one\n- two\n',
    );

    const blocks = readDocumentBlocks(doc);
    expect(blocks.map((b) => b.type)).toEqual([
      'heading',
      'paragraph',
      'bulletListItem',
      'bulletListItem',
    ]);
    expect(blocks[0]?.text).toBe('Title');
    expect(blocks[0]?.props.level).toBe(1);
    expect(blocks[1]?.text).toBe('Some **bold** and *italic* text.');
    expect(blocks.every((b) => b.id.length > 0)).toBe(true);
  });

  it('returns an empty tree for a document with no content', () => {
    expect(readDocumentBlocks(new Y.Doc())).toEqual([]);
  });

  it('reads inline links and code as markdown, and plain text without marks', async () => {
    const doc = await docFromMarkdown(
      'See [the docs](https://example.com) and `code`.',
    );
    const blocks = readDocumentBlocks(doc);
    expect(blocks[0]?.text).toBe(
      'See [the docs](https://example.com) and `code`.',
    );

    const located = locateBlock(
      doc.getXmlFragment(DOCUMENT_FRAGMENT_NAME),
      blocks[0]?.id ?? '',
    );
    const content = located ? getContentElement(located.container) : null;
    if (!content) throw new Error('block content element not found');
    // `Y.XmlText.toString()` renders marks as tags, so the markdown reader has
    // to go through the delta.
    expect(readInlineMarkdown(content)).toBe(
      'See [the docs](https://example.com) and `code`.',
    );
  });

  it('flattens nested blocks depth-first with positions and depths', async () => {
    const doc = await docFromMarkdown('- parent\n');
    const parentId = readDocumentBlocks(doc)[0]?.id ?? '';
    nestBlock(doc, parentId, 'child-1');

    const tree = readDocumentBlocks(doc);
    expect(tree).toHaveLength(1);
    expect(tree[0]?.children.map((c) => c.id)).toEqual(['child-1']);

    const flat = flattenBlocks(tree);
    expect(flat.map((b) => [b.position, b.depth, b.id])).toEqual([
      [0, 0, parentId],
      [1, 1, 'child-1'],
    ]);
    expect(flat[0]?.childCount).toBe(1);
  });

  it('reads one block by id, including its children, and null for a stale id', async () => {
    const doc = await docFromMarkdown('- parent\n');
    const parentId = readDocumentBlocks(doc)[0]?.id ?? '';
    nestBlock(doc, parentId, 'child-1');

    const block = readBlockById(doc, parentId);
    expect(block?.children).toHaveLength(1);
    expect(readBlockById(doc, 'does-not-exist')).toBeNull();
  });

  it('surfaces custom block props and non-default colours', async () => {
    const doc = await docFromMarkdown('intro\n');
    addCustomBlock(doc, 'cb-1', 'checkbox', {
      title: 'Do it',
      description: 'later',
      checked: 'false',
    });

    const custom = readDocumentBlocks(doc).find((b) => b.id === 'cb-1');
    expect(custom?.type).toBe('checkbox');
    expect(custom?.props).toMatchObject({
      title: 'Do it',
      description: 'later',
      checked: 'false',
    });
    // Default colours are noise, not content.
    expect(custom?.props.textColor).toBeUndefined();
    expect(custom?.text).toBe('');
  });

  it('reads the page title and root metadata', () => {
    const doc = new Y.Doc();
    doc.transact(() => {
      doc.getText('title').insert(0, 'Meeting notes');
      doc.getMap('root').set('ownerDid', 'did:ixo:abc');
    });
    expect(readDocumentTitle(doc)).toBe('Meeting notes');
    expect(readDocumentMetadata(doc)).toMatchObject({
      ownerDid: 'did:ixo:abc',
      title: 'Meeting notes',
    });
  });
});

describe('document-model: mutations', () => {
  it('inserts blocks before and after a reference block', async () => {
    const doc = await docFromMarkdown('first\n\nsecond\n');
    const [first, second] = readDocumentBlocks(doc);

    const before = await markdownToBlockContainers('inserted before');
    const after = await markdownToBlockContainers('inserted after');
    doc.transact(() => {
      insertBlocksRelativeTo(doc, first?.id ?? '', 'before', before);
      insertBlocksRelativeTo(doc, second?.id ?? '', 'after', after);
    });

    expect(readDocumentBlocks(doc).map((b) => b.text)).toEqual([
      'inserted before',
      'first',
      'second',
      'inserted after',
    ]);
  });

  it('refuses to insert against a block that is not in the document', async () => {
    const doc = await docFromMarkdown('only\n');
    const containers = await markdownToBlockContainers('new');
    doc.transact(() => {
      expect(
        insertBlocksRelativeTo(doc, 'missing-id', 'after', containers),
      ).toBe(false);
    });
    expect(readDocumentBlocks(doc)).toHaveLength(1);
  });

  it('writes allowlisted props without touching inline content', async () => {
    const doc = await docFromMarkdown('keep this text\n');
    const blockId = readDocumentBlocks(doc)[0]?.id ?? '';
    const located = locateBlock(
      doc.getXmlFragment(DOCUMENT_FRAGMENT_NAME),
      blockId,
    );
    expect(located).not.toBeNull();

    doc.transact(() => {
      if (located) {
        writeBlockProps(located.container, {
          textAlignment: 'center',
          textColor: 'red',
        });
      }
    });

    const block = readBlockById(doc, blockId);
    expect(block?.text).toBe('keep this text');
    expect(block?.props.textAlignment).toBe('center');
    expect(block?.props.textColor).toBe('red');
  });

  it('replaces inline content while keeping the block id and props', async () => {
    const doc = await docFromMarkdown('# original\n');
    const before = readDocumentBlocks(doc)[0];
    const located = locateBlock(
      doc.getXmlFragment(DOCUMENT_FRAGMENT_NAME),
      before?.id ?? '',
    );

    const nodes = await markdownToInlineContent('rewritten **text**');

    doc.transact(() => {
      if (located) writeBlockInlineContent(located.container, nodes);
    });

    const after = readDocumentBlocks(doc)[0];
    expect(after?.id).toBe(before?.id);
    expect(after?.type).toBe('heading');
    expect(after?.props.level).toBe(1);
    expect(after?.text).toBe('rewritten **text**');
  });

  it('removes a block and its whole subtree', async () => {
    const doc = await docFromMarkdown('- parent\n\nsibling\n');
    const parentId = readDocumentBlocks(doc)[0]?.id ?? '';
    nestBlock(doc, parentId, 'child-1');

    doc.transact(() => {
      expect(removeBlock(doc, parentId)).toBe(true);
    });
    const remaining = flattenBlocks(readDocumentBlocks(doc));
    expect(remaining.map((b) => b.text)).toEqual(['sibling']);

    doc.transact(() => {
      expect(removeBlock(doc, 'already-gone')).toBe(false);
    });
  });

  it('moves a block, preserving its id, text and children', async () => {
    const doc = await docFromMarkdown('- a\n\nb\n\nc\n');
    const [a, , c] = readDocumentBlocks(doc);
    nestBlock(doc, a?.id ?? '', 'child-of-a');

    doc.transact(() => {
      expect(moveBlock(doc, a?.id ?? '', c?.id ?? '', 'after')).toBeNull();
    });

    const tree = readDocumentBlocks(doc);
    expect(tree.map((b) => b.text)).toEqual(['b', 'c', 'a']);
    expect(tree[2]?.id).toBe(a?.id);
    expect(tree[2]?.children.map((child) => child.id)).toEqual(['child-of-a']);
  });

  it('reports why a move is impossible instead of losing the block', async () => {
    const doc = await docFromMarkdown('- a\n\nb\n');
    const [a, b] = readDocumentBlocks(doc);
    nestBlock(doc, a?.id ?? '', 'child-of-a');

    doc.transact(() => {
      expect(moveBlock(doc, a?.id ?? '', a?.id ?? '', 'after')).toBe(
        'same_block',
      );
      expect(moveBlock(doc, 'ghost', b?.id ?? '', 'after')).toBe(
        'source_missing',
      );
      expect(moveBlock(doc, a?.id ?? '', 'ghost', 'after')).toBe(
        'reference_missing',
      );
      expect(moveBlock(doc, a?.id ?? '', 'child-of-a', 'after')).toBe(
        'into_own_subtree',
      );
    });

    // Every refusal left the document exactly as it was.
    expect(flattenBlocks(readDocumentBlocks(doc)).map((x) => x.id)).toEqual([
      a?.id,
      'child-of-a',
      b?.id,
    ]);
  });

  it('detects descendants for the move guard', async () => {
    const doc = await docFromMarkdown('- a\n\nb\n');
    const [a, b] = readDocumentBlocks(doc);
    nestBlock(doc, a?.id ?? '', 'child-of-a');

    expect(isDescendantBlock(doc, a?.id ?? '', 'child-of-a')).toBe(true);
    expect(isDescendantBlock(doc, a?.id ?? '', b?.id ?? '')).toBe(false);
    expect(isDescendantBlock(doc, 'ghost', 'child-of-a')).toBe(false);
  });

  it('replaces text in place, preserving surrounding formatting', async () => {
    const doc = await docFromMarkdown(
      'The **quick** brown fox. The quick end.\n',
    );

    let outcome = { replacements: 0, blockIds: [] as string[] };
    doc.transact(() => {
      outcome = replaceTextInDocument(doc, {
        find: 'quick',
        replace: 'slow',
      });
    });

    expect(outcome.replacements).toBe(2);
    expect(outcome.blockIds).toHaveLength(1);
    // The bolded run stays bolded — only the matched range was spliced.
    expect(readDocumentBlocks(doc)[0]?.text).toBe(
      'The **slow** brown fox. The slow end.',
    );
  });

  it('honours case sensitivity, replace-all, and single-block scoping', async () => {
    const doc = await docFromMarkdown('Alpha alpha\n\nalpha again\n');
    const blocks = readDocumentBlocks(doc);

    let outcome = { replacements: 0, blockIds: [] as string[] };
    doc.transact(() => {
      outcome = replaceTextInDocument(doc, {
        find: 'alpha',
        replace: 'beta',
        caseSensitive: true,
        replaceAll: false,
        blockId: blocks[0]?.id,
      });
    });
    expect(outcome.replacements).toBe(1);
    expect(readDocumentBlocks(doc).map((b) => b.text)).toEqual([
      'Alpha beta',
      'alpha again',
    ]);

    doc.transact(() => {
      outcome = replaceTextInDocument(doc, {
        find: 'ALPHA',
        replace: 'gamma',
        caseSensitive: false,
      });
    });
    expect(outcome.replacements).toBe(2);
    expect(readDocumentBlocks(doc).map((b) => b.text)).toEqual([
      'gamma beta',
      'gamma again',
    ]);
  });

  it('reports zero replacements when the phrase is absent', async () => {
    const doc = await docFromMarkdown('nothing to see\n');
    let outcome = { replacements: 0, blockIds: [] as string[] };
    doc.transact(() => {
      outcome = replaceTextInDocument(doc, { find: 'absent', replace: 'x' });
    });
    expect(outcome).toEqual({ replacements: 0, blockIds: [] });
  });

  it('never writes to the runtime, runs, invocations or delegations maps', async () => {
    const doc = await docFromMarkdown('start\n');
    const blockId = readDocumentBlocks(doc)[0]?.id ?? '';
    const extra = await markdownToBlockContainers('more');

    doc.transact(() => {
      appendBlocks(doc, extra);
      const located = locateBlock(
        doc.getXmlFragment(DOCUMENT_FRAGMENT_NAME),
        blockId,
      );
      if (located)
        writeBlockProps(located.container, { textAlignment: 'right' });
      replaceTextInDocument(doc, { find: 'start', replace: 'begin' });
      moveBlock(doc, blockId, extra[0]?.getAttribute('id') ?? '', 'after');
      removeBlock(doc, blockId);
    });

    // Any of these having content would mean a write reached run state.
    for (const name of [
      'runtime',
      'runs',
      'runsTerminal',
      'invocations',
      'delegations',
    ]) {
      expect(doc.getMap(name).size).toBe(0);
    }
  });

  it('finds the nested child group of a container', async () => {
    const doc = await docFromMarkdown('- parent\n');
    const parentId = readDocumentBlocks(doc)[0]?.id ?? '';
    const located = locateBlock(
      doc.getXmlFragment(DOCUMENT_FRAGMENT_NAME),
      parentId,
    );
    expect(located && getChildGroup(located.container)).toBeNull();

    nestBlock(doc, parentId, 'child-1');
    const after = locateBlock(
      doc.getXmlFragment(DOCUMENT_FRAGMENT_NAME),
      parentId,
    );
    expect(after && getChildGroup(after.container)).not.toBeNull();
  });
});

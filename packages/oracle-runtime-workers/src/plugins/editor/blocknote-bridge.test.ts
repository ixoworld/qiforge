/**
 * Proof that the markdown→blocks bridge runs on workerd.
 *
 * This file executes inside the Workers vitest pool (the default
 * `vitest.config.ts` project), so a green run means `@blocknote/server-util`'s
 * `ServerBlockNoteEditor` — driven through the linkedom-backed `jsdom-shim` —
 * parses markdown and materialises real BlockNote CRDT structure under
 * workerd, not under a Node approximation.
 */
import { describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import {
  markdownToBlockContainers,
  markdownToInlineContent,
  proseBlockTypes,
} from './blocknote-bridge';
import { appendBlocks, readDocumentBlocks } from './document-model';

describe('blocknote-bridge on workerd', () => {
  it('exposes the BlockNote prose block types from the live schema', () => {
    const prose = proseBlockTypes();
    expect(prose.has('paragraph')).toBe(true);
    expect(prose.has('heading')).toBe(true);
    expect(prose.has('bulletListItem')).toBe(true);
  });

  it('converts markdown with a heading, a list, and a paragraph into BlockNote blocks', async () => {
    const containers = await markdownToBlockContainers(
      '# Getting Started\n\nA paragraph with **bold** text.\n\n- first item\n- second item\n',
    );

    // One blockContainer per markdown block: heading, paragraph, 2 list items.
    expect(containers).toHaveLength(4);
    for (const container of containers) {
      expect(container).toBeInstanceOf(Y.XmlElement);
      expect(container.nodeName).toBe('blockContainer');
    }

    // The detached containers must be insertable into a live document made by
    // THIS package's yjs — the cross-instance trap the bridge exists to avoid.
    const doc = new Y.Doc();
    doc.transact(() => {
      appendBlocks(doc, containers);
    });

    const blocks = readDocumentBlocks(doc);
    expect(blocks.map((b) => b.type)).toEqual([
      'heading',
      'paragraph',
      'bulletListItem',
      'bulletListItem',
    ]);
    expect(blocks[0]?.text).toBe('Getting Started');
    expect(blocks[0]?.props.level).toBe(1);
    expect(blocks[1]?.text).toBe('A paragraph with **bold** text.');
    expect(blocks[2]?.text).toBe('first item');
    expect(blocks[3]?.text).toBe('second item');
    expect(blocks.every((b) => b.id.length > 0)).toBe(true);
  });

  it('returns no inline nodes for empty markdown', async () => {
    expect(await markdownToInlineContent('')).toEqual([]);
  });

  it('parses markdown into inline nodes carrying formatting marks', async () => {
    const nodes = await markdownToInlineContent('plain and **bold** end');
    expect(nodes.length).toBeGreaterThan(0);

    // Rendered back through a block, the marks must survive.
    const doc = new Y.Doc();
    const containers = await markdownToBlockContainers('placeholder');
    doc.transact(() => {
      appendBlocks(doc, containers);
    });
    const container = doc
      .getXmlFragment('document')
      .toArray()
      .flatMap((n) => (n instanceof Y.XmlElement ? n.toArray() : []))
      .find(
        (n): n is Y.XmlElement =>
          n instanceof Y.XmlElement && n.nodeName === 'blockContainer',
      );
    expect(container).toBeDefined();
    if (!container) return;
    const content = container
      .toArray()
      .find(
        (n): n is Y.XmlElement =>
          n instanceof Y.XmlElement && n.nodeName !== 'blockGroup',
      );
    expect(content).toBeDefined();
    if (!content) return;
    doc.transact(() => {
      content.delete(0, content.length);
      content.insert(0, nodes);
    });

    const [block] = readDocumentBlocks(doc);
    expect(block?.text).toBe('plain and **bold** end');
  });
});

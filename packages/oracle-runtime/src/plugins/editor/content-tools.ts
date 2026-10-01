/**
 * The content assistant's tool surface: three reads and five writes over one
 * BlockNote document.
 *
 * Every write goes through `applyDocumentEdit` (see `content-session.ts`), so
 * the flow guard, the access guard, the prop allowlist, the single transaction,
 * and the flush-before-success rule are enforced in one place rather than
 * per tool.
 */

import type { MatrixClient } from 'matrix-js-sdk';
import type * as Y from 'yjs';
import { z } from 'zod';

import { tool as pluginTool } from '../../plugin-api/tool-helper.js';
import type { PluginTool } from '../../plugin-api/types.js';
import { emojify, unemojify } from '../../utils/emoji.js';
import {
  markdownToBlockContainers,
  markdownToInlineContent,
} from './blocknote-bridge.js';
import { applyDocumentEdit, withDocument } from './content-session.js';
import {
  appendBlocks,
  flattenBlocks,
  insertBlocksRelativeTo,
  isDescendantBlock,
  locateBlock,
  moveBlock,
  prependBlocks,
  readBlockById,
  readDocumentBlocks,
  readDocumentMetadata,
  readDocumentTitle,
  removeBlock,
  replaceTextInDocument,
  writeBlockInlineContent,
  writeBlockProps,
  DOCUMENT_FRAGMENT_NAME,
  getContentElement,
  type DocumentBlock,
  type FlatDocumentBlock,
} from './document-model.js';
import {
  blockNotFound,
  editorError,
  propNotEditable,
  type EditorFailure,
} from './failures.js';
import {
  filterWritableProps,
  isTextEditable,
  redactProps,
} from './prop-policy.js';
import type { AppConfig } from './provider.js';

export interface ContentToolsOptions {
  matrixClient: MatrixClient;
  /** Provider config with the target room already baked in. */
  appConfig: AppConfig;
}

const DEFAULT_READ_LIMIT = 60;
const MAX_READ_LIMIT = 200;

const blockIdSchema = z
  .string()
  .min(1)
  .describe('The block id, exactly as returned by read_document.');

function json(value: unknown): string {
  return JSON.stringify(value, null, 2);
}

/** Redact prop values the assistant must not relay, at every depth. */
function redactBlock(block: DocumentBlock): DocumentBlock {
  return {
    ...block,
    props: redactProps(block.type, block.props),
    children: block.children.map(redactBlock),
  };
}

function redactFlat(block: FlatDocumentBlock): FlatDocumentBlock {
  return { ...block, props: redactProps(block.type, block.props) };
}

/** Case-insensitive match that treats `:tada:` and 🎉 as the same text. */
function matches(haystack: string, needle: string): boolean {
  const text = haystack.toLowerCase();
  const query = needle.toLowerCase();
  if (text.includes(query)) return true;
  if (emojify(text).includes(emojify(query))) return true;
  return unemojify(text).includes(unemojify(query));
}

// ── Reads ────────────────────────────────────────────────────────────

function createReadDocumentTool(options: ContentToolsOptions): PluginTool {
  const schema = z.object({
    start: z
      .number()
      .int()
      .min(0)
      .optional()
      .describe('Position of the first block to return (default 0).'),
    limit: z
      .number()
      .int()
      .min(1)
      .max(MAX_READ_LIMIT)
      .optional()
      .describe(`How many blocks to return (default ${DEFAULT_READ_LIMIT}).`),
    block_type: z
      .string()
      .optional()
      .describe("Return only blocks of this type, e.g. 'heading'."),
  });

  return pluginTool(
    async (rawArgs) => {
      const args = schema.parse(rawArgs);
      const start = args.start ?? 0;
      const limit = args.limit ?? DEFAULT_READ_LIMIT;

      const result = await withDocument(options, async (session) => {
        const blocks = flattenBlocks(readDocumentBlocks(session.doc)).map(
          redactFlat,
        );
        const filtered = args.block_type
          ? blocks.filter((block) => block.type === args.block_type)
          : blocks;
        const page = filtered.slice(start, start + limit);
        return {
          ok: true as const,
          roomId: session.roomId,
          readOnly: session.isFlow,
          title: readDocumentTitle(session.doc),
          metadata: readDocumentMetadata(session.doc),
          total: filtered.length,
          start,
          count: page.length,
          blocks: page,
        };
      });

      return json(result);
    },
    {
      name: 'read_document',
      description:
        "Read the open document's blocks in order. Returns each block's id, " +
        'type, props, and text (markdown), plus the page title. Call this ' +
        'before any edit — block ids come from here and must never be guessed ' +
        'or reused from an earlier turn. Paginate with start/limit for long ' +
        'documents. `readOnly: true` means the document is a live flow and ' +
        'edits will be refused.',
      schema,
    },
  );
}

function createReadBlockTool(options: ContentToolsOptions): PluginTool {
  const schema = z.object({ block_id: blockIdSchema });

  return pluginTool(
    async (rawArgs) => {
      const args = schema.parse(rawArgs);
      const result = await withDocument(options, async (session) => {
        const block = readBlockById(session.doc, args.block_id);
        if (!block) return blockNotFound(args.block_id);
        return {
          ok: true as const,
          roomId: session.roomId,
          block: redactBlock(block),
        };
      });
      return json(result);
    },
    {
      name: 'read_block',
      description:
        'Read one block by id, including its nested child blocks. Use after ' +
        'read_document when you need the full detail of a single block.',
      schema,
    },
  );
}

function createSearchDocumentTool(options: ContentToolsOptions): PluginTool {
  const schema = z.object({
    query: z.string().min(1).describe('Text to look for.'),
    limit: z
      .number()
      .int()
      .min(1)
      .max(MAX_READ_LIMIT)
      .optional()
      .describe('Maximum matches to return (default 20).'),
  });

  return pluginTool(
    async (rawArgs) => {
      const args = schema.parse(rawArgs);
      const limit = args.limit ?? 20;

      const result = await withDocument(options, async (session) => {
        const blocks = flattenBlocks(readDocumentBlocks(session.doc)).map(
          redactFlat,
        );
        const hits: Array<{
          matchedIn: 'text' | 'props';
          block: FlatDocumentBlock;
        }> = [];

        for (const block of blocks) {
          if (matches(block.text, args.query)) {
            hits.push({ matchedIn: 'text', block });
            continue;
          }
          const propHit = Object.values(block.props).some(
            (value) => typeof value === 'string' && matches(value, args.query),
          );
          if (propHit) hits.push({ matchedIn: 'props', block });
        }

        return {
          ok: true as const,
          roomId: session.roomId,
          query: args.query,
          total: hits.length,
          matches: hits.slice(0, limit),
        };
      });

      return json(result);
    },
    {
      name: 'search_document',
      description:
        'Find blocks whose text or props contain a phrase. Returns the same ' +
        'block shape as read_document. Use this instead of reading a long ' +
        'document page by page when you know what you are looking for.',
      schema,
    },
  );
}

// ── Writes ───────────────────────────────────────────────────────────

function createInsertContentTool(options: ContentToolsOptions): PluginTool {
  const schema = z.object({
    markdown: z
      .string()
      .min(1)
      .describe(
        'The content to insert, as markdown. Headings, lists, bold/italic, ' +
          'code and links are supported; each markdown block becomes one ' +
          'document block.',
      ),
    position: z
      .enum(['end', 'start', 'before', 'after'])
      .optional()
      .describe(
        "Where to insert (default 'end'). 'before'/'after' require " +
          'reference_block_id.',
      ),
    reference_block_id: z
      .string()
      .optional()
      .describe("Anchor block for 'before'/'after'."),
  });

  return pluginTool(
    async (rawArgs) => {
      const args = schema.parse(rawArgs);
      const position = args.position ?? 'end';

      if (
        (position === 'before' || position === 'after') &&
        !args.reference_block_id
      ) {
        return json(
          editorError(
            `position '${position}' requires reference_block_id. Call ` +
              'read_document to get a block id, or use end/start.',
          ),
        );
      }

      // Parsing is independent of the document, so it happens before the write
      // path opens its transaction.
      const containers = await markdownToBlockContainers(
        emojify(args.markdown),
      );
      if (containers.length === 0) {
        return json(
          editorError('That markdown produced no blocks — nothing to insert.'),
        );
      }

      const result = await withDocument(options, async (session) =>
        applyDocumentEdit(session, {
          plan: (doc) => {
            // Anchored inserts need a live reference; end/start do not.
            if (position !== 'before' && position !== 'after') {
              return { reference: '' };
            }
            const reference = args.reference_block_id ?? '';
            const located = locateBlock(
              doc.getXmlFragment(DOCUMENT_FRAGMENT_NAME),
              reference,
            );
            if (!located) return blockNotFound(reference);
            return { reference };
          },
          apply: (doc, plan) => {
            if (position === 'end') {
              appendBlocks(doc, containers);
            } else if (position === 'start') {
              prependBlocks(doc, containers);
            } else {
              insertBlocksRelativeTo(
                doc,
                plan.reference,
                position === 'before' ? 'before' : 'after',
                containers,
              );
            }
            return {
              ok: true as const,
              roomId: session.roomId,
              inserted: containers.length,
              blockIds: containers.map(
                (container) => container.getAttribute('id') ?? '',
              ),
              position,
            };
          },
        }),
      );

      return json(result);
    },
    {
      name: 'insert_content',
      description:
        'Add new content to the document from markdown. Inserts at the end by ' +
        'default, or relative to an existing block. This is how you write new ' +
        'prose — do not try to create custom blocks (checkboxes, actions, ' +
        'forms) with it.',
      schema,
    },
  );
}

interface PreparedEdit {
  blockId: string;
  props: Record<string, string>;
  inlineNodes: Array<Y.XmlText | Y.XmlElement> | undefined;
}

function createEditBlockTool(options: ContentToolsOptions): PluginTool {
  const editSchema = z.object({
    block_id: blockIdSchema,
    text: z
      .string()
      .optional()
      .describe(
        'Replacement text for the block, as markdown inline content. Only ' +
          'valid on prose blocks (paragraph, heading, list items, quote, …).',
      ),
    props: z
      .record(z.string(), z.union([z.string(), z.number(), z.boolean()]))
      .optional()
      .describe(
        'Props to set. On prose blocks any prop is allowed. On custom IXO ' +
          "blocks only 'title' and 'description' are editable — everything " +
          'else configures behaviour and will be refused.',
      ),
  });

  const schema = z.object({
    edits: z
      .array(editSchema)
      .min(1)
      .describe(
        'The edits to apply. All of them land in one atomic change, so batch ' +
          'related edits into a single call instead of calling repeatedly.',
      ),
  });

  return pluginTool(
    async (rawArgs) => {
      const args = schema.parse(rawArgs);

      // Markdown is parsed up front: it does not depend on the document, and
      // keeping it out of the transaction keeps the write window small.
      const parsedText = new Map<number, Array<Y.XmlText | Y.XmlElement>>();
      for (const [index, edit] of args.edits.entries()) {
        if (edit.text === undefined) continue;
        parsedText.set(
          index,
          await markdownToInlineContent(emojify(edit.text)),
        );
      }

      const result = await withDocument(options, async (session) =>
        applyDocumentEdit(session, {
          plan: (doc): PreparedEdit[] | EditorFailure => {
            const prepared: PreparedEdit[] = [];
            const fragment = doc.getXmlFragment(DOCUMENT_FRAGMENT_NAME);

            for (const [index, edit] of args.edits.entries()) {
              const located = locateBlock(fragment, edit.block_id);
              if (!located) return blockNotFound(edit.block_id);
              const content = getContentElement(located.container);
              if (!content) {
                return editorError(
                  `Block ${edit.block_id} has no content element and cannot be edited.`,
                );
              }
              const blockType = content.nodeName;

              const filtered = filterWritableProps(blockType, edit.props ?? {});
              if (filtered.rejected.length > 0) {
                return propNotEditable(
                  edit.block_id,
                  blockType,
                  filtered.rejected,
                );
              }

              if (edit.text !== undefined && !isTextEditable(blockType)) {
                return propNotEditable(edit.block_id, blockType, [
                  {
                    prop: 'text',
                    reason: `'${blockType}' blocks hold no editable text — set title or description instead`,
                  },
                ]);
              }

              prepared.push({
                blockId: edit.block_id,
                props: filtered.allowed,
                inlineNodes: parsedText.get(index),
              });
            }

            return prepared;
          },
          apply: (doc, prepared) => {
            const fragment = doc.getXmlFragment(DOCUMENT_FRAGMENT_NAME);
            const applied: string[] = [];
            for (const edit of prepared) {
              const located = locateBlock(fragment, edit.blockId);
              if (!located) continue;
              if (Object.keys(edit.props).length > 0) {
                writeBlockProps(located.container, edit.props);
              }
              if (edit.inlineNodes) {
                writeBlockInlineContent(located.container, edit.inlineNodes);
              }
              applied.push(edit.blockId);
            }
            return {
              ok: true as const,
              roomId: session.roomId,
              edited: applied.length,
              blockIds: applied,
            };
          },
        }),
      );

      return json(result);
    },
    {
      name: 'edit_block',
      description:
        'Change existing blocks — their text, their props, or both. Accepts a ' +
        'batch: every edit in one call is applied atomically, and if any edit ' +
        'is refused none of them are applied. Prose blocks accept text and any ' +
        "prop; custom IXO blocks accept only 'title' and 'description'.",
      schema,
    },
  );
}

function createDeleteBlockTool(options: ContentToolsOptions): PluginTool {
  const schema = z.object({ block_id: blockIdSchema });

  return pluginTool(
    async (rawArgs) => {
      const args = schema.parse(rawArgs);

      const result = await withDocument(options, async (session) =>
        applyDocumentEdit(session, {
          plan: (doc) => {
            const located = locateBlock(
              doc.getXmlFragment(DOCUMENT_FRAGMENT_NAME),
              args.block_id,
            );
            if (!located) return blockNotFound(args.block_id);
            const content = getContentElement(located.container);
            return { blockType: content?.nodeName ?? 'unknown' };
          },
          apply: (doc, plan) => {
            const removed = removeBlock(doc, args.block_id);
            return {
              ok: true as const,
              roomId: session.roomId,
              removed,
              blockId: args.block_id,
              blockType: plan.blockType,
            };
          },
        }),
      );

      return json(result);
    },
    {
      name: 'delete_block',
      description:
        'Delete one block and everything nested inside it. Deletion cannot be ' +
        'undone from here — confirm with the user before deleting content they ' +
        'did not explicitly ask you to remove.',
      schema,
    },
  );
}

function createMoveBlockTool(options: ContentToolsOptions): PluginTool {
  const schema = z.object({
    block_id: blockIdSchema,
    reference_block_id: z
      .string()
      .min(1)
      .describe('The block to move it next to.'),
    placement: z
      .enum(['before', 'after'])
      .describe('Put the block before or after the reference block.'),
  });

  return pluginTool(
    async (rawArgs) => {
      const args = schema.parse(rawArgs);

      const result = await withDocument(options, async (session) =>
        applyDocumentEdit(session, {
          plan: (doc) => {
            const fragment = doc.getXmlFragment(DOCUMENT_FRAGMENT_NAME);
            if (!locateBlock(fragment, args.block_id)) {
              return blockNotFound(args.block_id);
            }
            if (!locateBlock(fragment, args.reference_block_id)) {
              return blockNotFound(args.reference_block_id);
            }
            if (args.block_id === args.reference_block_id) {
              return editorError('A block cannot be moved relative to itself.');
            }
            if (
              isDescendantBlock(doc, args.block_id, args.reference_block_id)
            ) {
              return editorError(
                'A block cannot be moved inside its own child blocks.',
              );
            }
            return {};
          },
          apply: (doc) => {
            const error = moveBlock(
              doc,
              args.block_id,
              args.reference_block_id,
              args.placement,
            );
            // `plan` already proved both blocks exist and are not nested, so
            // this is a defensive branch: report it rather than claim success.
            if (error) {
              return editorError(
                `Could not move the block (${error}).`,
                session.roomId,
              );
            }
            return {
              ok: true as const,
              roomId: session.roomId,
              blockId: args.block_id,
              placement: args.placement,
              referenceBlockId: args.reference_block_id,
            };
          },
        }),
      );

      return json(result);
    },
    {
      name: 'move_block',
      description:
        'Reorder the document by moving one block next to another. The block ' +
        'keeps its id, text, props, and child blocks.',
      schema,
    },
  );
}

function createReplaceTextTool(options: ContentToolsOptions): PluginTool {
  const schema = z.object({
    find: z.string().min(1).describe('Exact text to find.'),
    replace: z.string().describe('Replacement text. Pass "" to delete it.'),
    case_sensitive: z
      .boolean()
      .optional()
      .describe('Match case exactly (default true).'),
    replace_all: z
      .boolean()
      .optional()
      .describe('Replace every occurrence (default true).'),
    block_id: z
      .string()
      .optional()
      .describe('Restrict the replacement to a single block.'),
  });

  return pluginTool(
    async (rawArgs) => {
      const args = schema.parse(rawArgs);

      const result = await withDocument(options, async (session) =>
        applyDocumentEdit(session, {
          plan: (doc) => {
            if (args.block_id) {
              const located = locateBlock(
                doc.getXmlFragment(DOCUMENT_FRAGMENT_NAME),
                args.block_id,
              );
              if (!located) return blockNotFound(args.block_id);
            }
            return {};
          },
          apply: (doc) => {
            const outcome = replaceTextInDocument(doc, {
              find: emojify(args.find),
              replace: emojify(args.replace),
              caseSensitive: args.case_sensitive ?? true,
              replaceAll: args.replace_all ?? true,
              ...(args.block_id && { blockId: args.block_id }),
            });
            return {
              ok: true as const,
              roomId: session.roomId,
              replacements: outcome.replacements,
              blockIds: outcome.blockIds,
              ...(outcome.replacements === 0 && {
                note:
                  'No occurrences found — the document was not changed. Read ' +
                  'the document to check the exact wording before retrying.',
              }),
            };
          },
        }),
      );

      return json(result);
    },
    {
      name: 'replace_text',
      description:
        'Replace a phrase wherever it appears in the document text, ' +
        'preserving the surrounding formatting. Prefer this over edit_block ' +
        'for small wording changes: it does not rewrite whole blocks.',
      schema,
    },
  );
}

/**
 * The eight content tools, bound to one document. `isEditorFailure` is
 * re-exported through the tools' JSON payloads: every tool returns either
 * `{ ok: true, … }` or a typed failure the agent can act on.
 */
export function createContentTools(options: ContentToolsOptions): PluginTool[] {
  return [
    createReadDocumentTool(options),
    createReadBlockTool(options),
    createSearchDocumentTool(options),
    createInsertContentTool(options),
    createEditBlockTool(options),
    createDeleteBlockTool(options),
    createMoveBlockTool(options),
    createReplaceTextTool(options),
  ];
}

/** Tool names the content surface contributes, in binding order. */
export const CONTENT_TOOL_NAMES = [
  'read_document',
  'read_block',
  'search_document',
  'insert_content',
  'edit_block',
  'delete_block',
  'move_block',
  'replace_text',
] as const;

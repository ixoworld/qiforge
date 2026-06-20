/* eslint-disable no-console */
/**
 * LangChain Tools for BlockNote Y.js Editing
 */

import { tool } from '@langchain/core/tools';
import * as z from 'zod';

import {
  buildFlowNodeFromBlock,
  executeNode,
  getAction,
  getAllActions,
  type ActionServices,
  type FlowNodeRuntimeState,
  type FlowRuntimeStateManager,
} from '@ixo/editor/core';
import { Logger } from '@nestjs/common';
import type { MatrixClient } from 'matrix-js-sdk';
import { randomUUID } from 'node:crypto';
import * as Y from 'yjs';
import { emojify, unemojify } from '../../utils/emoji.js';
import {
  findAndReplaceInDoc,
  insertBlock,
  moveBlock,
} from './block-actions.js';
import {
  appendBlock,
  collectAllBlocks,
  deleteBlock,
  editBlock,
  evaluateBlockConditions,
  extractBlockProperties,
  findBlockById,
  getBlockDetail,
  readAuditTrailForBlock,
  readDelegations,
  readFlowMetadata,
  readFlowNodes,
  readInvocations,
  readRuntimeState,
  resolveBlockReferences,
  simplifyBlockForAgent,
  updateRuntimeState,
  type BlockSnapshot,
  type ConditionConfig,
} from './blocknote-helper.js';
import { MatrixProviderManager, type AppConfig } from './provider.js';
import {
  extractSurveyQuestions,
  getMissingRequiredFields,
  getVisibleQuestions,
  validateAnswersAgainstSchema,
  type SurveySchema,
} from './survey-helpers.js';

/** Matrix admin credentials the blocknote tools use to read/write Y.Docs. */
export interface BlocknoteToolsMatrixConfig {
  baseUrl: string;
  accessToken: string;
  userId: string;
}

/**
 * Build the default `BLOCKNOTE_TOOLS_CONFIG` from a runtime config bag. The
 * editor plugin builds this once at boot from its declared env vars and
 * threads it through every tool factory, replacing the legacy module-level
 * `getConfig()` call.
 */
export function buildBlocknoteToolsConfig(matrix: BlocknoteToolsMatrixConfig) {
  return {
    matrix: {
      baseUrl: matrix.baseUrl,
      accessToken: matrix.accessToken,
      userId: matrix.userId,
      initialSyncTimeoutMs: 30_000,
    },
    provider: {
      docName: 'document',
      enableAwareness: false,
      retryAttempts: 3,
      retryDelayMs: 5_000,
    },
    blocknote: {
      defaultBlockId: undefined,
      blockNamespace: undefined,
      mutableAttributeKeys: [] as string[],
    },
  };
}

/**
 * The blocknote tools' config, optionally augmented with a host-provided
 * `MatrixClient`. When `matrixClient` is set, `resolveEditorMatrixClient`
 * uses it directly; when absent, the editor falls back to constructing
 * its internal singleton from the matrix credentials.
 */
export type BlocknoteToolsConfig = ReturnType<
  typeof buildBlocknoteToolsConfig
> & {
  matrixClient?: MatrixClient;
};

/**
 * Track active provider managers for cleanup
 */

const logger = new Logger('BlocknoteTools');

// ── Emoji Helpers ─────────────────────────────────────────────────────

/**
 * Checks whether a string contains emoji shortcodes (e.g. `:tada:`) or
 * actual emoji characters. Returns true if either form is present.
 */
function textContainsEmoji(text: string): boolean {
  return /:[a-z0-9_+-]+:/i.test(text) || text !== unemojify(text);
}

/**
 * Performs a case-insensitive substring match that handles emoji/shortcode
 * equivalence.  The search term and the target text are compared in BOTH
 * their emojified (🎉) and unemojified (:tada:) forms so that the agent
 * can search using either representation.
 */
function emojiAwareIncludes(text: string, search: string): boolean {
  const textLower = text.toLowerCase();
  const searchLower = search.toLowerCase();

  // Fast path — direct match
  if (textLower.includes(searchLower)) return true;

  // Normalise both sides to emoji characters and compare
  const textEmoji = emojify(textLower);
  const searchEmoji = emojify(searchLower);
  if (textEmoji.includes(searchEmoji)) return true;

  // Normalise both sides to shortcodes and compare
  const textCodes = unemojify(textLower);
  const searchCodes = unemojify(searchLower);
  if (textCodes.includes(searchCodes)) return true;

  return false;
}

// ── DID Helpers ───────────────────────────────────────────────────────

/**
 * Extracts a valid DID from a Matrix user ID.
 * Matrix format: @did-ixo-ixo1abc123def:mx.server.com
 * Result:        did:ixo:ixo1abc123def
 *
 * The localpart encodes the DID with hyphens instead of colons.
 */
function matrixUserIdToDid(matrixUserId: string): string {
  // Strip leading @ and remove homeserver (:server.com)
  const localpart = matrixUserId.replace(/^@/, '').replace(/:.*$/, '');
  // Convert hyphens back to colons: did-ixo-ixo1abc → did:ixo:ixo1abc
  // Only replace the first two hyphens (did-method-identifier)
  const parts = localpart.split('-');
  if (parts.length >= 3 && parts[0] === 'did') {
    return `${parts[0]}:${parts[1]}:${parts.slice(2).join('-')}`;
  }
  // Fallback: return as-is if it doesn't match expected pattern
  return localpart;
}

// ── Flow Engine Helpers ───────────────────────────────────────────────

/**
 * Creates a FlowRuntimeStateManager backed by a Y.Doc's 'runtime' map.
 * Mirrors the pattern from the editor's runtime.ts.
 * Wraps mutations in doc.transact for reliable CRDT sync.
 */
function createYDocRuntimeManager(doc: Y.Doc): FlowRuntimeStateManager {
  const map = doc.getMap('runtime');
  return {
    get: (nodeId: string): FlowNodeRuntimeState => {
      const stored = map.get(nodeId);
      if (!stored || typeof stored !== 'object') return {};
      return { ...(stored as FlowNodeRuntimeState) };
    },
    update: (nodeId: string, updates: Partial<FlowNodeRuntimeState>) => {
      doc.transact(() => {
        const current = map.get(nodeId);
        const existing =
          current && typeof current === 'object'
            ? { ...(current as FlowNodeRuntimeState) }
            : {};
        map.set(nodeId, { ...existing, ...updates });
      }, 'oracle-runtime-update');
    },
  };
}

/**
 * Oracle-side ActionServices — MVP supports HTTP only.
 * Additional services (email, notify) can be wired up when the oracle has those capabilities.
 */
const oracleActionServices: ActionServices = {
  http: {
    request: async (params: {
      url: string;
      method: string;
      headers?: Record<string, string>;
      body?: unknown;
    }) => {
      const { url, method, headers = {}, body } = params;
      const res = await fetch(url, {
        method,
        headers: { 'Content-Type': 'application/json', ...headers },
        ...(body !== undefined && { body: JSON.stringify(body) }),
      });
      const data = await res.text();
      let parsed: unknown;
      try {
        parsed = JSON.parse(data);
      } catch {
        parsed = data;
      }
      const responseHeaders: Record<string, string> = {};
      res.headers.forEach((v, k) => {
        responseHeaders[k] = v;
      });
      return { status: res.status, headers: responseHeaders, data: parsed };
    },
  },
};

/**
 * Creates BlockNote tools that use a shared Matrix client
 *
 * @param matrixClient - The singleton Matrix client (already synced)
 * @param config - Configuration for the provider and room
 * @param readOnly - If true, only returns read-only tools (list_blocks). Write tools are disabled but code is preserved.
 */
export const createBlocknoteTools = async (
  matrixClient: MatrixClient,
  config: AppConfig,
  readOnly: boolean = false,
) => {
  logger.log(
    `🔧 Creating BlockNote tools with Matrix client: ${matrixClient.getUserId()}`,
  );
  logger.log(`🔧 Target room: ${JSON.stringify(config.matrix.room)}`);

  let roomId: string;
  if (config.matrix.room.type === 'id') {
    roomId = config.matrix.room.value;
  } else {
    // Resolve room alias to room ID
    const ret = await matrixClient.getRoomIdForAlias(config.matrix.room.value);
    roomId = ret.room_id;
  }

  // ============================================================================
  // Tool 1: List Blocks
  // ============================================================================

  /**
   * Lists all blocks in the BlockNote document
   *
   * Returns detailed information about each block including:
   * - Block ID
   * - Block type (paragraph, proposal, checkbox, etc.)
   * - All attributes/properties
   * - Text content
   * - Nested structure
   */
  const listBlocksTool = tool(
    async ({ includeText = true, blockType = null, start = 0, end = 10 }) => {
      logger.log('📋 list_blocks tool invoked');

      // Use the shared Matrix client (already synced)
      const providerManager = new MatrixProviderManager(matrixClient, config);

      try {
        const { doc } = await providerManager.init();

        const isInRoom = await checkIfInRoomAndJoinPublicRoom(
          matrixClient,
          roomId,
        );

        if (!isInRoom) {
          return JSON.stringify({
            success: false,
            error: `The AI Agent is not in the room ${roomId}, please invite companion to the room. companion user id: ${matrixClient.getUserId()}`,
          });
        }
        // Get the document fragment
        const fragment = doc.getXmlFragment('document');

        // Collect all blocks using the working CLI logic
        const blocks = collectAllBlocks(fragment, includeText);

        // Filter by block type if specified
        const filteredBlocks = blockType
          ? blocks.filter((b) => b.blockType === blockType)
          : blocks;

        // Add position index for agent awareness of document order
        const indexedBlocks = filteredBlocks.map((b, i) => ({
          position: i,
          ...b,
        }));

        // Apply pagination slice
        const paginatedBlocks = indexedBlocks.slice(start, end);

        return JSON.stringify(
          {
            success: true,
            roomId,
            total: indexedBlocks.length,
            count: paginatedBlocks.length,
            start,
            end,
            blocks: paginatedBlocks,
          },
          null,
          2,
        );
      } catch (error) {
        return JSON.stringify({
          success: false,
          error: error instanceof Error ? error.message : String(error),
        });
      } finally {
        // Schedule cleanup after delay to allow Y.Doc to finish syncing
        await providerManager.dispose();
      }
    },
    {
      name: 'list_blocks',
      description: `Lists all blocks in the BlockNote document with their complete structure and UUIDs.

**⚠️ CRITICAL: Always call this tool FIRST before any edit operation to get valid UUID block IDs.**

Use this tool to:
- Get exact UUIDs needed for editing (UUIDs are like: 550e8400-e29b-41d4-a716-446655440000)
- View all blocks in the document
- Filter blocks by type
- Check current block properties and state
- Understand document structure

**Parameter Examples:**

List all blocks with text:
\`\`\`json
{"includeText": true}
\`\`\`

List only proposal blocks:
\`\`\`json
{"includeText": true, "blockType": "proposal"}
\`\`\`

List blocks without text content (faster):
\`\`\`json
{"includeText": false}
\`\`\`

List all blocks (override default pagination):
\`\`\`json
{"includeText": true, "start": 0, "end": 9999}
\`\`\`

List blocks 10-20:
\`\`\`json
{"start": 10, "end": 20}
\`\`\`

**Note:** By default, only the first 10 blocks are returned. Use start/end to paginate through larger documents. Check "total" in the response to see how many blocks exist.

**Returns clean JSON like:**
\`\`\`json
{
  "success": true,
  "total": 25,
  "count": 3,
  "blocks": [
    {
      "id": "550e8400-e29b-41d4-a716-446655440000",
      "type": "proposal",
      "properties": {
        "status": "draft",
        "title": "My Proposal",
        "description": "Proposal details",
        "icon": "square-check"
      },
      "text": "Optional text content"
    }
  ]
}
\`\`\`

**Block types available:**
- paragraph: Simple text
- proposal: Blockchain proposals (status: draft/open/passed/rejected/executed/closed/execution_failed/veto_timelock)
- checkbox: Interactive checkboxes
- apiRequest: API calls (GET/POST/PUT/DELETE)
- list: Data lists
- domainCreator: Survey forms with surveySchema and answers (use read_survey, fill_survey_answers, validate_survey_answers tools)

**Note for domainCreator blocks:**
- surveySchema and answers are automatically parsed as structured JSON
- Use read_survey tool for detailed survey information
- Use fill_survey_answers to update answers
- Use validate_survey_answers to check completeness

**Important:** Block IDs are UUIDs - never guess them. Always extract exact IDs from this tool's response before calling edit_block.`,
      schema: z.object({
        includeText: z
          .boolean()
          .optional()
          .default(true)
          .describe('Whether to include text content in the response'),
        blockType: z
          .string()
          .optional()
          .nullable()
          .describe(
            'Optional: filter by block type (paragraph, proposal, checkbox, apiRequest, list, etc.)',
          ),
        start: z
          .number()
          .int()
          .optional()
          .default(0)
          .describe('Starting index (0-based) for pagination. Defaults to 0.'),
        end: z
          .number()
          .int()
          .optional()
          .default(10)
          .describe('Ending index (exclusive) for pagination. Defaults to 10.'),
      }),
    },
  );

  // ============================================================================
  // Tool 2: Edit Block
  // ============================================================================

  /**
   * Edits an existing block's properties
   *
   * Uses the production-tested editBlock helper from blockActions.ts
   * which includes:
   * - Dual-storage pattern (attrs.props + direct attributes)
   * - Proper attribute merging
   * - Text update handling
   * - Consistent with CLI edit-block command
   *
   * Can update:
   * - Block attributes (status, title, description, etc.)
   * - Text content
   * - Remove specific attributes
   *
   * Changes are synced to all connected clients via Matrix CRDT
   */
  const editBlockTool = tool(
    async ({
      blockId,
      updates,
      removeAttributes = [],
      text = null,
      runtimeUpdates = undefined,
    }) => {
      Logger.log(`✏️ edit_block tool invoked for block: ${blockId}`);

      const isInRoom = await checkIfInRoomAndJoinPublicRoom(
        matrixClient,
        roomId,
      );

      if (!isInRoom) {
        return JSON.stringify({
          success: false,
          error: `The AI Agent is not in the room ${roomId}, please invite companion to the room. companion user id: ${matrixClient.getUserId()}`,
        });
      }
      // Use the shared Matrix client (already synced)
      const providerManager = new MatrixProviderManager(matrixClient, config);

      try {
        const { doc } = await providerManager.init();

        // Guard: reject runtimeUpdates on action blocks in flow mode — use execute_action instead
        if (
          runtimeUpdates &&
          typeof runtimeUpdates === 'object' &&
          Object.keys(runtimeUpdates as Record<string, unknown>).length > 0
        ) {
          const blockDetail = getBlockDetail(doc, blockId, false);
          const blockProps = blockDetail
            ? extractBlockProperties(blockDetail)
            : {};
          const hasActionType = blockProps.actionType !== undefined;

          if (hasActionType) {
            const flowMeta = readFlowMetadata(doc);
            const isFlow = flowMeta['_type'] === 'ixo.flow.crdt';

            if (isFlow) {
              return JSON.stringify({
                success: false,
                blockId,
                error:
                  `Cannot apply runtimeUpdates directly to action block "${blockId}" in a flow document. ` +
                  `Use the execute_action tool instead — it runs the action through the flow engine ` +
                  `(activation → authorization → execution → runtime state update) for a proper audit trail.`,
              });
            }
          }
        }

        // Snapshot before changes for diff
        const beforeBlock = getBlockDetail(doc, blockId, true);
        const beforeProps = beforeBlock
          ? extractBlockProperties(beforeBlock)
          : {};
        const beforeText = beforeBlock?.text;

        // Wrap updates in 'props' for consistency with CLI pattern
        const attributes =
          Object.keys(updates).length > 0 ? { props: updates } : {};

        // Use the production-tested editBlock helper
        const _snapshot: BlockSnapshot = editBlock(doc, {
          blockId,
          attributes,
          removeAttributes,
          text: text === null ? undefined : text,
          docName: 'document',
        });

        // Apply runtime state updates if provided
        let updatedRuntimeState: Record<string, unknown> | undefined;
        if (
          runtimeUpdates &&
          typeof runtimeUpdates === 'object' &&
          Object.keys(runtimeUpdates as Record<string, unknown>).length > 0
        ) {
          doc.transact(() => {
            updatedRuntimeState = updateRuntimeState(
              doc,
              blockId,
              runtimeUpdates as Record<string, unknown>,
            );
          }, 'blocknote-crdt-playground');
        }

        // Create simplified response for agents with change tracking
        const updatedBlock = getBlockDetail(doc, blockId, true);
        const afterProps = updatedBlock
          ? extractBlockProperties(updatedBlock)
          : {};

        // Build list of what actually changed
        const updatedFields: string[] = [];
        for (const key of Object.keys(updates)) {
          if (
            JSON.stringify(beforeProps[key]) !== JSON.stringify(afterProps[key])
          ) {
            updatedFields.push(key);
          }
        }
        if (text !== null && text !== beforeText) {
          updatedFields.push('text');
        }
        if (removeAttributes.length > 0) {
          updatedFields.push(...removeAttributes.map((k) => `-${k}`));
        }
        if (updatedRuntimeState) {
          updatedFields.push(
            ...Object.keys(runtimeUpdates as Record<string, unknown>).map(
              (k) => `runtime.${k}`,
            ),
          );
        }

        const simplified = updatedBlock
          ? simplifyBlockForAgent(updatedBlock)
          : null;

        // Build diff from before/after state
        const diff: Record<string, { old: unknown; new: unknown }> = {};
        for (const field of updatedFields) {
          if (field.startsWith('-') || field.startsWith('runtime.')) continue;
          if (field === 'text') {
            diff.text = {
              old: beforeText ?? '',
              new: updatedBlock?.text ?? '',
            };
          } else {
            diff[field] = { old: beforeProps[field], new: afterProps[field] };
          }
        }

        // Changes are automatically synced by your Matrix provider
        return JSON.stringify({
          success: true,
          roomId,
          blockId,
          blockType: simplified?.type,
          message: `Updated ${updatedFields.length} field(s): ${updatedFields.join(', ') || 'no changes detected'}`,
          updatedFields,
          block: simplified,
          diff,
          ...(updatedRuntimeState && { runtimeState: updatedRuntimeState }),
        });
      } catch (error) {
        Logger.error('Error editing block:', error);
        return JSON.stringify({
          success: false,
          error: error instanceof Error ? error.message : String(error),
        });
      } finally {
        // Schedule cleanup after delay to allow Y.Doc to finish syncing
        await providerManager.dispose();
      }
    },
    {
      name: 'edit_block',
      description: `Edits an existing block's properties, content, and/or runtime state.

**CRITICAL WORKFLOW:**
1. Call list_blocks FIRST to get the exact UUID
2. Pass updates as plain key-value pairs (tool wraps them automatically)
3. Never guess or invent block IDs

**How Updates Work:**
- Pass properties as plain objects like \`{status: "open", title: "New Title"}\`
- Tool automatically wraps them in the internal \`props\` structure
- Use \`runtimeUpdates\` to update runtime state (execution status, timestamps, etc.) — merges with existing state, never overwrites
- Changes sync to all clients via CRDT

**JSON-string properties (inputs, links):**
- Some properties like \`inputs\` and \`links\` are stored as JSON strings internally
- When reading blocks, these are returned as parsed objects/arrays
- When updating, pass them as objects/arrays — they are auto-serialized back to JSON strings
- For \`inputs\` (object): your updates are MERGED with existing values. Example: \`{"inputs": {"credential": "abc"}}\` merges into existing inputs
- For \`links\` (array): your value REPLACES the existing array. Each link item needs: \`id\`, \`title\`, \`description\`, \`position\`. For external URLs add \`externalUrl\`. For internal flow links add \`docRoomId\`.

**Examples:**
- Update status: \`{"blockId": "uuid", "updates": {"status": "open"}}\`
- Update text: \`{"blockId": "uuid", "updates": {}, "text": "New content"}\`
- Update action inputs: \`{"blockId": "uuid", "updates": {"inputs": {"credential": "data", "roomId": "!room:server"}}}\`
- Update flowLink with external URL: \`{"blockId": "uuid", "updates": {"links": [{"id": "link-1", "title": "Verify Identity", "description": "Click to verify", "captionText": "", "position": 0, "externalUrl": "https://example.com/verify"}]}}\`
- Update runtime: \`{"blockId": "uuid", "updates": {}, "runtimeUpdates": {"evaluationStatus": "approved"}}\`
- Remove attrs: \`{"blockId": "uuid", "updates": {}, "removeAttributes": ["oldProp"]}\`

**Note:** Block properties vary by block type and may evolve. Use \`list_blocks\` or \`read_block_by_id\` to discover current properties for any block type.

**Returns:** Block details including id, type, properties, text, and runtimeState (if updated).

**Example response:**
\`\`\`json
{
  "success": true,
  "message": "Successfully updated block...",
  "block": {
    "id": "550e8400-e29b-41d4-a716-446655440000",
    "type": "proposal",
    "properties": {
      "status": "open",
      "title": "Updated Title",
      "description": "Updated description"
    },
    "text": "Optional text content"
  }
}
\`\`\``,
      schema: z.object({
        blockId: z
          .string()
          .describe('The exact ID of the block to edit (get from list_blocks)'),
        updates: z
          .record(z.any(), z.any())
          .describe(
            "Object with property updates. Example: {status: 'open', title: 'New Title'}",
          ),
        removeAttributes: z
          .array(z.string())
          .optional()
          .default([])
          .describe(
            "Array of attribute keys to remove. Example: ['oldProp', 'tempData']",
          ),
        text: z
          .string()
          .nullable()
          .optional()
          .describe(
            'New text content for the block. Use null to keep existing, empty string to clear',
          ),
        runtimeUpdates: z
          .record(z.any(), z.any())
          .optional()
          .describe(
            'Optional: merge updates into the block runtime state (execution status, claims, timestamps, etc.). Merges with existing state — never overwrites.',
          ),
      }),
    },
  );

  // ============================================================================
  // Tool 3: Create Block
  // ============================================================================

  /**
   * Creates a new block in the document using appendBlock from blockActions.ts.
   * Supports all block types — new blocks are appended to the end of the document.
   */
  const createBlockTool = tool(
    async ({
      blockType,
      text = '',
      attributes = {},
      blockId = null,
      referenceBlockId = null,
      placement = null,
    }) => {
      Logger.log(`➕ create_block tool invoked for type: ${blockType}`);
      // Use the shared Matrix client (already synced)
      const providerManager = new MatrixProviderManager(matrixClient, config);

      try {
        const { doc } = await providerManager.init();

        const isInRoom = await checkIfInRoomAndJoinPublicRoom(
          matrixClient,
          roomId,
        );

        if (!isInRoom) {
          return JSON.stringify({
            success: false,
            error: `The AI Agent is not in the room ${roomId}, please invite companion to the room. companion user id: ${matrixClient.getUserId()}`,
          });
        }

        // Wrap attributes in 'props' for consistency with edit_block and BlockNote schema
        const wrappedAttributes =
          Object.keys(attributes).length > 0 ? { props: attributes } : {};

        const resolvedBlockId = blockId ?? randomUUID();
        let snapshot: BlockSnapshot;

        // Use positional insertion if reference block is provided
        if (referenceBlockId && placement) {
          snapshot = insertBlock(doc, {
            referenceBlockId,
            placement,
            blockId: resolvedBlockId,
            blockType,
            text,
            attributes: wrappedAttributes,
            docName: 'document',
          });
        } else {
          snapshot = appendBlock(doc, {
            blockId: resolvedBlockId,
            blockType,
            text,
            attributes: wrappedAttributes,
            docName: 'document',
            namespace: undefined,
          });
        }

        // Get simplified view for agents

        const createdBlock = getBlockDetail(doc, snapshot.id, true);
        const simplified = createdBlock
          ? simplifyBlockForAgent(createdBlock)
          : null;

        // Count blocks to determine position
        const fragment = doc.getXmlFragment('document');
        const allBlocks = collectAllBlocks(fragment);
        const position = allBlocks.findIndex((b) => b.id === snapshot.id);

        const diff = {
          block: {
            old: null,
            new: simplified ?? {
              id: snapshot.id,
              type: blockType,
              properties: attributes,
              text,
            },
          },
        };

        return JSON.stringify({
          success: true,
          roomId,
          blockId: snapshot.id,
          blockType,
          position: position >= 0 ? position : allBlocks.length - 1,
          message: referenceBlockId
            ? `Created ${blockType} block ${placement} block ${referenceBlockId}`
            : `Created ${blockType} block at end of document`,
          block: simplified || snapshot,
          diff,
        });
      } catch (error) {
        Logger.error('Error creating block:', error);

        return JSON.stringify({
          success: false,
          error: error instanceof Error ? error.message : String(error),
        });
      } finally {
        // Schedule cleanup after delay to allow Y.Doc to finish syncing
        await providerManager.dispose();
      }
    },
    {
      name: 'create_block',
      description: `Creates a new block in the BlockNote document.

**Usage:**
- By default, appends new blocks to the end of the document
- Use \`referenceBlockId\` + \`placement\` to insert before/after a specific block
- Initialize blocks with specific properties as key-value pairs
- Block ID (UUID) is auto-generated unless you provide one
- Use \`read_block_by_id\` on existing blocks to discover available properties for any block type

**Examples:**
- Append paragraph: \`{"blockType": "paragraph", "text": "Hello world"}\`
- Insert before a block: \`{"blockType": "paragraph", "text": "Inserted text", "referenceBlockId": "uuid-here", "placement": "before"}\`
- Insert after a block: \`{"blockType": "proposal", "attributes": {"status": "draft"}, "referenceBlockId": "uuid-here", "placement": "after"}\`

**Note:** Block attributes vary by type and may evolve. Use \`read_block_by_id\` on existing blocks to discover available properties.

**Returns:**
\`\`\`json
{
  "success": true,
  "message": "Successfully created proposal block",
  "block": {
    "id": "550e8400-e29b-41d4-a716-446655440000",
    "type": "proposal",
    "properties": {...},
    "text": ""
  }
}
\`\`\`

The returned block includes the auto-generated UUID that you can use for future edits.`,
      schema: z.object({
        blockType: z
          .string()
          .describe(
            'Type of block to create: paragraph, proposal, checkbox, apiRequest, list, etc.',
          ),
        text: z
          .string()
          .optional()
          .default('')
          .describe('Text content for the block (mainly for paragraphs)'),
        attributes: z
          .record(z.any(), z.any())
          .optional()
          .default({})
          .describe(
            "Block-specific attributes as key-value pairs. Example: {status: 'draft', title: 'My Proposal'}",
          ),
        blockId: z
          .string()
          .optional()
          .nullable()
          .describe(
            'Optional: custom block ID. If not provided, one will be generated automatically',
          ),
        referenceBlockId: z
          .string()
          .optional()
          .nullable()
          .describe(
            'Optional: ID of an existing block to insert relative to. Must be used with placement.',
          ),
        placement: z
          .enum(['before', 'after'])
          .optional()
          .nullable()
          .describe(
            'Optional: insert "before" or "after" the referenceBlockId. Required when referenceBlockId is provided.',
          ),
      }),
    },
  );

  const readBlockByIdTool = tool(
    async ({
      blockId,
      evaluateConditions: evalConds = false,
      resolveReferences: resolveRefs = false,
    }) => {
      Logger.log(`📄 read_block_by_id tool invoked for block: ${blockId}`);
      const providerManager = new MatrixProviderManager(matrixClient, config);
      try {
        const { doc } = await providerManager.init();
        const block = getBlockDetail(doc, blockId, true);

        if (!block) {
          return JSON.stringify({
            success: false,
            blockId,
            error: `Block with id ${blockId} not found`,
          });
        }

        const simplified = simplifyBlockForAgent(block);
        const result: Record<string, unknown> = {
          success: true,
          blockId,
          blockType: simplified.type,
          block: simplified,
        };

        // Include runtime state for this block if it exists
        const blockRuntimeState = readRuntimeState(doc, blockId);
        const runtimeData = blockRuntimeState[blockId];
        if (runtimeData && Object.keys(runtimeData).length > 0) {
          result.runtimeState = runtimeData;
        }

        // Optional: evaluate conditions
        if (evalConds) {
          const attrs = block.attributes || {};
          const attrsObj =
            (attrs.attrs as Record<string, unknown> | undefined) || {};
          const props =
            (attrsObj.props as Record<string, unknown> | undefined) || {};
          const conditionsJson =
            (props.conditions as string) || (attrs.conditions as string) || '';

          if (conditionsJson) {
            try {
              const conditionConfig = JSON.parse(
                conditionsJson,
              ) as ConditionConfig;
              const fragment = doc.getXmlFragment('document');
              const allBlocks = collectAllBlocks(fragment);
              result.conditionEvaluation = evaluateBlockConditions(
                conditionConfig,
                allBlocks,
              );
            } catch {
              result.conditionEvaluation = {
                error: 'Failed to parse conditions JSON',
              };
            }
          } else {
            result.conditionEvaluation = {
              isVisible: true,
              isEnabled: true,
              actions: [],
            };
          }
        }

        // Optional: resolve references in string props
        if (resolveRefs) {
          const fragment = doc.getXmlFragment('document');
          const allBlocks = collectAllBlocks(fragment);
          const resolvedProps: Record<string, unknown> = {};
          const blockProps = simplified.properties || {};

          for (const [key, val] of Object.entries(blockProps)) {
            if (
              typeof val === 'string' &&
              val.includes('{{') &&
              val.includes('}}')
            ) {
              resolvedProps[key] = resolveBlockReferences(val, allBlocks);
            }
          }

          if (Object.keys(resolvedProps).length > 0) {
            result.resolvedReferences = resolvedProps;
          }
        }

        return JSON.stringify(result, null, 2);
      } catch (error) {
        return JSON.stringify({
          success: false,
          error: error instanceof Error ? error.message : String(error),
        });
      } finally {
        await providerManager.dispose();
      }
    },
    {
      name: 'read_block_by_id',
      description: `Reads a block by its ID. Returns block properties AND runtime state (execution status, claims, timestamps, etc.) in a single call.

Automatically includes runtimeState from Y.Map('runtime') when data exists for this block. Parses surveySchema and answers for survey blocks.

Optional flags:
- evaluateConditions: true → evaluates the block's condition config against all blocks, returns { isVisible, isEnabled, conditionActions[] }
- resolveReferences: true → resolves {{blockId.prop}} patterns in block props, returns resolved values`,
      schema: z.object({
        blockId: z.string().describe('The ID of the block to read'),
        evaluateConditions: z
          .boolean()
          .optional()
          .default(false)
          .describe(
            'If true, evaluates the block conditions and returns visibility/enabled state',
          ),
        resolveReferences: z
          .boolean()
          .optional()
          .default(false)
          .describe(
            'If true, resolves {{blockId.prop}} template references in block props',
          ),
      }),
    },
  );

  // ============================================================================
  // Tool 5: Read Survey
  // ============================================================================

  const readSurveyTool = tool(
    async ({ blockId }) => {
      Logger.log(`📋 read_survey tool invoked for block: ${blockId}`);
      const providerManager = new MatrixProviderManager(matrixClient, config);

      try {
        const { doc } = await providerManager.init();

        const isInRoom = await checkIfInRoomAndJoinPublicRoom(
          matrixClient,
          roomId,
        );

        if (!isInRoom) {
          return JSON.stringify({
            success: false,
            error: `The AI Agent is not in the room ${roomId}, please invite companion to the room. companion user id: ${matrixClient.getUserId()}`,
          });
        }

        const block = getBlockDetail(doc, blockId, true);
        console.log('🚀 ~ createBlocknoteTools ~ block:', block);
        if (!block) {
          return JSON.stringify({
            success: false,
            error: `Block with id ${blockId} not found`,
          });
        }

        const properties = extractBlockProperties(block);
        const surveySchema = properties.surveySchema as
          | SurveySchema
          | undefined;
        const answers = (properties.answers || {}) as Record<string, unknown>;

        if (!surveySchema) {
          Logger.error('Block does not contain a surveySchema:', block);
          return JSON.stringify({
            success: false,
            error: `Block ${blockId} does not contain a surveySchema property. This tool works with any block that has a surveySchema (domainCreator, form, governanceGroup, bid, claim, etc.)`,
          });
        }

        // Extract all questions with visibility computed inline
        const allQuestions = await extractSurveyQuestions(
          surveySchema,
          answers,
        );

        const missingRequired = await getMissingRequiredFields(
          answers,
          surveySchema,
        );

        return JSON.stringify(
          {
            success: true,
            survey: {
              title: surveySchema.title,
              description: surveySchema.description,
            },
            questions: allQuestions,
            answers,
            missingRequiredFields: missingRequired,
            totalQuestions: allQuestions.length,
          },
          null,
          2,
        );
      } catch (error) {
        Logger.error('Error reading survey:', error);
        return JSON.stringify({
          success: false,
          error: error instanceof Error ? error.message : String(error),
        });
      } finally {
        await providerManager.dispose();
      }
    },
    {
      name: 'read_survey',
      description: `Reads survey schema and current answers from any block with a surveySchema property.

**Purpose:**
- View complete survey structure (ALL questions including hidden ones)
- See current answers as structured JSON
- Identify which questions are currently visible vs hidden
- Understand why fields are hidden (via visibleIf conditions)
- Find missing required fields (only for visible questions)
- Automatically fetches choices from choicesByUrl for dropdown questions
- Works with any block type that has a surveySchema (domainCreator, form, governanceGroup, bid, claim, etc.)

**Important:**
- ALL questions are returned (both visible and hidden), not just visible ones
- \`isVisible: true\` means the field is currently shown in the UI
- \`isVisible: false\` means the field is hidden by a \`visibleIf\` condition
- \`visibleIf\` field shows the condition that controls visibility
- Hidden fields can be made visible by changing the controlling answer
- Nested dynamic panel template elements are included in the questions array
- Choices from choicesByUrl are automatically fetched and included

**Note:** The \`answers\` object may contain data for hidden fields — use the \`questions\` array to understand the schema for those fields.`,
      schema: z.object({
        blockId: z
          .string()
          .describe('The ID of the block containing the survey'),
      }),
    },
  );

  // ============================================================================
  // Tool 6: Fill Survey Answers
  // ============================================================================

  const fillSurveyAnswersTool = tool(
    async ({ blockId, answers, merge = true }) => {
      Logger.log(`✏️ fill_survey_answers tool invoked for block: ${blockId}`);
      const providerManager = new MatrixProviderManager(matrixClient, config);

      try {
        const { doc } = await providerManager.init();

        const isInRoom = await checkIfInRoomAndJoinPublicRoom(
          matrixClient,
          roomId,
        );

        if (!isInRoom) {
          return JSON.stringify({
            success: false,
            error: `The AI Agent is not in the room ${roomId}, please invite companion to the room. companion user id: ${matrixClient.getUserId()}`,
          });
        }

        const block = getBlockDetail(doc, blockId, true);
        if (!block) {
          return JSON.stringify({
            success: false,
            error: `Block with id ${blockId} not found`,
          });
        }

        const properties = extractBlockProperties(block);
        const surveySchema = properties.surveySchema as
          | SurveySchema
          | undefined;

        if (!surveySchema) {
          return JSON.stringify({
            success: false,
            error: `Block ${blockId} does not contain a surveySchema property. This tool works with any block that has a surveySchema (domainCreator, form, governanceGroup, bid, claim, etc.)`,
          });
        }

        // Get current answers
        const currentAnswers = (properties.answers || {}) as Record<
          string,
          unknown
        >;

        // Merge or replace answers
        const updatedAnswers = merge
          ? { ...currentAnswers, ...answers }
          : answers;

        // Validate the updated answers
        const validation = await validateAnswersAgainstSchema(
          updatedAnswers,
          surveySchema,
        );

        // Update the block's answers attribute
        const fragment = doc.getXmlFragment('document');
        const blockContainer = findBlockById(fragment, blockId);

        if (!blockContainer) {
          return JSON.stringify({
            success: false,
            error: `Block container not found`,
          });
        }

        // Use Y.js transaction to update the answers
        doc.transact(() => {
          // Find the content child element that has an answers attribute
          const contentElement = blockContainer
            .toArray()
            .find(
              (node): node is Y.XmlElement =>
                node instanceof Y.XmlElement &&
                node.nodeName !== 'blockGroup' &&
                node.nodeName !== 'blockContainer',
            );

          if (contentElement) {
            // Update the answers attribute as JSON string directly on the child element
            contentElement.setAttribute(
              'answers',
              JSON.stringify(updatedAnswers),
            );
          } else {
            logger.error(
              'Content element not found, falling back to edit_block helper',
            );
            // Fallback: use edit_block helper which handles the structure properly
            editBlock(doc, {
              blockId,
              attributes: {
                props: { answers: JSON.stringify(updatedAnswers) },
              },
              docName: 'document',
            });
          }
        }, 'blocknote-crdt-playground');

        return JSON.stringify(
          {
            success: true,
            message: `Successfully ${merge ? 'merged' : 'replaced'} survey answers`,
            answers: updatedAnswers,
            validation,
            missingRequiredFields: await getMissingRequiredFields(
              updatedAnswers,
              surveySchema,
            ),
          },
          null,
          2,
        );
      } catch (error) {
        Logger.error('Error filling survey answers:', error);
        return JSON.stringify({
          success: false,
          error: error instanceof Error ? error.message : String(error),
        });
      } finally {
        await providerManager.dispose();
      }
    },
    {
      name: 'fill_survey_answers',
      description: `Fills in survey answers for any block with a surveySchema. Intelligently merges with existing answers and validates against schema.

**Purpose:**
- Fill in partial or complete survey answers
- Merge with existing answers (default) or replace them
- Automatically validates answers against schema
- Respects visibility conditions
- Works with any block type that has a surveySchema (domainCreator, form, governanceGroup, bid, claim, etc.)

**Example 1 - Fill single answer:**
\`\`\`json
{
  "blockId": "271fc5de-bcd8-4de0-8dd7-fb3dd5c13785",
  "answers": {
    "schema:name": "My New Domain",
    "schema.description": "A description of my domain"
  },
  "merge": true
}
\`\`\`

**Example 2 - Replace all answers:**
\`\`\`json
{
  "blockId": "271fc5de-bcd8-4de0-8dd7-fb3dd5c13785",
  "answers": {
    "schema:name": "New Domain",
    "type_2": "dao",
    "schema:validFrom": "2025-01-01"
  },
  "merge": false
}
\`\`\`

**Note:**
- Use merge=true (default) to keep existing answers and only update specified fields
- Use merge=false to replace all answers
- Answers are validated automatically
- Only visible questions (based on visibility conditions) are considered`,
      schema: z.object({
        blockId: z
          .string()
          .describe('The ID of the block containing the survey'),
        answers: z
          .record(z.any(), z.any())
          .describe(
            'Object with answer key-value pairs. Keys should match question names from the schema.',
          ),
        merge: z
          .boolean()
          .optional()
          .default(true)
          .describe(
            'If true, merge with existing answers. If false, replace all answers.',
          ),
      }),
    },
  );

  // ============================================================================
  // Tool 7: Validate Survey Answers
  // ============================================================================

  const validateSurveyAnswersTool = tool(
    async ({ blockId }) => {
      Logger.log(
        `✅ validate_survey_answers tool invoked for block: ${blockId}`,
      );
      const providerManager = new MatrixProviderManager(matrixClient, config);

      try {
        const { doc } = await providerManager.init();

        const isInRoom = await checkIfInRoomAndJoinPublicRoom(
          matrixClient,
          roomId,
        );

        if (!isInRoom) {
          return JSON.stringify({
            success: false,
            error: `The AI Agent is not in the room ${roomId}, please invite companion to the room. companion user id: ${matrixClient.getUserId()}`,
          });
        }

        const block = getBlockDetail(doc, blockId, true);
        if (!block) {
          return JSON.stringify({
            success: false,
            error: `Block with id ${blockId} not found`,
          });
        }

        const properties = extractBlockProperties(block);
        const surveySchema = properties.surveySchema as
          | SurveySchema
          | undefined;
        const answers = (properties.answers || {}) as Record<string, unknown>;

        if (!surveySchema) {
          return JSON.stringify({
            success: false,
            error: `Block ${blockId} does not contain a surveySchema property. This tool works with any block that has a surveySchema (domainCreator, form, governanceGroup, bid, claim, etc.)`,
          });
        }

        const validation = await validateAnswersAgainstSchema(
          answers,
          surveySchema,
        );
        const missingRequired = await getMissingRequiredFields(
          answers,
          surveySchema,
        );
        const visibleQuestions = await getVisibleQuestions(
          answers,
          surveySchema,
        );

        return JSON.stringify(
          {
            success: true,
            valid: validation.valid,
            errors: validation.errors,
            warnings: validation.warnings,
            missingRequiredFields: missingRequired,
            answeredQuestions: Object.keys(answers).length,
            visibleQuestionsCount: visibleQuestions.length,
            totalRequiredFields: visibleQuestions.filter((q) => q.isRequired)
              .length,
            completionPercentage:
              visibleQuestions.length > 0
                ? Math.round(
                    ((visibleQuestions.length - missingRequired.length) /
                      visibleQuestions.length) *
                      100,
                  )
                : 0,
          },
          null,
          2,
        );
      } catch (error) {
        Logger.error('Error validating survey answers:', error);
        return JSON.stringify({
          success: false,
          error: error instanceof Error ? error.message : String(error),
        });
      } finally {
        await providerManager.dispose();
      }
    },
    {
      name: 'validate_survey_answers',
      description: `Validates current survey answers against the schema requirements. Works with any block that has a surveySchema.

**Purpose:**
- Check if all required fields are filled
- Validate answer types and formats
- Identify validation errors and warnings
- Calculate completion percentage
- Works with any block type that has a surveySchema (domainCreator, form, governanceGroup, bid, claim, etc.)

**Validation Types:**
- required: Field is required but missing or empty
- type: Answer type doesn't match expected type (e.g., boolean vs string)
- choice: Answer value not in allowed choices (for dropdowns)
- format: Answer format is invalid (e.g., invalid email or URL)

**Note:** Only validates visible questions based on current answers and visibility conditions.`,
      schema: z.object({
        blockId: z
          .string()
          .describe('The ID of the block to validate survey answers for'),
      }),
    },
  );

  // ============================================================================
  // Tool 8: Read Flow Context
  // ============================================================================

  const readFlowContextTool = tool(
    async () => {
      logger.log('📊 read_flow_context tool invoked');
      const providerManager = new MatrixProviderManager(matrixClient, config);

      try {
        const { doc } = await providerManager.init();

        const isInRoom = await checkIfInRoomAndJoinPublicRoom(
          matrixClient,
          roomId,
        );
        if (!isInRoom) {
          return JSON.stringify({
            success: false,
            error: `The AI Agent is not in the room ${roomId}, please invite companion to the room. companion user id: ${matrixClient.getUserId()}`,
          });
        }

        const flowMetadata = readFlowMetadata(doc);
        const fragment = doc.getXmlFragment('document');
        const blocks = collectAllBlocks(fragment);
        const flowNodes = readFlowNodes(doc);
        const runtimeMap = doc.getMap('runtime');
        const delegationsMap = doc.getMap('delegations');

        return JSON.stringify(
          {
            success: true,
            roomId,
            flowMetadata,
            summary: {
              blockCount: blocks.length,
              flowNodeCount: flowNodes.length,
              isFlowDocument: flowMetadata['_type'] === 'ixo.flow.crdt',
              hasRuntimeState: runtimeMap.size > 0,
              hasDelegations: delegationsMap.size > 1,
            },
          },
          null,
          2,
        );
      } catch (error) {
        return JSON.stringify({
          success: false,
          error: error instanceof Error ? error.message : String(error),
        });
      } finally {
        await providerManager.dispose();
      }
    },
    {
      name: 'read_flow_context',
      description: `Reads flow-level metadata and document context. **Call this FIRST** in any new conversation to understand what document you're working with.

Returns: flow metadata (title, owner DID, doc type, schema version, creation date), block count, flow node count, and whether runtime state/delegations exist.

This is a lightweight call that gives you the full picture before diving into specific blocks.`,
      schema: z.object({}),
    },
  );

  // ============================================================================
  // Tool 9: Read Flow Status
  // ============================================================================

  const readFlowStatusTool = tool(
    async ({ nodeId = null }) => {
      logger.log(
        `📈 read_flow_status tool invoked${nodeId ? ` for node: ${nodeId}` : ''}`,
      );
      const providerManager = new MatrixProviderManager(matrixClient, config);

      try {
        const { doc } = await providerManager.init();

        const isInRoom = await checkIfInRoomAndJoinPublicRoom(
          matrixClient,
          roomId,
        );
        if (!isInRoom) {
          return JSON.stringify({
            success: false,
            error: `The AI Agent is not in the room ${roomId}, please invite companion to the room. companion user id: ${matrixClient.getUserId()}`,
          });
        }

        const flowNodes = readFlowNodes(doc);
        const runtimeState = readRuntimeState(doc, nodeId ?? undefined);

        // Enrich runtime state with human-readable dates
        const enrichedState: Record<string, Record<string, unknown>> = {};
        for (const [id, state] of Object.entries(runtimeState)) {
          const enriched: Record<string, unknown> = { ...state };
          const ts = state['executionTimestamp'];
          if (typeof ts === 'number') {
            enriched['executionDate'] = new Date(ts).toISOString();
          }
          enrichedState[id] = enriched;
        }

        // Build summary — graceful field checks for generic data
        const allRuntimeState = readRuntimeState(doc);
        const stateValues = Object.values(allRuntimeState);
        const executedNodes = stateValues.filter(
          (s) => s['executionTimestamp'],
        ).length;

        return JSON.stringify(
          {
            success: true,
            flowNodes,
            runtimeState: enrichedState,
            summary: {
              totalNodes: flowNodes.length,
              executedNodes,
              pendingNodes: stateValues.filter(
                (s) => s['evaluationStatus'] === 'pending',
              ).length,
              approvedNodes: stateValues.filter(
                (s) => s['evaluationStatus'] === 'approved',
              ).length,
              rejectedNodes: stateValues.filter(
                (s) => s['evaluationStatus'] === 'rejected',
              ).length,
            },
          },
          null,
          2,
        );
      } catch (error) {
        return JSON.stringify({
          success: false,
          error: error instanceof Error ? error.message : String(error),
        });
      } finally {
        await providerManager.dispose();
      }
    },
    {
      name: 'read_flow_status',
      description: `Reads the execution status of flow nodes. Shows which blocks have been executed, by whom, when, and their evaluation status (pending/approved/rejected).

Use this to answer: "What's the status of this flow?", "Which steps are done?", "Who executed block X?"

Pass nodeId to check a specific node, or omit to get all nodes.`,
      schema: z.object({
        nodeId: z
          .string()
          .optional()
          .nullable()
          .describe('Optional: specific node ID to check. Omit for all nodes.'),
      }),
    },
  );

  // ============================================================================
  // Tool 10: Read Block History
  // ============================================================================

  const readBlockHistoryTool = tool(
    async ({ blockId }) => {
      logger.log(`📜 read_block_history tool invoked for block: ${blockId}`);
      const providerManager = new MatrixProviderManager(matrixClient, config);

      try {
        const { doc } = await providerManager.init();

        const isInRoom = await checkIfInRoomAndJoinPublicRoom(
          matrixClient,
          roomId,
        );
        if (!isInRoom) {
          return JSON.stringify({
            success: false,
            error: `The AI Agent is not in the room ${roomId}, please invite companion to the room. companion user id: ${matrixClient.getUserId()}`,
          });
        }

        const auditEvents = readAuditTrailForBlock(doc, blockId);
        const invocations = readInvocations(doc, blockId);

        const successfulInvocations = invocations.filter(
          (i) => i['result'] === 'success',
        ).length;
        const failedInvocations = invocations.filter(
          (i) => i['result'] === 'failure',
        ).length;

        // Enrich invocations with human-readable dates
        const enrichedInvocations = invocations.map((inv) => {
          const enriched: Record<string, unknown> = { ...inv };
          const executedAt = inv['executedAt'];
          if (typeof executedAt === 'number') {
            enriched['executedDate'] = new Date(executedAt).toISOString();
          } else if (typeof executedAt === 'string') {
            enriched['executedDate'] = new Date(executedAt).toISOString();
          }
          return enriched;
        });

        // Find most recent activity
        const lastAuditEvent =
          auditEvents.length > 0
            ? auditEvents[auditEvents.length - 1]
            : undefined;
        const lastAuditMeta =
          lastAuditEvent &&
          typeof lastAuditEvent['meta'] === 'object' &&
          lastAuditEvent['meta'] !== null
            ? (lastAuditEvent['meta'] as Record<string, unknown>)
            : undefined;
        const lastAuditTs = lastAuditMeta?.['timestamp'] as string | undefined;
        const firstInv =
          enrichedInvocations.length > 0 ? enrichedInvocations[0] : undefined;
        const lastInvTs = firstInv?.['executedDate'] as string | undefined;
        const lastActivity =
          lastAuditTs && lastInvTs
            ? lastAuditTs > lastInvTs
              ? lastAuditTs
              : lastInvTs
            : lastAuditTs || lastInvTs;

        return JSON.stringify(
          {
            success: true,
            blockId,
            auditEvents,
            invocations: enrichedInvocations,
            summary: {
              totalAuditEvents: auditEvents.length,
              totalInvocations: invocations.length,
              successfulInvocations,
              failedInvocations,
              lastActivity,
            },
          },
          null,
          2,
        );
      } catch (error) {
        return JSON.stringify({
          success: false,
          error: error instanceof Error ? error.message : String(error),
        });
      } finally {
        await providerManager.dispose();
      }
    },
    {
      name: 'read_block_history',
      description: `Reads the complete history for a specific block: audit trail events and UCAN invocations.

Use this to answer: "What happened with block X?", "Who executed this?", "When was this last updated?"

Returns audit events (timestamped actions) and invocations (UCAN-authorized executions with results and transaction hashes).`,
      schema: z.object({
        blockId: z.string().describe('The block ID to read history for'),
      }),
    },
  );

  // ============================================================================
  // Tool 11: Read Permissions
  // ============================================================================

  const readPermissionsTool = tool(
    async ({ audienceDid = null, capability = null }) => {
      logger.log('🔐 read_permissions tool invoked');
      const providerManager = new MatrixProviderManager(matrixClient, config);

      try {
        const { doc } = await providerManager.init();

        const isInRoom = await checkIfInRoomAndJoinPublicRoom(
          matrixClient,
          roomId,
        );
        if (!isInRoom) {
          return JSON.stringify({
            success: false,
            error: `The AI Agent is not in the room ${roomId}, please invite companion to the room. companion user id: ${matrixClient.getUserId()}`,
          });
        }

        const { rootCid, delegations } = readDelegations(doc);

        // Apply filters using bracket notation on generic records
        let filtered = delegations;
        if (audienceDid) {
          filtered = filtered.filter((d) => d['audienceDid'] === audienceDid);
        }
        if (capability) {
          filtered = filtered.filter((d) => {
            const caps = d['capabilities'];
            if (!Array.isArray(caps)) return false;
            return caps.some(
              (c: Record<string, unknown>) =>
                c['can'] === capability ||
                (typeof c['can'] === 'string' &&
                  c['can'].endsWith('/*') &&
                  capability.startsWith(c['can'].slice(0, -2))),
            );
          });
        }

        const now = Date.now();
        const enriched = filtered.map((d) => {
          const expiration = d['expiration'];
          const enrichedDelegation: Record<string, unknown> = { ...d };
          if (typeof expiration === 'number') {
            enrichedDelegation['expirationDate'] = new Date(
              expiration,
            ).toISOString();
            enrichedDelegation['isExpired'] = expiration < now;
          } else {
            enrichedDelegation['isExpired'] = false;
          }
          return enrichedDelegation;
        });

        const activeDelegations = enriched.filter((d) => !d['isExpired']);
        const uniqueActors = [
          ...new Set(
            filtered
              .map((d) => d['audienceDid'])
              .filter((v): v is string => typeof v === 'string'),
          ),
        ];

        return JSON.stringify(
          {
            success: true,
            rootDelegationCid: rootCid,
            delegations: enriched,
            summary: {
              totalDelegations: enriched.length,
              activeDelegations: activeDelegations.length,
              expiredDelegations: enriched.length - activeDelegations.length,
              uniqueActors,
            },
          },
          null,
          2,
        );
      } catch (error) {
        return JSON.stringify({
          success: false,
          error: error instanceof Error ? error.message : String(error),
        });
      } finally {
        await providerManager.dispose();
      }
    },
    {
      name: 'read_permissions',
      description: `Reads the UCAN delegation chain — who has permission to do what in this flow.

Use this to answer: "Who can execute block X?", "What permissions does user Y have?", "Show me the delegation chain."

Optionally filter by audienceDid (recipient) or capability action (e.g., "flow/block/execute"). Supports wildcard matching (e.g., "flow/*" covers "flow/block/execute").`,
      schema: z.object({
        audienceDid: z
          .string()
          .optional()
          .nullable()
          .describe('Optional: filter by recipient DID'),
        capability: z
          .string()
          .optional()
          .nullable()
          .describe(
            'Optional: filter by capability action, e.g. "flow/block/execute"',
          ),
      }),
    },
  );

  // ============================================================================
  // Tool 12: Delete Block
  // ============================================================================

  const deleteBlockTool = tool(
    async ({ blockId, confirm }) => {
      logger.log(`🗑️ delete_block tool invoked for block: ${blockId}`);

      if (!confirm) {
        return JSON.stringify({
          success: false,
          error:
            'Deletion requires confirm: true. Set confirm to true to proceed with deletion.',
        });
      }

      const isInRoom = await checkIfInRoomAndJoinPublicRoom(
        matrixClient,
        roomId,
      );
      if (!isInRoom) {
        return JSON.stringify({
          success: false,
          error: `The AI Agent is not in the room ${roomId}, please invite companion to the room. companion user id: ${matrixClient.getUserId()}`,
        });
      }

      const providerManager = new MatrixProviderManager(matrixClient, config);

      try {
        const { doc } = await providerManager.init();

        // Snapshot before deletion so we can report what was removed
        const beforeBlock = getBlockDetail(doc, blockId, true);
        const beforeSimplified = beforeBlock
          ? simplifyBlockForAgent(beforeBlock)
          : null;

        const deleted = deleteBlock(doc, {
          blockId,
          docName: 'document',
        });

        if (!deleted) {
          return JSON.stringify({
            success: false,
            blockId,
            error: `Block with id ${blockId} not found`,
          });
        }

        // Count remaining blocks
        const fragment = doc.getXmlFragment('document');
        const remaining = collectAllBlocks(fragment);

        return JSON.stringify({
          success: true,
          blockId,
          blockType: beforeSimplified?.type,
          message: `Deleted ${beforeSimplified?.type || 'unknown'} block "${beforeSimplified?.text?.slice(0, 60) || '(no text)'}"`,
          deletedBlock: beforeSimplified,
          remainingBlockCount: remaining.length,
        });
      } catch (error) {
        Logger.error('Error deleting block:', error);
        return JSON.stringify({
          success: false,
          blockId,
          error: error instanceof Error ? error.message : String(error),
        });
      } finally {
        await providerManager.dispose();
      }
    },
    {
      name: 'delete_block',
      description: `Removes a block from the document. Requires confirm: true as a safety check.

**CRITICAL:** Always call list_blocks first to verify the block ID. This action cannot be undone.`,
      schema: z.object({
        blockId: z
          .string()
          .describe(
            'The exact UUID of the block to delete (get from list_blocks)',
          ),
        confirm: z
          .boolean()
          .describe(
            'Must be true to confirm deletion. Safety check to prevent accidental deletions.',
          ),
      }),
    },
  );

  // ============================================================================
  // Tool 13: Search Blocks
  // ============================================================================

  const searchBlocksTool = tool(
    async ({
      blockType = null,
      propKey = null,
      propValue = null,
      textContains = null,
    }) => {
      logger.log('🔍 search_blocks tool invoked');
      const providerManager = new MatrixProviderManager(matrixClient, config);

      try {
        const { doc } = await providerManager.init();

        const isInRoom = await checkIfInRoomAndJoinPublicRoom(
          matrixClient,
          roomId,
        );
        if (!isInRoom) {
          return JSON.stringify({
            success: false,
            error: `The AI Agent is not in the room ${roomId}, please invite companion to the room. companion user id: ${matrixClient.getUserId()}`,
          });
        }

        const fragment = doc.getXmlFragment('document');
        let blocks = collectAllBlocks(fragment);

        // Apply filters (AND logic)
        if (blockType) {
          blocks = blocks.filter((b) => {
            const simplified = simplifyBlockForAgent(b);
            return simplified.type === blockType;
          });
        }

        if (propKey && propValue !== null) {
          blocks = blocks.filter((b) => {
            const props = extractBlockProperties(b);
            const actual = String(props[propKey]);
            const expected = String(propValue);
            // Exact match or emoji-equivalent match
            return (
              actual === expected ||
              emojify(actual) === emojify(expected) ||
              unemojify(actual) === unemojify(expected)
            );
          });
        }

        if (textContains) {
          blocks = blocks.filter(
            (b) => b.text && emojiAwareIncludes(b.text, textContains),
          );
        }

        const simplified = blocks.map(simplifyBlockForAgent);

        // Build query echo so the agent knows what filters were applied
        const appliedFilters: string[] = [];
        if (blockType) appliedFilters.push(`type=${blockType}`);
        if (propKey) appliedFilters.push(`${propKey}=${propValue}`);
        if (textContains) appliedFilters.push(`text~"${textContains}"`);

        return JSON.stringify(
          {
            success: true,
            roomId,
            query: appliedFilters.join(' AND ') || '(all blocks)',
            count: simplified.length,
            blocks: simplified,
          },
          null,
          2,
        );
      } catch (error) {
        return JSON.stringify({
          success: false,
          error: error instanceof Error ? error.message : String(error),
        });
      } finally {
        await providerManager.dispose();
      }
    },
    {
      name: 'search_blocks',
      description: `Search blocks by type, property value, or text content. Filters combine with AND logic.

Examples:
- Find all proposals: {"blockType": "proposal"}
- Find executed blocks: {"propKey": "status", "propValue": "executed"}
- Find blocks mentioning "KYC": {"textContains": "KYC"}
- Combine: {"blockType": "checkbox", "propKey": "checked", "propValue": "true"}`,
      schema: z.object({
        blockType: z
          .string()
          .optional()
          .nullable()
          .describe('Filter by block type (proposal, checkbox, form, etc.)'),
        propKey: z
          .string()
          .optional()
          .nullable()
          .describe('Property key to search on (e.g., "status", "title")'),
        propValue: z
          .string()
          .optional()
          .nullable()
          .describe('Property value to match (exact string match)'),
        textContains: z
          .string()
          .optional()
          .nullable()
          .describe(
            'Search text content of blocks (case-insensitive substring match)',
          ),
      }),
    },
  );

  // ============================================================================
  // Tool 14: Execute Action (flow engine integration)
  // ============================================================================

  /**
   * Executes an action block through the flow engine pipeline:
   * activation → authorization → execution → runtime state update.
   *
   * Supports: http.request, email.send, notification.push,
   * human.checkbox.set, form.submit, protocol.select
   */
  const executeActionTool = tool(
    async ({ blockId, inputOverrides = {} }) => {
      Logger.log(`⚡ execute_action tool invoked for block: ${blockId}`);

      const isInRoom = await checkIfInRoomAndJoinPublicRoom(
        matrixClient,
        roomId,
      );

      if (!isInRoom) {
        return JSON.stringify({
          success: false,
          error: `The AI Agent is not in the room ${roomId}, please invite companion to the room. companion user id: ${matrixClient.getUserId()}`,
        });
      }

      const providerManager = new MatrixProviderManager(matrixClient, config);

      try {
        const { doc } = await providerManager.init();

        // 1. Verify this is a flow document (not a template)
        const flowMeta = readFlowMetadata(doc);
        if (flowMeta['_type'] !== 'ixo.flow.crdt') {
          return JSON.stringify({
            success: false,
            error:
              'execute_action is only supported on flow documents, not templates.',
          });
        }

        // 2. Read the block and extract actionType
        const blockDetail = getBlockDetail(doc, blockId, false);
        if (!blockDetail) {
          return JSON.stringify({
            success: false,
            error: `Block "${blockId}" not found.`,
          });
        }

        const blockProps = extractBlockProperties(blockDetail);
        const actionType = blockProps.actionType as string | undefined;
        if (!actionType) {
          return JSON.stringify({
            success: false,
            error: `Block "${blockId}" is not an action block (no actionType property).`,
          });
        }

        // 3. Look up registered action
        const actionDef = getAction(actionType);
        if (!actionDef) {
          const available = getAllActions().map((a) => a.type);
          return JSON.stringify({
            success: false,
            error: `Unknown action type "${actionType}". Available: ${available.join(', ')}`,
          });
        }

        // 4. Parse inputs from block props and merge with overrides
        let inputs: Record<string, unknown> = {};
        if (blockProps.inputs) {
          try {
            inputs =
              typeof blockProps.inputs === 'string'
                ? JSON.parse(blockProps.inputs)
                : (blockProps.inputs as Record<string, unknown>);
          } catch {
            inputs = {};
          }
        }
        if (inputOverrides && Object.keys(inputOverrides).length > 0) {
          inputs = { ...inputs, ...inputOverrides };
        }

        // 5. Resolve {{blockId.prop}} references in input values
        const allBlocks = collectAllBlocks(doc.getXmlFragment('document'));
        for (const [key, val] of Object.entries(inputs)) {
          if (
            typeof val === 'string' &&
            val.includes('{{') &&
            val.includes('}}')
          ) {
            inputs[key] = resolveBlockReferences(val, allBlocks);
          }
        }

        // 6. Build FlowNode from block
        const flowNode = buildFlowNodeFromBlock({
          id: blockId,
          type: blockDetail.blockType || 'action',
          props: blockProps,
        });

        // 7. Build runtime state manager from Y.Doc
        const runtimeManager = createYDocRuntimeManager(doc);

        // 8. Derive oracle DID from Matrix user ID
        // Matrix format: @did-ixo-ixo1abc123:mx.server.com → did:ixo:ixo1abc123
        const actorDid = matrixUserIdToDid(config.matrix.userId ?? '');

        const flowId = (flowMeta.doc_id as string) ?? roomId;

        // 9. Execute through the flow engine (V1 — no UCAN invocation for MVP)
        // executeNode handles: activation check → authorization check → action() → runtime update
        const outcome = await executeNode({
          node: flowNode,
          actorDid,
          context: {
            runtime: runtimeManager,
          },
          action: async () => {
            const result = await actionDef.run(inputs, {
              actorDid,
              flowId,
              nodeId: blockId,
              services: oracleActionServices,
            });
            return { payload: result.output };
          },
        });

        // Supplement runtime with V1 lifecycle fields + action output
        // (executeNode's updateRuntimeAfterSuccess only writes legacy compat fields)
        if (outcome.success && outcome.result) {
          runtimeManager.update(blockId, {
            state: 'completed',
            output: outcome.result.payload as Record<string, unknown>,
            executedByDid: actorDid,
            executedAt: Date.now(),
          });
        } else if (!outcome.success) {
          runtimeManager.update(blockId, {
            state: 'failed',
            error: {
              message: outcome.error ?? 'Unknown error',
              at: Date.now(),
            },
          });
        }

        // Include the final runtime state so the agent doesn't need a separate read
        const finalRuntime = runtimeManager.get(blockId);

        return JSON.stringify({
          success: outcome.success,
          blockId,
          actionType,
          stage: outcome.stage,
          message: outcome.success
            ? `Action ${actionType} completed successfully`
            : `Action ${actionType} failed at stage: ${outcome.stage}`,
          ...(outcome.error && { error: outcome.error }),
          ...(outcome.result && { result: outcome.result }),
          runtimeState: finalRuntime,
        });
      } catch (error) {
        Logger.error('Error executing action:', error);
        return JSON.stringify({
          success: false,
          blockId,
          error: error instanceof Error ? error.message : String(error),
        });
      } finally {
        await providerManager.dispose();
      }
    },
    {
      name: 'execute_action',
      description: `Executes an action block through the flow engine pipeline.

**Flow engine gates:** activation → authorization → execution → runtime state update

**Supported actions:** http.request, email.send, notification.push, human.checkbox.set, form.submit, protocol.select

**Usage:**
- Pass the blockId of an action block (a block with an \`actionType\` property)
- Optionally provide inputOverrides to override/supplement the block's stored inputs
- The tool resolves \`{{blockId.prop}}\` references in inputs automatically
- Returns the execution outcome including success/failure, stage reached, and result data

**Example:**
\`\`\`json
{"blockId": "550e8400-e29b-41d4-a716-446655440000"}
\`\`\`

**With input overrides:**
\`\`\`json
{"blockId": "550e8400-e29b-41d4-a716-446655440000", "inputOverrides": {"url": "https://api.example.com/data"}}
\`\`\`

**Returns:**
\`\`\`json
{
  "success": true,
  "stage": "execution",
  "result": {"status": 200, "data": {...}},
  "blockId": "...",
  "actionType": "http.request"
}
\`\`\``,
      schema: z.object({
        blockId: z
          .string()
          .describe(
            'The exact ID of the action block to execute (must have actionType property)',
          ),
        inputOverrides: z
          .record(z.any(), z.any())
          .optional()
          .default({})
          .describe(
            'Optional: override or supplement the block\'s stored inputs. Example: {"url": "https://..."}',
          ),
      }),
    },
  );

  // ============================================================================
  // Tool 15: Find and Replace
  // ============================================================================

  const findAndReplaceTool = tool(
    async ({
      searchText,
      replaceText,
      caseSensitive = true,
      replaceAll = true,
    }) => {
      Logger.log(
        `🔄 find_and_replace tool invoked: "${searchText}" → "${replaceText}"`,
      );

      const isInRoom = await checkIfInRoomAndJoinPublicRoom(
        matrixClient,
        roomId,
      );
      if (!isInRoom) {
        return JSON.stringify({
          success: false,
          error: `The AI Agent is not in the room ${roomId}, please invite companion to the room. companion user id: ${matrixClient.getUserId()}`,
        });
      }

      const providerManager = new MatrixProviderManager(matrixClient, config);

      try {
        const { doc } = await providerManager.init();

        // Try the original search text first
        let result = findAndReplaceInDoc(doc, {
          searchText,
          replaceText,
          caseSensitive,
          replaceAll,
          docName: 'document',
        });

        // If no matches, try the emoji-normalised form (shortcode → emoji or emoji → shortcode)
        if (!result.success && textContainsEmoji(searchText)) {
          const emojified = emojify(searchText);
          const unemojified = unemojify(searchText);
          const altSearch = emojified !== searchText ? emojified : unemojified;

          if (altSearch !== searchText) {
            result = findAndReplaceInDoc(doc, {
              searchText: altSearch,
              replaceText,
              caseSensitive,
              replaceAll,
              docName: 'document',
            });
          }
        }

        return JSON.stringify({
          success: result.success,
          message: result.success
            ? `Replaced ${result.replacementCount} occurrence(s) across ${result.affectedBlockIds.length} block(s)`
            : `No occurrences of "${searchText}" found`,
          replacementCount: result.replacementCount,
          affectedBlockIds: result.affectedBlockIds,
        });
      } catch (error) {
        Logger.error('Error in find and replace:', error);
        return JSON.stringify({
          success: false,
          error: error instanceof Error ? error.message : String(error),
        });
      } finally {
        await providerManager.dispose();
      }
    },
    {
      name: 'find_and_replace',
      description: `Finds and replaces text across all blocks in the document. All replacements happen atomically in a single transaction.

**Examples:**
- Replace all: \`{"searchText": "old text", "replaceText": "new text"}\`
- Case-insensitive: \`{"searchText": "OLD", "replaceText": "new", "caseSensitive": false}\`
- Replace first only: \`{"searchText": "duplicate", "replaceText": "unique", "replaceAll": false}\`

**Returns:** Count of replacements and IDs of affected blocks.`,
      schema: z.object({
        searchText: z.string().describe('The text to search for'),
        replaceText: z.string().describe('The text to replace matches with'),
        caseSensitive: z
          .boolean()
          .optional()
          .default(true)
          .describe('Whether the search is case-sensitive (default: true)'),
        replaceAll: z
          .boolean()
          .optional()
          .default(true)
          .describe(
            'Whether to replace all occurrences or just the first (default: true)',
          ),
      }),
    },
  );

  // ============================================================================
  // Tool 16: Move Block
  // ============================================================================

  const moveBlockTool = tool(
    async ({ blockId, referenceBlockId, placement }) => {
      Logger.log(
        `↕️ move_block tool invoked: move ${blockId} ${placement} ${referenceBlockId}`,
      );

      const isInRoom = await checkIfInRoomAndJoinPublicRoom(
        matrixClient,
        roomId,
      );
      if (!isInRoom) {
        return JSON.stringify({
          success: false,
          error: `The AI Agent is not in the room ${roomId}, please invite companion to the room. companion user id: ${matrixClient.getUserId()}`,
        });
      }

      const providerManager = new MatrixProviderManager(matrixClient, config);

      try {
        const { doc } = await providerManager.init();

        const snapshot = moveBlock(doc, {
          blockId,
          referenceBlockId,
          placement,
          docName: 'document',
        });

        const movedBlock = getBlockDetail(doc, snapshot.id, true);
        const simplified = movedBlock
          ? simplifyBlockForAgent(movedBlock)
          : null;

        // Get new position
        const fragment = doc.getXmlFragment('document');
        const allBlocks = collectAllBlocks(fragment);
        const newPosition = allBlocks.findIndex((b) => b.id === blockId);

        return JSON.stringify({
          success: true,
          blockId,
          blockType: simplified?.type,
          newPosition: newPosition >= 0 ? newPosition : undefined,
          message: `Moved ${simplified?.type || 'block'} ${placement} block ${referenceBlockId}`,
          block: simplified || snapshot,
        });
      } catch (error) {
        Logger.error('Error moving block:', error);
        return JSON.stringify({
          success: false,
          blockId,
          error: error instanceof Error ? error.message : String(error),
        });
      } finally {
        await providerManager.dispose();
      }
    },
    {
      name: 'move_block',
      description: `Moves a block to a new position relative to another block. Preserves block ID, content, and runtime state.

**Usage:**
1. Call \`list_blocks\` to get block IDs
2. Specify the block to move and the reference block

**Example:**
\`{"blockId": "uuid-to-move", "referenceBlockId": "uuid-target", "placement": "before"}\``,
      schema: z.object({
        blockId: z.string().describe('The ID of the block to move'),
        referenceBlockId: z
          .string()
          .describe('The ID of the block to position relative to'),
        placement: z
          .enum(['before', 'after'])
          .describe(
            'Place the moved block "before" or "after" the reference block',
          ),
      }),
    },
  );

  // ============================================================================
  // Tool 17: Bulk Edit Blocks
  // ============================================================================

  const bulkEditBlocksTool = tool(
    async ({ edits }) => {
      Logger.log(
        `📦 bulk_edit_blocks tool invoked for ${edits.length} edit(s)`,
      );

      const isInRoom = await checkIfInRoomAndJoinPublicRoom(
        matrixClient,
        roomId,
      );
      if (!isInRoom) {
        return JSON.stringify({
          success: false,
          error: `The AI Agent is not in the room ${roomId}, please invite companion to the room. companion user id: ${matrixClient.getUserId()}`,
        });
      }

      const providerManager = new MatrixProviderManager(matrixClient, config);

      try {
        const { doc } = await providerManager.init();

        const results: Array<{
          blockId: string;
          success: boolean;
          updatedFields: string[];
          error?: string;
        }> = [];

        doc.transact(() => {
          for (const edit of edits) {
            try {
              // Apply property updates
              if (
                edit.updates &&
                Object.keys(edit.updates as Record<string, unknown>).length > 0
              ) {
                const attributes = {
                  props: edit.updates as Record<string, unknown>,
                };
                editBlock(doc, {
                  blockId: edit.blockId,
                  attributes,
                  docName: 'document',
                });
              }

              // Apply text update
              if (typeof edit.text === 'string') {
                editBlock(doc, {
                  blockId: edit.blockId,
                  text: edit.text,
                  docName: 'document',
                });
              }

              // Apply runtime updates
              if (
                edit.runtimeUpdates &&
                Object.keys(edit.runtimeUpdates as Record<string, unknown>)
                  .length > 0
              ) {
                updateRuntimeState(
                  doc,
                  edit.blockId,
                  edit.runtimeUpdates as Record<string, unknown>,
                );
              }

              // Track what was updated per edit
              const updatedFields: string[] = [];
              if (edit.updates)
                updatedFields.push(
                  ...Object.keys(edit.updates as Record<string, unknown>),
                );
              if (typeof edit.text === 'string') updatedFields.push('text');
              if (edit.runtimeUpdates)
                updatedFields.push(
                  ...Object.keys(
                    edit.runtimeUpdates as Record<string, unknown>,
                  ).map((k) => `runtime.${k}`),
                );

              results.push({
                blockId: edit.blockId,
                success: true,
                updatedFields,
              });
            } catch (error) {
              results.push({
                blockId: edit.blockId,
                success: false,
                updatedFields: [],
                error: error instanceof Error ? error.message : String(error),
              });
            }
          }
        }, 'blocknote-crdt-playground');

        const successCount = results.filter((r) => r.success).length;
        const failCount = results.filter((r) => !r.success).length;

        return JSON.stringify({
          success: failCount === 0,
          message: `${successCount}/${edits.length} edit(s) succeeded${failCount > 0 ? `, ${failCount} failed` : ''}`,
          totalEdits: edits.length,
          successCount,
          failCount,
          results,
        });
      } catch (error) {
        Logger.error('Error in bulk edit:', error);
        return JSON.stringify({
          success: false,
          error: error instanceof Error ? error.message : String(error),
        });
      } finally {
        await providerManager.dispose();
      }
    },
    {
      name: 'bulk_edit_blocks',
      description: `Edits multiple blocks in a single atomic transaction. Much more efficient than calling edit_block multiple times — uses one provider init/dispose cycle and one Y.js transaction.

**Usage:**
\`\`\`json
{
  "edits": [
    {"blockId": "uuid-1", "updates": {"status": "open"}},
    {"blockId": "uuid-2", "text": "Updated text"},
    {"blockId": "uuid-3", "updates": {"title": "New"}, "runtimeUpdates": {"state": "completed"}}
  ]
}
\`\`\`

**Features:**
- Single transaction for all edits (atomic)
- Partial success allowed — individual failures don't block other edits
- Each edit can include: \`updates\` (properties), \`text\`, \`runtimeUpdates\`

**Returns:** Per-edit results with success/failure status.`,
      schema: z.object({
        edits: z
          .array(
            z.object({
              blockId: z.string().describe('The ID of the block to edit'),
              updates: z
                .record(z.any(), z.any())
                .optional()
                .describe('Property updates as key-value pairs'),
              text: z
                .string()
                .optional()
                .describe('New text content for the block'),
              runtimeUpdates: z
                .record(z.any(), z.any())
                .optional()
                .describe('Runtime state updates to merge'),
            }),
          )
          .describe('Array of block edits to apply'),
      }),
    },
  );

  // ============================================================================
  // Return tools based on mode
  // ============================================================================

  if (readOnly) {
    return {
      listBlocksTool,
      readBlockByIdTool,
      searchBlocksTool,
      readFlowContextTool,
      readFlowStatusTool,
      readBlockHistoryTool,
      readPermissionsTool,
      readSurveyTool,
      validateSurveyAnswersTool,
    };
  }

  return {
    listBlocksTool,
    editBlockTool,
    createBlockTool,
    deleteBlockTool,
    readBlockByIdTool,
    searchBlocksTool,
    readFlowContextTool,
    readFlowStatusTool,
    readBlockHistoryTool,
    readPermissionsTool,
    readSurveyTool,
    fillSurveyAnswersTool,
    validateSurveyAnswersTool,
    executeActionTool,
    findAndReplaceTool,
    moveBlockTool,
    bulkEditBlocksTool,
  };
};

/**
 * Returns whether the companion can access `roomId`.
 *
 * The editor MatrixClient runs in polling-only mode (no `startClient()`/sync),
 * so its local store (`getRoom`/`getMember`) is never populated and cannot be
 * trusted to report membership — it always looks like the companion is in no
 * rooms. Membership is therefore determined from the server:
 *
 * - Public rooms are readable without joining → allowed.
 * - Otherwise read the companion's own `m.room.member` state; `join` means it
 *   already has access.
 * - Failing that, attempt an (idempotent) join. Already-joined succeeds; a
 *   genuine lack of invite to a private room throws → the companion truly can't
 *   access the room.
 */
const checkIfInRoomAndJoinPublicRoom = async (
  matrixClient: MatrixClient,
  roomId: string,
): Promise<boolean> => {
  const selfUserId = matrixClient.getUserId() ?? '';

  let joinRule: string | undefined;
  try {
    const joinRuleEvent = await matrixClient.getStateEvent(
      roomId,
      'm.room.join_rules',
      '',
    );
    joinRule = joinRuleEvent?.join_rule;
  } catch {
    // Can't read state of a private room we're not in — fall through to join.
  }

  if (joinRule === 'public') return true;

  try {
    const memberEvent = await matrixClient.getStateEvent(
      roomId,
      'm.room.member',
      selfUserId,
    );
    if (memberEvent?.membership === 'join') return true;
  } catch {
    // Not a member / can't read member state — fall through to join.
  }

  try {
    await matrixClient.joinRoom(roomId);
    Logger.log(`Joined room ${roomId}`);
    return true;
  } catch (error) {
    Logger.warn(`Companion could not join room ${roomId}: ${error}`);
    return false;
  }
};

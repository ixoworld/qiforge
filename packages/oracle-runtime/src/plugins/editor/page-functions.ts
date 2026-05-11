/**
 * Page management functions — reusable from services, API routes, and tests.
 */

import { ServerBlockNoteEditor } from '@blocknote/server-util';
import { Logger } from '@nestjs/common';
import type { MatrixClient } from 'matrix-js-sdk';
import { Preset, Visibility } from 'matrix-js-sdk';

import {
  collectAllBlocks,
  readFlowMetadata,
  simplifyBlockForAgent,
} from './blocknote-helper.js';
import {
  MatrixProviderManager,
  type AppConfig,
  type MatrixConfig,
  type ProviderConfig,
} from './provider.js';

/**
 * Converts a Matrix user ID in hyphen-delimited DID form (`@did-ixo-…`)
 * to the canonical colon-delimited DID (`did:ixo:…`).
 */
function normalizeDid(input: string): string {
  const username = input.split(':')[0] ?? '';
  const parts = username.split('-');
  if (parts.length < 3 || parts[0] !== '@did') {
    throw new Error(`Invalid DID format: ${input}`);
  }
  const namespace = parts[1];
  const identifier = parts.slice(2).join('-');
  return `did:${namespace}:${identifier}`;
}

const logger = new Logger('PageFunctions');

// Singleton — reuse across calls (stateless, thread-safe)
const serverEditor = ServerBlockNoteEditor.create();

// ── Types ─────────────────────────────────────────────────────────────

export interface CreatePageParams {
  matrixClient: MatrixClient;
  matrixConfig: Omit<MatrixConfig, 'room'>;
  providerConfig: ProviderConfig;
  title: string;
  topic?: string;
  content?: string;
  parentSpaceId?: string;
  inviteUserIds?: string[];
}

export interface CreatePageResult {
  roomId: string;
  alias: string;
  title: string;
  ownerDid: string;
  createdAt: string;
  blockCount: number;
}

export interface ReadPageParams {
  matrixClient: MatrixClient;
  matrixConfig: Omit<MatrixConfig, 'room'>;
  providerConfig: ProviderConfig;
  roomId: string;
}

export interface ReadPageResult {
  roomId: string;
  metadata: Record<string, unknown>;
  blocks: Array<{
    id: string;
    type: string;
    properties: Record<string, unknown>;
    text?: string;
  }>;
  blockCount: number;
}

// ── Helpers ───────────────────────────────────────────────────────────

function validateMatrixRoomId(roomId: string): void {
  if (!/^!.+:.+$/.test(roomId)) {
    throw new Error(
      `Invalid Matrix room ID '${roomId}'. Room IDs must start with '!' followed by the room identifier and homeserver (e.g., '!abc123:matrix.org').`,
    );
  }
}

function createPageAlias(): string {
  return `page-${Date.now()}`;
}

function buildPageAppConfig(
  matrixConfig: Omit<MatrixConfig, 'room'>,
  providerConfig: ProviderConfig,
  roomId: string,
): AppConfig {
  return {
    matrix: {
      ...matrixConfig,
      room: { type: 'id', value: roomId },
    },
    provider: providerConfig,
    blocknote: { mutableAttributeKeys: [] },
  };
}

function extractHomeserver(baseUrl: string): string {
  return baseUrl.replace(/^https?:\/\//, '');
}

// ── Core Functions ────────────────────────────────────────────────────

/**
 * Create a new page.
 *
 * - Generates a FE-compatible `page-{timestamp}` alias
 * - Invites specified users and grants them power level 50
 * - Accepts optional markdown `content` which is parsed into BlockNote blocks
 */
export async function createPage(
  params: CreatePageParams,
): Promise<CreatePageResult> {
  const {
    matrixClient,
    matrixConfig,
    providerConfig,
    title,
    topic,
    content,
    parentSpaceId,
    inviteUserIds,
  } = params;

  const alias = createPageAlias();
  const creatorId = matrixClient.getUserId()!;
  const homeserver = extractHomeserver(matrixConfig.baseUrl);

  // Build power levels — creator gets 100, invited users get 50
  const users: Record<string, number> = { [creatorId]: 100 };
  if (inviteUserIds) {
    for (const userId of inviteUserIds) {
      users[userId] = 50;
    }
  }

  // Build initial state events (matching FE pattern)
  const initialState: Array<{
    type: string;
    state_key?: string;
    content: Record<string, unknown>;
  }> = [
    {
      type: 'm.room.history_visibility',
      state_key: '',
      content: { history_visibility: 'shared' },
    },
    {
      type: 'm.room.guest_access',
      state_key: '',
      content: { guest_access: 'forbidden' },
    },
  ];

  if (parentSpaceId) {
    initialState.push({
      type: 'm.space.parent',
      state_key: parentSpaceId,
      content: { via: [homeserver], canonical: true },
    });
  }

  logger.log(`Creating page room with alias: ${alias}`);

  const createRoomResponse = await matrixClient.createRoom({
    room_alias_name: alias,
    name: title,
    topic: topic ?? 'Page',
    visibility: Visibility.Private,
    preset: Preset.PrivateChat,
    invite: inviteUserIds ?? [],
    initial_state: initialState,
    power_level_content_override: {
      events_default: 50,
      state_default: 50,
      users_default: 0,
      users,
      events: {
        'com.yjs.webrtc.announce': 0,
        'com.yjs.webrtc.signal': 0,
      },
    },
  });

  const roomId = createRoomResponse.room_id;
  logger.log(`Page room created: ${roomId}`);

  // If parent space exists, add the room as a child of the space
  if (parentSpaceId) {
    try {
      await matrixClient.sendStateEvent(
        parentSpaceId,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        'm.space.child' as any,
        { via: [homeserver] },
        roomId,
      );
    } catch (error) {
      logger.warn(
        `Failed to add page as child of space ${parentSpaceId}: ${error}`,
      );
    }
  }

  // Parse markdown content into BlockNote blocks if provided
  const blocks = content
    ? await serverEditor.tryParseMarkdownToBlocks(content)
    : [];

  // Initialize Y.Doc with metadata and blocks
  const appConfig = buildPageAppConfig(matrixConfig, providerConfig, roomId);
  const providerManager = new MatrixProviderManager(matrixClient, appConfig);

  const createdAt = new Date().toISOString();
  const ownerDid = normalizeDid(creatorId);

  try {
    const { doc } = await providerManager.init();

    // Set page metadata
    doc.transact(() => {
      const root = doc.getMap('root');
      root.set('@context', 'https://ixo.world/page/0.1');
      root.set('createdAt', createdAt);
      root.set('ownerDid', ownerDid);
      doc.getText('title').insert(0, title);
    });

    // Write parsed blocks into the document fragment
    if (blocks.length > 0) {
      const fragment = doc.getXmlFragment('document');
      serverEditor.blocksToYXmlFragment(blocks, fragment);
    }
  } finally {
    await providerManager.dispose();
  }

  logger.log(`Page initialized: ${title} (${blocks.length} blocks)`);

  return {
    roomId,
    alias,
    title,
    ownerDid,
    createdAt,
    blockCount: blocks.length,
  };
}

// ── Update Page ────────────────────────────────────────────────────────

export interface UpdatePageParams {
  matrixClient: MatrixClient;
  matrixConfig: Omit<MatrixConfig, 'room'>;
  providerConfig: ProviderConfig;
  roomId: string;
  title?: string;
  topic?: string;
  content?: string;
  appendContent?: string;
}

export interface PageDiff {
  title?: { old: string; new: string };
  topic?: { old: string; new: string };
  content?: { old: string; new: string };
}

export interface UpdatePageResult {
  roomId: string;
  title: string;
  ownerDid: string;
  updatedAt: string;
  updatedFields: string[];
  blockCount: number;
  diff: PageDiff;
}

/**
 * Update an existing page — title, topic, content, or append content.
 *
 * - `title` updates the Y.Text 'title' shared type
 * - `topic` updates the Matrix room topic
 * - `content` replaces all blocks with parsed markdown
 * - `appendContent` appends parsed markdown blocks to existing content
 *
 * Returns the page title, ownerDid, timestamp, and a diff object showing
 * old vs new values for each changed field (for GitHub-style change rendering).
 */
export async function updatePage(
  params: UpdatePageParams,
): Promise<UpdatePageResult> {
  const {
    matrixClient,
    matrixConfig,
    providerConfig,
    roomId,
    title,
    topic,
    content,
    appendContent,
  } = params;

  validateMatrixRoomId(roomId);

  const updatedFields: string[] = [];
  const diff: PageDiff = {};

  // Ensure the client is in the room (same pattern as readPage)
  const isInRoom =
    matrixClient.getRoom(roomId)?.getMember(matrixClient.getUserId() ?? '')
      ?.membership === 'join';

  if (!isInRoom) {
    try {
      await matrixClient.joinRoom(roomId);
      logger.log(`Joined room ${roomId}`);
    } catch (error) {
      logger.warn(`Could not join room ${roomId}: ${error}`);
    }
  }

  // Capture old topic before updating
  if (topic !== undefined) {
    const room = matrixClient.getRoom(roomId);
    const oldTopic =
      room?.currentState?.getStateEvents('m.room.topic', '')?.getContent()
        ?.topic ?? '';

    try {
      await matrixClient.setRoomTopic(roomId, topic);
      updatedFields.push('topic');
      diff.topic = { old: oldTopic as string, new: topic };
    } catch (error) {
      logger.warn(`Failed to update room topic for ${roomId}: ${error}`);
    }
  }

  // Parse content if provided
  const contentBlocks = content
    ? await serverEditor.tryParseMarkdownToBlocks(content)
    : [];
  const appendBlocks = appendContent
    ? await serverEditor.tryParseMarkdownToBlocks(appendContent)
    : [];

  const appConfig = buildPageAppConfig(matrixConfig, providerConfig, roomId);
  const providerManager = new MatrixProviderManager(matrixClient, appConfig);

  let blockCount = 0;
  let currentTitle = '';
  let ownerDid = '';

  try {
    const { doc } = await providerManager.init();

    // Read metadata before mutations
    const metadata = readFlowMetadata(doc);
    ownerDid = (metadata.ownerDid as string) ?? '';
    const oldTitle = doc.getText('title').toString();

    // Snapshot old content as markdown (for diff) before any mutations
    let oldContentMd = '';
    if (content !== undefined || appendContent !== undefined) {
      const oldBlocks = serverEditor.yXmlFragmentToBlocks(
        doc.getXmlFragment('document'),
      );
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      oldContentMd = await serverEditor.blocksToMarkdownLossy(oldBlocks as any);
    }

    doc.transact(() => {
      // Update title
      if (title !== undefined) {
        const titleText = doc.getText('title');
        titleText.delete(0, titleText.length);
        titleText.insert(0, title);
        updatedFields.push('title');
        diff.title = { old: oldTitle, new: title };
      }

      // Replace all content
      if (content !== undefined && contentBlocks.length > 0) {
        const fragment = doc.getXmlFragment('document');
        // Clear existing content
        while (fragment.length > 0) {
          fragment.delete(0, 1);
        }
        serverEditor.blocksToYXmlFragment(contentBlocks, fragment);
        updatedFields.push('content');
      }

      // Append content
      if (appendContent !== undefined && appendBlocks.length > 0) {
        const fragment = doc.getXmlFragment('document');
        serverEditor.blocksToYXmlFragment(appendBlocks, fragment);
        updatedFields.push('appendContent');
      }
    });

    // Snapshot new content as markdown (for diff) after mutations
    if (content !== undefined || appendContent !== undefined) {
      const newBlocks = serverEditor.yXmlFragmentToBlocks(
        doc.getXmlFragment('document'),
      );

      const newContentMd = await serverEditor.blocksToMarkdownLossy(
        newBlocks as any,
      );
      diff.content = { old: oldContentMd, new: newContentMd };
    }

    // Read final title
    currentTitle = doc.getText('title').toString();

    // Count final blocks
    const fragment = doc.getXmlFragment('document');
    const allBlocks = collectAllBlocks(fragment);
    blockCount = allBlocks.length;
  } finally {
    await providerManager.dispose();
  }

  logger.log(`Page updated: ${roomId} (fields: ${updatedFields.join(', ')})`);

  return {
    roomId,
    title: currentTitle,
    ownerDid,
    updatedAt: new Date().toISOString(),
    updatedFields,
    blockCount,
    diff,
  };
}

/**
 * Read an existing page by room ID.
 *
 * Returns metadata (title, owner, creation date) and all blocks.
 */
export async function readPage(
  params: ReadPageParams,
): Promise<ReadPageResult> {
  const { matrixClient, matrixConfig, providerConfig, roomId } = params;

  validateMatrixRoomId(roomId);

  // Ensure the client is in the room
  const isInRoom =
    matrixClient.getRoom(roomId)?.getMember(matrixClient.getUserId() ?? '')
      ?.membership === 'join';

  if (!isInRoom) {
    try {
      await matrixClient.joinRoom(roomId);
      logger.log(`Joined room ${roomId}`);
    } catch (error) {
      logger.warn(`Could not join room ${roomId}: ${error}`);
    }
  }

  const appConfig = buildPageAppConfig(matrixConfig, providerConfig, roomId);
  const providerManager = new MatrixProviderManager(matrixClient, appConfig);

  try {
    const { doc } = await providerManager.init();

    const metadata = readFlowMetadata(doc);
    const rawBlocks = collectAllBlocks(doc.getXmlFragment('document'));
    const simplifiedBlocks = rawBlocks.map((b) => simplifyBlockForAgent(b));

    return {
      roomId,
      metadata,
      blocks: simplifiedBlocks,
      blockCount: simplifiedBlocks.length,
    };
  } finally {
    await providerManager.dispose();
  }
}

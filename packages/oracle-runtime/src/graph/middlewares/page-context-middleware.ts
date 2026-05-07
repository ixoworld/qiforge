import { type AgentMiddleware, createMiddleware } from 'langchain';
import { z } from 'zod';
import type { Logger } from '../../plugin-api/types.js';

const NOOP_LOGGER: Logger = {
  log: () => undefined,
  warn: () => undefined,
  error: () => undefined,
};

export interface PageContextMiddlewareOptions {
  /**
   * Resolves a human-readable page title for the given editor room ID.
   * Returns `undefined` if the room has no title or the lookup fails — the
   * middleware will fall back to using the bare room ID.
   *
   * In the IXO oracle this is backed by a Matrix `m.room.name` state event;
   * pass any equivalent lookup that fits your storage.
   */
  getRoomTitle: (roomId: string) => Promise<string | undefined>;
  /** Optional logger; defaults to a no-op. */
  logger?: Logger;
}

function formatLabel(title: string | undefined, roomId: string): string {
  return title ? `"${title}" (${roomId})` : roomId;
}

/**
 * Injects a short "Active Page Context" block into the system message when
 * the agent is editing a page (`state.editorRoomId` is set). When the user
 * switches pages mid-conversation the block flags it explicitly so the
 * agent re-reads the current page before editing.
 */
export const createPageContextMiddleware = (
  options: PageContextMiddlewareOptions,
): AgentMiddleware => {
  const logger = options.logger ?? NOOP_LOGGER;
  const { getRoomTitle } = options;

  return createMiddleware({
    name: 'PageContextMiddleware',
    stateSchema: z.object({
      editorRoomId: z.string().optional(),
      _previousEditorRoomId: z.string().optional(),
    }),
    wrapModelCall: async (request, handler) => {
      const currentEditorRoomId = request.state.editorRoomId;
      if (!currentEditorRoomId) {
        return handler(request);
      }

      const currentTitle = await getRoomTitle(currentEditorRoomId);
      const currentLabel = formatLabel(currentTitle, currentEditorRoomId);
      const previousEditorRoomId = request.state._previousEditorRoomId;

      let pageContext: string;
      if (
        previousEditorRoomId &&
        previousEditorRoomId !== currentEditorRoomId
      ) {
        logger.log(
          `[PageContextMiddleware] Page switch: ${previousEditorRoomId} → ${currentEditorRoomId}`,
        );
        const previousTitle = await getRoomTitle(previousEditorRoomId);
        const previousLabel = formatLabel(previousTitle, previousEditorRoomId);

        pageContext =
          `\n\n## 📄 Active Page Context\n\n` +
          `The user has switched pages. Current page: ${currentLabel}. ` +
          `Previous page: ${previousLabel}. ` +
          `Previous page context in conversation history may be stale. ` +
          `Always favour the current active page. ` +
          `Before making any edits, use read_page to confirm the current page content ` +
          `and verify it matches what the user is asking you to work on. ` +
          `If the content differs from what was discussed, confirm with the user before editing.`;
      } else {
        pageContext =
          `\n\n## 📄 Active Page Context\n\n` +
          `Current active page: ${currentLabel}. Always work with this page.`;
      }

      return handler({
        ...request,
        systemMessage: request.systemMessage.concat(pageContext),
      });
    },
    afterModel: (state) => {
      if (
        state.editorRoomId &&
        state.editorRoomId !== state._previousEditorRoomId
      ) {
        return { _previousEditorRoomId: state.editorRoomId };
      }
      return;
    },
  });
};

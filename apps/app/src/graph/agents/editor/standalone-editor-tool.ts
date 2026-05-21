/**
 * Standalone editor tool — allows the main agent to open any page by room ID
 * and run a full editing session as a subagent, without needing a pre-set
 * editorRoomId.
 */

import { Logger } from '@nestjs/common';
import { DynamicStructuredTool, type StructuredTool } from 'langchain';
import { z } from 'zod';

import type { BlobStoreService } from 'src/blob-store/blob-store.service';
import type { UcanService } from 'src/ucan/ucan.service';
import { createSubagentAsTool, type AgentSpec } from '../subagent-as-tool';
import { createEditorAgent } from './editor-agent';
import { logEditorSessionToMemory, type PageMemoryAuth } from './page-memory';

export interface CreateStandaloneEditorToolParams {
  /** Matrix user ID for page invitations */
  userMatrixId?: string;
  /** Matrix space ID to nest new pages under */
  spaceId: string;
  /** Auth context for logging operations to Memory Engine */
  memoryAuth?: PageMemoryAuth;
  /** Optional transform to inject extra context (e.g. time) into the agent spec */
  transformSpec?: (spec: AgentSpec) => AgentSpec;
  /** UCAN service — when provided, the spawned editor exposes `mint_invocation`. */
  ucanService?: UcanService;
  /** Blob store — propagated so the spawned editor's `mint_invocation` can return a blobId. */
  blobStore?: BlobStoreService;
  userDid: string;
  sessionId: string;
}

/**
 * Creates a `call_editor_agent` tool that accepts `room_id` + `task`.
 * Each invocation spins up an ephemeral editor agent with full BlockNote +
 * page tools for the given room, runs the task, and returns the result.
 */
export function createStandaloneEditorTool({
  userMatrixId,
  spaceId,
  memoryAuth,
  transformSpec = (s) => s,
  ucanService,
  blobStore,
  userDid,
  sessionId,
}: CreateStandaloneEditorToolParams): StructuredTool {
  return new DynamicStructuredTool({
    name: 'call_editor_agent',
    description: `Call Editor Agent as subAgent for doing blocknote editor tasks and reading or mutating Pages when givin a matrix room id`,
    schema: z.object({
      room_id: z
        .string()
        .regex(
          /^!.+:.+$/,
          'Room ID must start with "!" (e.g., "!abc123:matrix.org")',
        )
        .describe(
          'The Matrix room ID of the page (e.g., "!oeGkcJIKNpeSiaGHVE:devmx.ixo.earth"). Must start with "!".',
        ),
      task: z
        .string()
        .describe(
          'A detailed, self-contained editing instruction. The editor agent has NO conversation context — ' +
            'this string is ALL it receives. Include: explicit objective, block IDs, property names, exact values, ' +
            'and expected outcome. Do NOT include the room ID here — it goes in room_id.',
        ),
    }),
    func: async (
      { room_id, task }: { room_id: string; task: string },
      _,
      config,
    ) => {
      try {
        const editorSpec = await createEditorAgent({
          room: room_id,
          mode: 'edit',
          userMatrixId,
          spaceId,
          memoryAuth,
          ucanService,
          blobStore,
          userDid,
          sessionId,
        });

        const spec = transformSpec(editorSpec);

        const subagentTool = createSubagentAsTool(spec, {
          forwardTools: [
            'create_page',
            'update_page',
            'edit_block',
            'create_block',
            'mint_invocation',
          ],
          onComplete: memoryAuth
            ? (messages) =>
                logEditorSessionToMemory(memoryAuth, messages, room_id, task)
            : undefined,
        });

        return subagentTool.invoke({ task }, config);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        Logger.error(
          `[StandaloneEditorTool] Failed for room ${room_id}: ${message}`,
        );
        return `Error opening editor for room ${room_id}: ${message}`;
      }
    },
  });
}

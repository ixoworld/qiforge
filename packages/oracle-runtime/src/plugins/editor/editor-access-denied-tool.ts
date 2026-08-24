import { tool } from '@langchain/core/tools';
import type { StructuredTool } from 'langchain';
import { z } from 'zod';
import { EDITOR_AGENT_TOOL_NAME } from './editor-agent.js';
import { GRANT_ACCESS_TOOL } from './failures.js';
import type { EditorUnavailableReason } from './prompts.js';

// Mirrors the real sub-agent tool's schema so a model that composed a task for
// the document assistant still produces a valid call — the answer is just the
// denial.
const taskSchema = z.object({
  task: z
    .string()
    .describe('The task you intended to send to the document assistant.'),
});

export interface EditorAccessDeniedToolOptions {
  /** The document room the client reported open. */
  editorRoomId: string;
  /** Why the real document surface refused to bind. */
  reason: EditorUnavailableReason;
}

/**
 * Stand-in for `call_editor_agent` bound when a document is open but the real
 * surface refused to attach (the user is not a verified member of the room, or
 * the sub-agent build failed).
 *
 * Without it, the model is shown a document capability it cannot reach and
 * either narrates its sub-agent task as user-facing text or hunts through
 * `list_capabilities` / `load_capability` for a tool that will never appear.
 */
export function createEditorAccessDeniedTool(
  options: EditorAccessDeniedToolOptions,
): StructuredTool {
  const { editorRoomId, reason } = options;

  // Membership is resolved with the oracle's admin identity, so a failed check
  // can mean either side is missing — the user OR this oracle (the lookup is
  // forbidden and fails closed). Keep the wording unified.
  const message =
    reason === 'not-member'
      ? `Document unavailable: membership of the document's room (${editorRoomId}) could not be verified — ` +
        `either the user's account or this oracle is not a member, and BOTH must be for document access. ` +
        `Tell the user the document can't be read or edited because either they or this oracle is missing from its room; ` +
        `inviting this oracle to the document (or opening one they own) fixes it. ` +
        `If they only need write access to a document you can already read, the \`${GRANT_ACCESS_TOOL}\` browser tool is what grants it. ` +
        `Do not retry this tool.`
      : `Document unavailable: the document service failed to attach to the room (${editorRoomId}). ` +
        `Tell the user the document assistant is currently unavailable and they can retry shortly. Do not retry this tool.`;

  return tool(async () => message, {
    name: EDITOR_AGENT_TOOL_NAME,
    description:
      'Document assistant (unavailable for this request — calls return the denial reason).',
    schema: taskSchema,
  });
}

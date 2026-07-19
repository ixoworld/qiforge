import { z } from 'zod';
import type { PluginTool } from '../../plugin-api/types.js';
import { EDITOR_AGENT_TOOL_NAME } from './editor-agent.js';
import type { EditorUnavailableReason } from './prompts.js';

// Mirrors the real sub-agent tool's schema so a model that composed a task
// for the editor still produces a valid call — the answer is just the denial.
const taskSchema = z.object({
  task: z.string().describe('The task you intended to send to the editor.'),
});

export interface EditorAccessDeniedToolOptions {
  /** The page room the client reported open. */
  editorRoomId: string;
  /** Why the real editor surface refused to bind. */
  reason: EditorUnavailableReason;
}

/**
 * Stand-in for `call_editor_agent` bound when a page is open but the real
 * editor surface refused to attach (the user is not a verified member of the
 * page's room, or the sub-agent build failed).
 *
 * Without it, the model is shown an "editor" capability it cannot reach and
 * either narrates its sub-agent task as user-facing text or hunts through
 * `list_capabilities`/`load_capability` for a tool that will never appear.
 * With it, any editor call returns the denial so the model can report the
 * real reason to the user.
 */
export function createEditorAccessDeniedTool(
  options: EditorAccessDeniedToolOptions,
): PluginTool {
  const { editorRoomId, reason } = options;

  // Membership is resolved with the oracle's admin identity, so a failed
  // check can mean either side is missing — the user OR the oracle itself
  // (the lookup is forbidden and fails closed). Keep the wording unified.
  const message =
    reason === 'not-member'
      ? `Editor unavailable: membership of the page's room (${editorRoomId}) could not be verified — ` +
        `either the user's account or this oracle is not a member of it, and BOTH must be members for page access. ` +
        `Tell the user: the page can't be read or edited because either they or this oracle is missing from the page's room; ` +
        `inviting this oracle to the page (or opening a page they own) fixes it. Do not retry this tool.`
      : `Editor unavailable: the editor service failed to attach to the page's room (${editorRoomId}). ` +
        `Tell the user the page editor is currently unavailable and they can retry shortly. Do not retry this tool.`;

  return {
    name: EDITOR_AGENT_TOOL_NAME,
    description:
      'Editor Agent (unavailable for this request — calls return the denial reason).',
    schema: taskSchema,
    handler: async () => message,
  };
}

/**
 * Typed failures the content tools return as *values*, never as thrown strings.
 *
 * The agent has to be able to branch on the reason: `needs_access` means "ask
 * the user to grant access", `read_only_flow` means "describe, do not edit",
 * `prop_not_editable` means "that prop is off limits — say which".
 */

/** The Portal browser tool the user runs to give the assistant write access. */
export const GRANT_ACCESS_TOOL = 'grant_assistant_access';

export type EditorFailureCode =
  | 'needs_access'
  | 'read_only_flow'
  | 'prop_not_editable'
  | 'block_not_found'
  | 'not_a_member'
  | 'no_document'
  | 'flush_timeout'
  | 'error';

export interface EditorFailure {
  ok: false;
  code: EditorFailureCode;
  message: string;
  /** The offending prop names, for `prop_not_editable`. */
  props?: string[];
  /** The block the failure is about, when there is one. */
  blockId?: string;
  roomId?: string;
}

export function isEditorFailure(value: unknown): value is EditorFailure {
  return (
    typeof value === 'object' &&
    value !== null &&
    'ok' in value &&
    value.ok === false &&
    'code' in value
  );
}

/**
 * The assistant is in the document but cannot write to it. The user has to
 * grant access from the Portal; naming the tool is what lets the agent say
 * exactly what to do.
 */
export function needsAccess(roomId: string, detail?: string): EditorFailure {
  return {
    ok: false,
    code: 'needs_access',
    roomId,
    message:
      `This assistant does not have permission to write to this document` +
      (detail ? ` (${detail})` : '') +
      `. CALL the \`${GRANT_ACCESS_TOOL}\` browser tool yourself — do not ask ` +
      `the user to run it, and do not tell them you cannot grant yourself ` +
      `access. The tool prompts them to confirm in a dialog; if they confirm, ` +
      `retry the edit once. If it returns \`granted: false\` or a failure, ` +
      `report that plainly. Reads are unaffected.`,
  };
}

/** The document is a live flow: readable, never writable. */
export function readOnlyFlow(roomId: string, alias?: string): EditorFailure {
  return {
    ok: false,
    code: 'read_only_flow',
    roomId,
    message:
      `This document is a live flow${alias ? ` (${alias})` : ''}. Flows are ` +
      `read-only for this assistant — you can read and describe it, but edits ` +
      `must be made in the flow builder. Do not retry the write.`,
  };
}

/** One or more requested props are outside the block type's allowlist. */
export function propNotEditable(
  blockId: string,
  blockType: string,
  rejected: Array<{ prop: string; reason: string }>,
): EditorFailure {
  const detail = rejected
    .map((entry) => `'${entry.prop}' — ${entry.reason}`)
    .join('; ');
  return {
    ok: false,
    code: 'prop_not_editable',
    blockId,
    props: rejected.map((entry) => entry.prop),
    message:
      `Refused: ${detail}. Nothing was written to block ${blockId} ` +
      `(type '${blockType}'). Tell the user which property could not be ` +
      `changed and why.`,
  };
}

/** The block id is not in the document. */
export function blockNotFound(blockId: string): EditorFailure {
  return {
    ok: false,
    code: 'block_not_found',
    blockId,
    message:
      `No block with id '${blockId}' exists in this document. Call ` +
      `read_document to get current block ids — never guess or reuse an id ` +
      `from an earlier turn.`,
  };
}

/** The user is not a member of the room, so it is not one of their documents. */
export function notAMember(roomId: string): EditorFailure {
  return {
    ok: false,
    code: 'not_a_member',
    roomId,
    message:
      `The user is not a member of document room ${roomId}, so it is not one ` +
      `of their documents. Tell them they do not have access to it. Do not retry.`,
  };
}

/** The write was made locally but could not be confirmed as sent. */
export function flushTimeout(roomId: string): EditorFailure {
  return {
    ok: false,
    code: 'flush_timeout',
    roomId,
    message:
      `The edit could not be confirmed as saved within the time limit — treat ` +
      `it as NOT applied. Tell the user the document service is not responding ` +
      `and they can retry shortly. Do not claim the edit succeeded.`,
  };
}

/**
 * Nothing to act on: no document is open and the call named no `room_id`.
 * Distinct from `not_a_member` — there is no room to be a member of yet.
 */
export function noDocument(): EditorFailure {
  return {
    ok: false,
    code: 'no_document',
    message:
      'No document is open and no room_id was given. Pass the room id of the ' +
      'document to work on (find it with list_workspace_pages), or create one ' +
      'with create_page_room and pass the id it returns.',
  };
}

/** Anything unexpected. Kept distinct so the agent does not misread it as a policy refusal. */
export function editorError(message: string, roomId?: string): EditorFailure {
  return { ok: false, code: 'error', message, ...(roomId && { roomId }) };
}

/**
 * Guard prefixes prepended to the agent's instructions for `before-action`
 * work. The spec body names the gated step in its `## Requires approval`
 * section; these guards tell the agent how to behave around it in each mode.
 */

/**
 * Prepended to a scheduled `before-action` run. The agent does the work and
 * PREPARES the action, posts the draft, and the user resolves it by replying
 * in the task's room (the room is bound to this run's session).
 */
export function buildApprovalGuardedMessage(
  taskId: string,
  body: string,
): string {
  return [
    '[Scheduled task — approval required before any action]',
    `Task id: ${taskId}`,
    "You are running a scheduled task that performs an action the user must approve first. The gated action is named in the task's '## Requires approval' section below. Do all the work and PREPARE that action, then reply with the draft/result and ask the user to approve — e.g. end with \"Reply **yes** to proceed, or tell me what to change.\" Do NOT perform the gated action yet. The user will reply in this room:",
    '- A plain yes/no reply is recorded by the system automatically — on approval, perform the action and confirm what you did.',
    '- If the reply is nuanced (e.g. "fix the title, then send it"), handle it: revise and re-ask, or act on the approval — and after acting, call the `resolve_task_approval` tool with this task id and the outcome (load the tasks capability first if you don\'t see the tool).',
    '- If they decline, stop and acknowledge.',
    '',
    'Task instructions:',
    body,
  ].join('\n');
}

/**
 * Prepended when PREVIEWING a spec whose intent names a gated action. A
 * preview is a real run with live tools — without this guard, a bluntly
 * worded intent ("create the ticket") would perform the irreversible action
 * during the preview, before anything was ever scheduled or approved.
 */
export function buildPreviewGuardedMessage(body: string): string {
  return [
    '[Preview run — do NOT perform the gated action]',
    "This is a dry-run preview of a scheduled task. Do all the work and produce the draft/result exactly as a real run would, but do NOT perform the action named in the '## Requires approval' section below — no posting, sending, publishing, or creating. Output only what the user should review.",
    '',
    'Task instructions:',
    body,
  ].join('\n');
}

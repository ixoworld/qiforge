/**
 * @fileoverview What every bundled tool does to the world, in one place.
 *
 * The constitution gate can only evaluate a tool call it can classify, and a
 * tool that declares nothing is refused under strict enforcement — an unknown
 * effect is an unbounded one. This table is what makes strict enforcement
 * usable on a bundled-plugin deployment.
 *
 * ## Why a table rather than a field on each tool
 *
 * A declaration next to each `tool()` call would be the obvious home, and for
 * a fork's own plugins it is the right one — `PluginTool.effect` exists for
 * exactly that, and takes precedence over anything here.
 *
 * For the bundled set the trade runs the other way. Collected in one file, the
 * complete answer to "what can this runtime do, and to what" is auditable in a
 * single read; scattered across twenty files it is not. Reviewing a change to
 * the runtime's own authority surface is precisely the review that should not
 * require twenty diffs to reason about.
 *
 * The cost of a table is drift — a new tool that nobody adds an entry for.
 * Two things catch it: a boot warning naming every undeclared tool, and
 * `tool-effects.test.ts`, which walks the bundled plugins and fails if any
 * tool has no effect from either source. Drift is a test failure, not a
 * silent gap.
 *
 * ## How things were classified
 *
 * Against the action classes the `domain.md` format defines, and toward the
 * more restricted class whenever it was a close call. A tool wrongly filed as
 * `write` when it only reads costs an unnecessary grant; the reverse lets an
 * edit through on a read grant.
 *
 * Three worth stating outright, because they are the ones a reader will
 * question:
 *
 * - `mint_invocation` is `govern`, not `issue`. It mints a UCAN invocation
 *   against a service — that is delegating authority, which the format maps
 *   through `delegate`.
 * - `vfs_share` is `govern`, not `write`. It publishes a file so anyone with
 *   the link can read it. That changes who may access a resource, and filing
 *   it as `write` would let a plain write grant on the filesystem authorise
 *   publishing to the world.
 * - `resolve_task_approval` is `evaluate`, not `write`. It records a decision
 *   about a draft, and decisions are evaluations whatever they are stored as.
 */
import type { RuntimeContext, ToolEffect } from '../plugin-api/types.js';
import type { PluginTool } from '../plugin-api/types.js';

/** Reads a string field from tool arguments, for building an object identifier. */
function arg(args: unknown, key: string): string | undefined {
  if (typeof args !== 'object' || args === null) return undefined;
  const value = (args as Record<string, unknown>)[key];
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

/** The editor and blocknote tools act on the room the session is editing. */
const editorObject = (_args: unknown, ctx: RuntimeContext): string =>
  `ixo:editor/${ctx.session.roomId ?? 'unscoped'}`;

/** A VFS path when the call names one, otherwise the filesystem as a whole. */
const vfsObject = (args: unknown): string => {
  const path = arg(args, 'path') ?? arg(args, 'source') ?? arg(args, 'pattern');
  return path ? `ixo:vfs${path.startsWith('/') ? '' : '/'}${path}` : 'ixo:vfs';
};

const flowObject = (args: unknown): string => {
  const id = arg(args, 'flowId') ?? arg(args, 'templateId');
  return id ? `ixo:flow/${id}` : 'ixo:flow';
};

const taskObject = (args: unknown): string => {
  const id = arg(args, 'taskId') ?? arg(args, 'id');
  return id ? `ixo:task/${id}` : 'ixo:tasks';
};

/** Shorthand for the common case: a class, and a fixed object namespace. */
function on(
  type: ToolEffect['type'],
  action: string,
  object: string | ToolEffect['object'],
): ToolEffect {
  return {
    type,
    action,
    object: typeof object === 'string' ? () => object : object,
  };
}

/**
 * Effects for every tool the bundled plugins and meta-tools contribute.
 *
 * Keyed by tool name because that is what the gate has at call time.
 */
export const BUNDLED_TOOL_EFFECTS: ReadonlyMap<string, ToolEffect> = new Map<
  string,
  ToolEffect
>([
  // ── Meta-tools ───────────────────────────────────────────────────────────
  // Discovery only. Loading a capability exposes tools to the model; it does
  // not authorise any of them, because each is gated on its own call.
  ['list_capabilities', on('read', 'list_capabilities', 'ixo:runtime/plugins')],
  ['load_capability', on('read', 'load_capability', 'ixo:runtime/plugins')],

  // ── domain-indexer ───────────────────────────────────────────────────────
  [
    'domain_indexer_search',
    on('read', 'domain_indexer_search', 'ixo:domain-index'),
  ],
  ['get_domain_card', on('read', 'get_domain_card', 'ixo:domain-index')],

  // ── skills ───────────────────────────────────────────────────────────────
  ['list_skills', on('read', 'list_skills', 'ixo:skills/registry')],
  ['search_skills', on('read', 'search_skills', 'ixo:skills/registry')],

  // ── user-preferences ─────────────────────────────────────────────────────
  [
    'set_user_preferences',
    on('write', 'set_user_preferences', 'ixo:user/preferences'),
  ],

  // ── matrix-group-chats ───────────────────────────────────────────────────
  [
    'recall_channel_memory',
    on('read', 'recall_channel_memory', 'ixo:matrix/channel-memory'),
  ],
  [
    'search_channel_memory',
    on('read', 'search_channel_memory', 'ixo:matrix/channel-memory'),
  ],
  ['pin_room_fact', on('write', 'pin_room_fact', 'ixo:matrix/channel-memory')],
  [
    'unpin_room_fact',
    on('write', 'unpin_room_fact', 'ixo:matrix/channel-memory'),
  ],

  // ── sandbox ──────────────────────────────────────────────────────────────
  ['sandbox_write_blob', on('write', 'sandbox_write_blob', 'ixo:sandbox')],

  // ── vfs ──────────────────────────────────────────────────────────────────
  ['vfs_search', on('read', 'vfs_search', vfsObject)],
  ['vfs_grep', on('read', 'vfs_grep', vfsObject)],
  ['vfs_glob', on('read', 'vfs_glob', vfsObject)],
  ['vfs_list', on('read', 'vfs_list', vfsObject)],
  ['vfs_read', on('read', 'vfs_read', vfsObject)],
  ['vfs_write', on('write', 'vfs_write', vfsObject)],
  ['vfs_edit', on('write', 'vfs_edit', vfsObject)],
  ['vfs_move', on('write', 'vfs_move', vfsObject)],
  ['vfs_delete', on('delete', 'vfs_delete', vfsObject)],
  // Publishing changes who may read a file — see the file overview.
  ['vfs_share', on('govern', 'vfs_share', vfsObject)],
  ['sandbox_to_vfs', on('write', 'sandbox_to_vfs', vfsObject)],
  ['vfs_to_sandbox', on('write', 'vfs_to_sandbox', 'ixo:sandbox')],

  // ── editor: pages ────────────────────────────────────────────────────────
  ['create_page', on('write', 'create_page', editorObject)],
  ['read_page', on('read', 'read_page', editorObject)],
  ['update_page', on('write', 'update_page', editorObject)],

  // ── editor: blocks ───────────────────────────────────────────────────────
  ['list_blocks', on('read', 'list_blocks', editorObject)],
  ['read_block_by_id', on('read', 'read_block_by_id', editorObject)],
  ['read_block_history', on('read', 'read_block_history', editorObject)],
  ['read_permissions', on('read', 'read_permissions', editorObject)],
  ['search_blocks', on('read', 'search_blocks', editorObject)],
  ['read_survey', on('read', 'read_survey', editorObject)],
  // Validation reports; it changes nothing.
  [
    'validate_survey_answers',
    on('read', 'validate_survey_answers', editorObject),
  ],
  ['read_flow_context', on('read', 'read_flow_context', editorObject)],
  ['read_flow_status', on('read', 'read_flow_status', editorObject)],
  ['create_block', on('write', 'create_block', editorObject)],
  ['edit_block', on('write', 'edit_block', editorObject)],
  ['find_and_replace', on('write', 'find_and_replace', editorObject)],
  ['move_block', on('write', 'move_block', editorObject)],
  ['bulk_edit_blocks', on('write', 'bulk_edit_blocks', editorObject)],
  ['fill_survey_answers', on('write', 'fill_survey_answers', editorObject)],
  [
    'apply_sandbox_output_to_block',
    on('write', 'apply_sandbox_output_to_block', editorObject),
  ],
  ['delete_block', on('delete', 'delete_block', editorObject)],
  // Runs an action block through the flow engine — the one editor tool that
  // reaches outside the document.
  ['execute_action', on('execute', 'execute_action', editorObject)],

  // ── editor: capability minting ───────────────────────────────────────────
  // Delegating authority to a service, not issuing a credential.
  [
    'mint_invocation',
    on('govern', 'mint_invocation', 'ixo:runtime/capabilities'),
  ],
  [
    'ucan_invocation',
    on('govern', 'mint_invocation', 'ixo:runtime/capabilities'),
  ],

  // ── tasks ────────────────────────────────────────────────────────────────
  ['preview_task', on('read', 'preview_task', taskObject)],
  ['list_my_tasks', on('read', 'list_my_tasks', 'ixo:tasks')],
  ['get_task', on('read', 'get_task', taskObject)],
  ['create_task', on('write', 'create_task', taskObject)],
  ['update_task', on('write', 'update_task', taskObject)],
  // Recording a decision about a draft is an evaluation, whatever it is
  // stored as.
  [
    'resolve_task_approval',
    on('evaluate', 'resolve_task_approval', taskObject),
  ],
  // Proposes a fix without applying it.
  ['suggest_spec_fix', on('propose', 'suggest_spec_fix', taskObject)],
  // Lifecycle status changes, built by a shared factory rather than declared
  // individually — which is why a search for `name:` does not find them, and
  // why the drift test collects from the registry instead of grepping.
  // `cancel_task` sets a status; it does not destroy the record, so it is a
  // write rather than a delete.
  ['pause_task', on('write', 'pause_task', taskObject)],
  ['resume_task', on('write', 'resume_task', taskObject)],
  ['cancel_task', on('write', 'cancel_task', taskObject)],

  // ── flows (opt-in, not bundled — declared so a fork that wires it in is
  //    covered from the first call rather than after its first refusal) ─────
  ['list_actions', on('read', 'list_actions', 'ixo:flow/catalog')],
  ['describe_action', on('read', 'describe_action', 'ixo:flow/catalog')],
  [
    'list_referenceable_fields',
    on('read', 'list_referenceable_fields', flowObject),
  ],
  ['read_flow', on('read', 'read_flow', flowObject)],
  ['get_step', on('read', 'get_step', flowObject)],
  ['flow_status', on('read', 'flow_status', flowObject)],
  ['explain_step', on('read', 'explain_step', flowObject)],
  ['check_link', on('read', 'check_link', flowObject)],
  ['compatible_actions', on('read', 'compatible_actions', flowObject)],
  ['requirements', on('read', 'requirements', flowObject)],
  ['describe_form', on('read', 'describe_form', flowObject)],
  ['validate_flow', on('read', 'validate_flow', flowObject)],
  ['create_template', on('write', 'create_template', flowObject)],
  ['add_step', on('write', 'add_step', flowObject)],
  ['remove_step', on('write', 'remove_step', flowObject)],
  ['reorder_step', on('write', 'reorder_step', flowObject)],
  ['update_flow_meta', on('write', 'update_flow_meta', flowObject)],
  ['connect_steps', on('write', 'connect_steps', flowObject)],
  ['update_step', on('write', 'update_step', flowObject)],
  ['set_form_schema', on('write', 'set_form_schema', flowObject)],
  ['fill_form', on('write', 'fill_form', flowObject)],
  ['set_step_inputs', on('write', 'set_step_inputs', flowObject)],
  ['set_step_conditions', on('write', 'set_step_conditions', flowObject)],
  ['set_step_schedule', on('write', 'set_step_schedule', flowObject)],
  ['set_step_assignment', on('write', 'set_step_assignment', flowObject)],
  ['set_step_confirmation', on('write', 'set_step_confirmation', flowObject)],
  ['set_step_trigger', on('write', 'set_step_trigger', flowObject)],
]);

/**
 * The effect for a tool, if anything declares one.
 *
 * A tool's own `effect` wins. That ordering matters: a fork's plugin, or a
 * bundled tool that later grows a declaration next to itself, must not be
 * overridden by this table.
 */
export function resolveToolEffect(tool: PluginTool): ToolEffect | undefined {
  return tool.effect ?? BUNDLED_TOOL_EFFECTS.get(tool.name);
}

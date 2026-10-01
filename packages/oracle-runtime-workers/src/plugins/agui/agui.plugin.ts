/**
 * AG-UI plugin — the Workers port of the Node runtime's `AGUIPlugin`.
 *
 * The client declares its AG-UI actions in the turn body (`agActions[]` →
 * `state.agActions`, each `{ name, description, schema, hasRender? }`); the
 * plugin builds one tool per action and exposes them through the AG-UI
 * sub-agent (`call_ag-ui_agent`). Calling an action emits `action_call` over
 * the realtime channel (`ctx.frontend.callAgAction`) and waits for the
 * client's `action_call_result` — the SSE stream shows the same call as an
 * `action_call` event from the sub-agent's forwarded tool call.
 */
import { z } from 'zod';
import type { AgAction } from '../../core/state';
import { clientSchemaToZod } from '../../core/utils';
import { OraclePlugin } from '../../plugin-api/oracle-plugin';
import { tool } from '../../plugin-api/tool-helper';
import type {
  PluginManifest,
  PluginSubAgent,
  PluginTool,
  RuntimeContext,
} from '../../plugin-api/types';
import { logActionToMatrix } from '../portal/action-log';
import { createAguiSubAgent } from './agui-agent';

const manifest: PluginManifest = {
  title: 'AG-UI',
  summary:
    "Renders interactive UI components (tables, charts, forms) in the user's browser via AG-UI actions.",
  whenToUse: [
    'User asks for an interactive table, chart, or form to be rendered.',
    'A response is best shown as a structured UI component rather than plain text.',
  ],
  whenNotToUse: [
    'No AG-UI actions are declared on this request (sub-agent is not built).',
    "A plain text answer is sufficient — don't render UI just because you can.",
  ],
  examples: [
    {
      user: 'Show me the results as a table.',
      thought:
        'Structured display — delegate to call_ag-ui_agent with the rows.',
      tool: 'call_ag-ui_agent',
    },
  ],
  tags: ['agui', 'ui', 'portal', 'copilot'],
  category: 'ui',
  visibility: 'on-demand',
  stability: 'stable',
};

export const AG_ACTION_TIMEOUT_MS = 15_000;

const AG_ACTION_SHAPE = z.object({
  name: z.string(),
  description: z.string(),
  schema: z.record(z.string(), z.unknown()),
  hasRender: z.boolean().optional(),
});

const ARGS_RECORD_SHAPE = z.record(z.string(), z.unknown());

export function parseAgActions(value: unknown): AgAction[] {
  if (!Array.isArray(value)) return [];
  const out: AgAction[] = [];
  for (const entry of value) {
    const parsed = AG_ACTION_SHAPE.safeParse(entry);
    if (parsed.success) out.push(parsed.data);
  }
  return out;
}

function parseArgs(input: unknown): Record<string, unknown> {
  const parsed = ARGS_RECORD_SHAPE.safeParse(input ?? {});
  return parsed.success ? parsed.data : {};
}

export function buildActionTool(action: AgAction): PluginTool | null {
  const schema = clientSchemaToZod(action.schema, action.name);
  if (!schema) return null;
  return tool(
    async (input, ctx: RuntimeContext) => {
      const sessionId = ctx.session.id;
      if (!sessionId) {
        throw new Error('sessionId is required for AG-UI actions');
      }
      const frontend = ctx.frontend;
      if (!frontend) {
        throw new Error(
          `AG-UI action ${action.name} needs the realtime channel, which this host does not provide.`,
        );
      }
      if (!frontend.hasClient(sessionId)) {
        throw new Error(
          `No browser is connected to session ${sessionId}, so AG-UI action ${action.name} cannot run — the client must open the realtime (socket.io) channel for this session first.`,
        );
      }
      const args = parseArgs(input);
      const requestId = ctx.session.requestId;
      const toolCallId = `ag_${requestId || 'noreq'}_${crypto
        .randomUUID()
        .slice(0, 8)}`;
      const result = await frontend.callAgAction({
        sessionId,
        toolCallId,
        toolName: action.name,
        args,
        timeoutMs: AG_ACTION_TIMEOUT_MS,
      });
      logActionToMatrix(ctx, {
        name: action.name,
        args,
        result,
        success: true,
      });
      return JSON.stringify(result);
    },
    {
      name: action.name,
      description: action.description,
      schema,
    },
  );
}

function readAgActions(rtCtx: RuntimeContext): AgAction[] {
  return parseAgActions(rtCtx.history.state.agActions);
}

export class AGUIPlugin extends OraclePlugin {
  readonly name = 'agui';

  readonly version = '1.0.0';

  readonly manifest = manifest;

  override async getRequestSubAgents(
    rtCtx: RuntimeContext,
  ): Promise<PluginSubAgent[]> {
    const actions = readAgActions(rtCtx);
    if (actions.length === 0) return [];
    const tools = actions
      .map(buildActionTool)
      .filter((t): t is PluginTool => t !== null);
    if (tools.length === 0) return [];
    return [createAguiSubAgent(tools)];
  }
}

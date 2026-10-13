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
import { logFrontendAction } from '../portal/action-log';
import {
  describeDropped,
  sanitizeDeclaredTools,
} from '../portal/declared-tools';
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

/** The client's AG-UI actions; a name declared twice keeps its first descriptor. */
export function parseAgActions(value: unknown): AgAction[] {
  if (!Array.isArray(value)) return [];
  const out: AgAction[] = [];
  const names = new Set<string>();
  for (const entry of value) {
    const parsed = AG_ACTION_SHAPE.safeParse(entry);
    if (!parsed.success || names.has(parsed.data.name)) continue;
    names.add(parsed.data.name);
    out.push(parsed.data);
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
      // The bridge makes every invocation unique (`ag_<requestId>:<uuid>`).
      let invocationId: string | undefined;
      const result = await frontend.callAgAction({
        sessionId,
        toolCallId: `ag_${ctx.session.requestId || 'noreq'}`,
        toolName: action.name,
        args: parseArgs(input),
        timeoutMs: AG_ACTION_TIMEOUT_MS,
        signal: ctx.abortSignal,
        onInvocation: (id) => {
          invocationId = id;
        },
      });
      logFrontendAction(ctx, { name: action.name, invocationId, result });
      return JSON.stringify(result);
    },
    {
      name: action.name,
      description: action.description,
      schema,
      // A UI action on the user's screen: running it again is a new action.
      repeatable: true,
    },
  );
}

/**
 * The AG-UI actions declared on this request that may become tools: invalid,
 * duplicate and oversized declarations are dropped (`declared-tools.ts`).
 */
function readAgActions(rtCtx: RuntimeContext): AgAction[] {
  const { kept, dropped } = sanitizeDeclaredTools(
    parseAgActions(rtCtx.history.state.agActions),
  );
  const summary = describeDropped('AG-UI actions', dropped);
  if (summary) rtCtx.logger.warn(summary);
  return kept;
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

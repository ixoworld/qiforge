import { callAgAction, logActionToMatrix } from '@ixo/common';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { AgAction } from '../../graph/state.js';
import { OraclePlugin } from '../../plugin-api/oracle-plugin.js';
import { tool } from '../../plugin-api/tool-helper.js';
import type {
  PluginManifest,
  PluginSubAgent,
  PluginTool,
  RuntimeContext,
} from '../../plugin-api/types.js';
import { createAguiSubAgent } from './agui-agent.js';

const manifest: PluginManifest = {
  title: 'AG-UI',
  summary:
    'Generates interactive UI components (tables, charts, forms) in the user’s browser via AG-UI actions.',
  whenToUse: [
    'User asks for an interactive table, chart, or form to be rendered.',
    'A response is best shown as a structured UI component rather than text.',
  ],
  whenNotToUse: [
    'No AG-UI actions are declared on this request (sub-agent is not built).',
    'A plain text answer is sufficient and no interactive rendering is needed.',
  ],
  tags: ['agui', 'ui', 'portal', 'copilot'],
  category: 'ui',
  visibility: 'always',
  stability: 'stable',
};

/** Default per-action timeout — matches today's `parserActionTool`. */
const ACTION_TIMEOUT_MS = 15_000;

const AG_ACTION_SHAPE = z.object({
  name: z.string(),
  description: z.string(),
  schema: z.record(z.string(), z.unknown()),
  hasRender: z.boolean().optional(),
});

const ARGS_RECORD_SHAPE = z.record(z.string(), z.unknown());

function parseAgActions(value: unknown): AgAction[] {
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

/**
 * Build a single PluginTool that, when invoked, dispatches the AG-UI action to
 * the user's frontend via the existing `callAgAction` helper and waits for the
 * result. Mirrors today's `parserActionTool` behaviour (matrix logging on
 * success, unique tool-call id per invocation) but sources `sessionId`,
 * `requestId`, and `roomId` from `RuntimeContext` instead of LangChain'
 * configurable bag.
 */
function buildActionTool(action: AgAction): PluginTool {
  return tool(
    async (input, ctx: RuntimeContext) => {
      const sessionId = ctx.session.id;
      if (!sessionId) {
        throw new Error('sessionId is required for AG-UI actions');
      }

      const args = parseArgs(input);
      const requestId = ctx.session.requestId;
      const toolCallId = `ag_${requestId || 'noreq'}_${randomUUID().slice(0, 8)}`;

      const result = await callAgAction({
        sessionId,
        toolCallId,
        toolName: action.name,
        args,
        timeout: ACTION_TIMEOUT_MS,
      });

      if (ctx.session.roomId) {
        void logActionToMatrix(
          {
            name: action.name,
            args,
            result,
            success: true,
          },
          {
            roomId: ctx.session.roomId,
            threadId: sessionId,
          },
        );
      }

      return JSON.stringify(result);
    },
    {
      name: action.name,
      description: action.description,
      schema: z.fromJSONSchema(action.schema),
    },
  );
}

function readAgActions(rtCtx: RuntimeContext): AgAction[] {
  return parseAgActions(rtCtx.history.state.agActions);
}

/**
 * AG-UI plugin (Portal copilot). The sub-agent is built per-request from
 * `state.agActions` — the client declares its renderable actions on each
 * `sendMessage`, the runtime wraps each into a PluginTool, and the agent
 * decides whether to delegate. When no actions are declared the plugin
 * contributes nothing.
 */
export class AGUIPlugin extends OraclePlugin {
  readonly name = 'agui';

  readonly version = '1.0.0';

  readonly manifest = manifest;

  override async getRequestSubAgents(
    rtCtx: RuntimeContext,
  ): Promise<PluginSubAgent[]> {
    const actions = readAgActions(rtCtx);
    if (actions.length === 0) return [];

    const tools = actions.map(buildActionTool);
    return [createAguiSubAgent(tools)];
  }
}

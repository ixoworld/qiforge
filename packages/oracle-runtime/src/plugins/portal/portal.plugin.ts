import { callBrowserTool, logActionToMatrix } from '@ixo/common';
import { z } from 'zod';
import type { BrowserToolCall } from '../../graph/state.js';
import { OraclePlugin } from '../../plugin-api/oracle-plugin.js';
import { tool } from '../../plugin-api/tool-helper.js';
import type {
  PluginManifest,
  PluginSubAgent,
  PluginTool,
  RuntimeContext,
} from '../../plugin-api/types.js';
import { createPortalSubAgent } from './portal-agent.js';

const manifest: PluginManifest = {
  title: 'Portal',
  summary:
    "Browser-side actions on the user's Portal UI — opens URLs, manipulates the DOM, runs FE-defined browser tools.",
  whenToUse: [
    'User asks for an action the Portal FE exposes as a browser tool (declared in `state.browserTools`).',
    "A task needs a browser-side capability the server can't do alone — open a URL in the user's tab, click a Portal button, fill a form.",
  ],
  whenNotToUse: [
    'No browser tools are declared on this request (sub-agent is not built).',
    'The task can be completed purely server-side (use a server tool or sub-agent).',
  ],
  examples: [
    {
      user: 'Open my workspace and navigate to the Reports page.',
      thought:
        'Portal exposes navigation as a browser tool — delegate via call_portal_agent with the target URL.',
      tool: 'call_portal_agent',
    },
  ],
  tags: ['portal', 'browser', 'ui'],
  category: 'ui',
  visibility: 'on-demand',
  stability: 'stable',
};

/** Default per-tool timeout — matches today's `parserBrowserTool`. */
const BROWSER_TOOL_TIMEOUT_MS = 15_000;

const BROWSER_TOOL_SHAPE = z.object({
  name: z.string(),
  description: z.string(),
  schema: z.record(z.string(), z.unknown()),
});

const ARGS_RECORD_SHAPE = z.record(z.string(), z.unknown());

function parseBrowserTools(value: unknown): BrowserToolCall[] {
  if (!Array.isArray(value)) return [];
  const out: BrowserToolCall[] = [];
  for (const entry of value) {
    const parsed = BROWSER_TOOL_SHAPE.safeParse(entry);
    if (parsed.success) out.push(parsed.data);
  }
  return out;
}

function parseArgs(input: unknown): Record<string, unknown> {
  const parsed = ARGS_RECORD_SHAPE.safeParse(input ?? {});
  return parsed.success ? parsed.data : {};
}

/**
 * Build a single PluginTool that, when invoked, dispatches the browser tool to
 * the user's frontend via the existing `callBrowserTool` helper and waits for
 * the result. Mirrors today's `parserBrowserTool` behaviour (matrix logging on
 * success, `tc-${requestId}` tool-call id) but sources `sessionId`,
 * `requestId`, and `roomId` from `RuntimeContext` instead of LangChain's
 * configurable bag.
 */
function buildBrowserTool(descriptor: BrowserToolCall): PluginTool {
  return tool(
    async (input, ctx: RuntimeContext) => {
      const sessionId = ctx.session.id;
      if (!sessionId) {
        throw new Error('sessionId is required for browser tools');
      }

      const args = parseArgs(input);
      const requestId = ctx.session.requestId;
      const toolCallId = `tc-${requestId ?? 'noreq'}`;

      const result = await callBrowserTool({
        sessionId,
        toolCallId,
        toolName: descriptor.name,
        args,
        timeout: BROWSER_TOOL_TIMEOUT_MS,
      });

      if (ctx.session.roomId) {
        void logActionToMatrix(
          {
            name: descriptor.name,
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

      return result;
    },
    {
      name: descriptor.name,
      description: descriptor.description,
      schema: z.fromJSONSchema(descriptor.schema),
    },
  );
}

function readBrowserTools(rtCtx: RuntimeContext): BrowserToolCall[] {
  return parseBrowserTools(rtCtx.history.state.browserTools);
}

/**
 * Portal plugin. The sub-agent is built per-request from `state.browserTools`
 * — the client declares its browser-side tools on each `sendMessage`, the
 * runtime wraps each into a PluginTool, and the agent decides whether to
 * delegate. When no browser tools are declared the plugin contributes
 * nothing.
 */
export class PortalPlugin extends OraclePlugin {
  readonly name = 'portal';

  readonly version = '1.0.0';

  readonly manifest = manifest;

  override async getRequestSubAgents(
    rtCtx: RuntimeContext,
  ): Promise<PluginSubAgent[]> {
    const browserTools = readBrowserTools(rtCtx);
    if (browserTools.length === 0) return [];

    const tools = browserTools.map(buildBrowserTool);
    return [createPortalSubAgent(tools)];
  }
}

import { callBrowserTool, logActionToMatrix } from '@ixo/common';
import { z } from 'zod';
import type { BrowserToolCall } from '../../graph/state.js';
import { OraclePlugin } from '../../plugin-api/oracle-plugin.js';
import { tool } from '../../plugin-api/tool-helper.js';
import type {
  PluginManifest,
  PluginTool,
  RuntimeContext,
} from '../../plugin-api/types.js';
import { clientSchemaToZod } from '../../utils/client-tool-schema.js';

const manifest: PluginManifest = {
  title: 'Portal',
  summary:
    "Browser-side actions on the user's Portal UI — opens URLs, manipulates the DOM, runs FE-defined browser tools.",
  whenToUse: [
    'User asks for an action the Portal FE exposes as a browser tool (declared in `state.browserTools`).',
    "A task needs a browser-side capability the server can't do alone — open a URL in the user's tab, click a Portal button, fill a form.",
  ],
  whenNotToUse: [
    'No browser tools are declared on this request (no tools are contributed).',
    'The task can be completed purely server-side (use a server tool or sub-agent).',
  ],
  examples: [
    {
      user: 'Open my workspace and navigate to the Reports page.',
      thought:
        'Portal exposes navigation as a browser tool — call the FE-declared tool (e.g. `open_url`) directly with the target URL.',
      tool: 'open_url',
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
 *
 * Returns `null` when the FE declared a schema the runtime cannot convert —
 * that tool is dropped rather than failing the whole request.
 */
function buildBrowserTool(descriptor: BrowserToolCall): PluginTool | null {
  const schema = clientSchemaToZod(descriptor.schema, descriptor.name);
  if (!schema) return null;

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
      schema,
    },
  );
}

function readBrowserTools(rtCtx: RuntimeContext): BrowserToolCall[] {
  return parseBrowserTools(rtCtx.history.state.browserTools);
}

/**
 * Portal plugin. Tools are built per-request from `state.browserTools` — the
 * client declares its browser-side tools on each `sendMessage`, and the
 * runtime wraps each into a PluginTool bound directly to the main agent.
 * When no browser tools are declared the plugin contributes nothing.
 */
export class PortalPlugin extends OraclePlugin {
  readonly name = 'portal';

  readonly version = '1.0.0';

  readonly manifest = manifest;

  override async getRequestTools(rtCtx: RuntimeContext): Promise<PluginTool[]> {
    const browserTools = readBrowserTools(rtCtx);
    if (browserTools.length === 0) return [];

    return browserTools
      .map(buildBrowserTool)
      .filter((tool): tool is PluginTool => tool !== null);
  }
}

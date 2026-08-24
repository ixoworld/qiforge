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
 * Arguments the runtime fills in itself, keyed by the config value that
 * supplies them.
 *
 * `oracleUserId` is the oracle's own Matrix id. Browser tools that grant this
 * oracle access to a room (`create_page_room`, `create_template_room`,
 * `grant_assistant_access`) need it, but the model has no way to know it — it
 * is server-side config, never in the prompt. Left in the schema, the model
 * either invents an id or asks the user for one, which is what it did.
 *
 * It cannot be derived on the Portal side from the chat's `oracleDid` either:
 * that is an entity DID (`did:ixo:entity:<hash>`), not the oracle's bech32
 * address, so rebuilding a Matrix id from it produces a bogus user.
 *
 * So: strip these from the schema the model sees, and inject them at dispatch.
 */
const RUNTIME_SUPPLIED_ARGS: Record<string, string> = {
  oracleUserId: 'MATRIX_ORACLE_ADMIN_USER_ID',
};

/**
 * Remove the runtime-supplied keys from a JSON-schema object so they never
 * reach the model as parameters. Returns the schema untouched when it declares
 * none of them.
 */
function stripRuntimeSuppliedArgs(
  schema: Record<string, unknown>,
): Record<string, unknown> {
  const properties = schema.properties;
  if (typeof properties !== 'object' || properties === null) return schema;

  const declared = Object.keys(RUNTIME_SUPPLIED_ARGS).filter(
    (key) => key in (properties as Record<string, unknown>),
  );
  if (declared.length === 0) return schema;

  const nextProperties: Record<string, unknown> = {
    ...(properties as Record<string, unknown>),
  };
  for (const key of declared) delete nextProperties[key];

  const next: Record<string, unknown> = {
    ...schema,
    properties: nextProperties,
  };
  if (Array.isArray(schema.required)) {
    next.required = schema.required.filter(
      (name) => typeof name !== 'string' || !declared.includes(name),
    );
  }
  return next;
}

/**
 * Fill in the runtime-supplied arguments this descriptor declares. A value the
 * config does not carry is omitted rather than sent as `undefined`, so the
 * browser tool sees exactly the same shape it would from an older runtime.
 */
function withRuntimeSuppliedArgs(
  args: Record<string, unknown>,
  descriptor: BrowserToolCall,
  config: Record<string, unknown>,
): Record<string, unknown> {
  const properties = descriptor.schema.properties;
  if (typeof properties !== 'object' || properties === null) return args;

  const next = { ...args };
  for (const [argName, configKey] of Object.entries(RUNTIME_SUPPLIED_ARGS)) {
    if (!(argName in (properties as Record<string, unknown>))) continue;
    const value = config[configKey];
    if (typeof value === 'string' && value.length > 0) next[argName] = value;
  }
  return next;
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
  const schema = clientSchemaToZod(
    stripRuntimeSuppliedArgs(descriptor.schema),
    descriptor.name,
  );
  if (!schema) return null;

  return tool(
    async (input, ctx: RuntimeContext) => {
      const sessionId = ctx.session.id;
      if (!sessionId) {
        throw new Error('sessionId is required for browser tools');
      }

      const args = withRuntimeSuppliedArgs(
        parseArgs(input),
        descriptor,
        ctx.config,
      );
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

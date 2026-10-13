/**
 * Portal plugin — the Workers port of the Node runtime's `PortalPlugin`.
 *
 * Every request-time tool comes from the client: the Portal declares its
 * browser tools in the turn body (`tools[]` → `state.browserTools`, each a
 * `{ name, description, schema }` JSON-schema descriptor), and this plugin
 * turns each into an agent tool that runs IN THE BROWSER over the realtime
 * channel (`ctx.frontend.callBrowserTool` → `browser_tool_call` socket event
 * → the client answers `tool_result`).
 *
 * Runtime-supplied arguments: a descriptor may declare `oracleUserId`; it is
 * hidden from the model and filled from `MATRIX_ORACLE_ADMIN_USER_ID` (the
 * Portal's `create_page_room` uses it to invite the assistant into the new
 * page), exactly as on Node.
 */
import { z } from 'zod';
import type { BrowserToolCall } from '../../core/state';
import { clientSchemaToZod } from '../../core/utils';
import { OraclePlugin } from '../../plugin-api/oracle-plugin';
import { tool } from '../../plugin-api/tool-helper';
import type {
  PluginManifest,
  PluginTool,
  RuntimeContext,
} from '../../plugin-api/types';
import { logFrontendAction } from './action-log';
import { describeDropped, sanitizeDeclaredTools } from './declared-tools';

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

export const BROWSER_TOOL_TIMEOUT_MS = 15_000;

/**
 * The Portal's Topic write tool. Its commands can take a while to settle in
 * the browser (several Matrix writes), so it gets a longer window before the
 * call is reported as an unknown outcome.
 */
export const TOPIC_MUTATION_TOOL = 'mutate_topic';
export const TOPIC_MUTATION_TIMEOUT_MS = 120_000;

export function browserToolTimeoutMs(toolName: string): number {
  return toolName === TOPIC_MUTATION_TOOL
    ? TOPIC_MUTATION_TIMEOUT_MS
    : BROWSER_TOOL_TIMEOUT_MS;
}

const BROWSER_TOOL_SHAPE = z.object({
  name: z.string(),
  description: z.string(),
  schema: z.record(z.string(), z.unknown()),
});

const ARGS_RECORD_SHAPE = z.record(z.string(), z.unknown());

/** The client's browser tools; a name declared twice keeps its first descriptor. */
export function parseBrowserTools(value: unknown): BrowserToolCall[] {
  if (!Array.isArray(value)) return [];
  const out: BrowserToolCall[] = [];
  const names = new Set<string>();
  for (const entry of value) {
    const parsed = BROWSER_TOOL_SHAPE.safeParse(entry);
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

/** Descriptor argument → config key whose value the runtime injects. */
const RUNTIME_SUPPLIED_ARGS: Record<string, string> = {
  oracleUserId: 'MATRIX_ORACLE_ADMIN_USER_ID',
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

export function stripRuntimeSuppliedArgs(
  schema: Record<string, unknown>,
): Record<string, unknown> {
  const properties = schema.properties;
  if (!isRecord(properties)) return schema;
  const declared = Object.keys(RUNTIME_SUPPLIED_ARGS).filter(
    (key) => key in properties,
  );
  if (declared.length === 0) return schema;
  const nextProperties: Record<string, unknown> = { ...properties };
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

export function withRuntimeSuppliedArgs(
  args: Record<string, unknown>,
  descriptor: BrowserToolCall,
  config: Record<string, unknown>,
): Record<string, unknown> {
  const properties = descriptor.schema.properties;
  if (!isRecord(properties)) return args;
  const next = { ...args };
  for (const [argName, configKey] of Object.entries(RUNTIME_SUPPLIED_ARGS)) {
    if (!(argName in properties)) continue;
    const value = config[configKey];
    if (typeof value === 'string' && value.length > 0) next[argName] = value;
  }
  return next;
}

export function buildBrowserTool(
  descriptor: BrowserToolCall,
): PluginTool | null {
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
      const frontend = ctx.frontend;
      if (!frontend) {
        throw new Error(
          `Browser tool ${descriptor.name} needs the realtime channel, which this host does not provide.`,
        );
      }
      if (!frontend.hasClient(sessionId)) {
        throw new Error(
          `No browser is connected to session ${sessionId}, so browser tool ${descriptor.name} cannot run — the client must open the realtime (socket.io) channel for this session first.`,
        );
      }
      const args = withRuntimeSuppliedArgs(
        parseArgs(input),
        descriptor,
        ctx.config,
      );
      // The bridge makes every invocation unique (`tc-<requestId>:<uuid>`).
      let invocationId: string | undefined;
      const result = await frontend.callBrowserTool({
        sessionId,
        toolCallId: `tc-${ctx.session.requestId || 'noreq'}`,
        toolName: descriptor.name,
        args,
        timeoutMs: browserToolTimeoutMs(descriptor.name),
        signal: ctx.abortSignal,
        onInvocation: (id) => {
          invocationId = id;
        },
      });
      logFrontendAction(ctx, { name: descriptor.name, invocationId, result });
      return result;
    },
    {
      name: descriptor.name,
      description: descriptor.description,
      schema,
      // A browser step (scroll, page, click) repeated is a new step.
      repeatable: true,
    },
  );
}

/**
 * The browser tools declared on this request that may become tools: invalid,
 * duplicate and oversized declarations are dropped (`declared-tools.ts`).
 */
function readBrowserTools(rtCtx: RuntimeContext): BrowserToolCall[] {
  const { kept, dropped } = sanitizeDeclaredTools(
    parseBrowserTools(rtCtx.history.state.browserTools),
  );
  const summary = describeDropped('browser tools', dropped);
  if (summary) rtCtx.logger.warn(summary);
  return kept;
}

export class PortalPlugin extends OraclePlugin {
  readonly name = 'portal';

  readonly version = '1.0.0';

  readonly manifest = manifest;

  override async getRequestTools(rtCtx: RuntimeContext): Promise<PluginTool[]> {
    const browserTools = readBrowserTools(rtCtx);
    if (browserTools.length === 0) return [];
    return browserTools
      .map(buildBrowserTool)
      .filter((t): t is PluginTool => t !== null);
  }
}

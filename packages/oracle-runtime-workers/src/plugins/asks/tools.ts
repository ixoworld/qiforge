/**
 * The tools the asks plugin gives a turn. Not connected: `asks_connect`,
 * `asks_status` and `asks_skill`. Connected: those, `asks_disconnect`,
 * `asks_attach_files` and the hosted connector's own tools (minus the ones
 * that do not fit a phone), called with the person's Bearer token, which only
 * their connection object refreshes.
 */
import { toJsonSchema } from '@langchain/core/utils/json_schema';
import { MultiServerMCPClient } from '@langchain/mcp-adapters';
import type { PluginTool, RuntimeContext } from '../../plugin-api';
import { z } from 'zod';
import { checkDraftUploads, sendFile, type KeptFile } from './attach';
import type { ConnectionApi, Surface } from './connection';
import { shortAccount } from './oauth';
import { withCallTimeout } from '../mcp-call-timeout';
import { adaptMcpClientTools } from '../mcp-tool-adapter';
import type { Skill } from './skills';

export const SERVER = 'asks';
export const PREFIX = `${SERVER}__`;
/** asks' functions run up to 60 s; a little more here so their own answer wins. */
export const CALL_TIMEOUT_MS = 70_000;
/** Listing the connector's tools on a cold cache; a hung asks must not hold the turn. */
export const LIST_TIMEOUT_MS = 15_000;
const DEFS_TTL_MS = 5 * 60_000;
const STATE_NS = 'asks/connection';
const FILES_NS = 'asks/files';
const FILES_TTL_MS = 7 * 24 * 60 * 60_000;

/** Connector tools that do not fit a phone chat (plans, campaigns, payouts, billing). */
export const LEFT_OUT: ReadonlySet<string> = new Set([
  'create_campaign',
  'organise_campaign',
  'draft_plan',
  'fund_plan',
  'close_plan',
  'scope_market',
  'plan_status',
  'set_payout_settings',
  'review_billing_status',
]);

export const SIGN_IN_AGAIN =
  'The asks.world sign-in has ended (or was disconnected). Call asks_connect and send the person the new link.';

/* ── the MCP side ──────────────────────────────────────────────────────── */

export interface McpTool {
  name: string;
  description: string;
  schema: z.ZodType;
  invoke(input: unknown): Promise<unknown>;
}

export interface McpConnection {
  tools: McpTool[];
  /** `readOnlyHint` by tool name. */
  readOnly: ReadonlySet<string>;
  close(): Promise<void>;
}

export type McpConnect = (url: string, token: string) => Promise<McpConnection>;

/**
 * A JSON Schema without `propertyNames`. The connector's open objects (a record of
 * string keys, e.g. submit_work's `report` and `fields`) carry
 * `propertyNames: { type: "string" }`; `z.fromJSONSchema` turns that into a schema
 * with a transform, which the model binding cannot turn back into JSON Schema, and
 * the whole turn fails before the first model call. Keys are always strings in
 * JSON, so dropping it loses nothing.
 */
export function withoutPropertyNames(schema: unknown): unknown {
  if (Array.isArray(schema)) return schema.map(withoutPropertyNames);
  if (!schema || typeof schema !== 'object') return schema;
  return Object.fromEntries(
    Object.entries(schema as Record<string, unknown>)
      .filter(([key]) => key !== 'propertyNames')
      .map(([key, value]) => [key, withoutPropertyNames(value)]),
  );
}

/** Whether the model binding can state this schema as JSON Schema (a transform cannot). */
export function bindable(schema: z.ZodType): boolean {
  try {
    // The same conversion the model binding runs (LangChain's), not plain zod's:
    // zod alone states a propertyNames record fine, LangChain's strict pass does not.
    toJsonSchema(schema as never);
    return true;
  } catch {
    return false;
  }
}

/**
 * The adapted tools the model can be given. One tool whose schema can't be bound
 * would fail every turn of the chat, so it is left out and logged instead.
 */
export function bindableTools<T extends { name: string; schema: z.ZodType }>(
  tools: readonly T[],
  log: Pick<Console, 'warn'> = console,
): T[] {
  return tools.filter((tool) => {
    if (bindable(tool.schema)) return true;
    log.warn(`[asks] left out ${tool.name}: its input schema can't be bound`);
    return false;
  });
}

export const connectAsksMcp: McpConnect = async (url, token) => {
  const client = new MultiServerMCPClient({
    useStandardContentBlocks: true,
    prefixToolNameWithServerName: true,
    mcpServers: {
      [SERVER]: {
        type: 'http',
        transport: 'http',
        url,
        headers: { authorization: `Bearer ${token}` },
      },
    },
  });
  try {
    const raw = await client.getTools();
    const readOnly = new Set(
      raw
        .filter(
          (tool) =>
            (
              tool.metadata as
                | { annotations?: { readOnlyHint?: boolean } }
                | undefined
            )?.annotations?.readOnlyHint === true,
        )
        .map((tool) => tool.name),
    );
    const cleaned = raw.map((tool) => ({
      name: tool.name,
      description: tool.description,
      schema: withoutPropertyNames(tool.schema),
      invoke: (
        input: unknown,
        config?: { metadata?: Record<string, unknown> },
      ) => tool.invoke(input as never, config as never),
    }));
    return {
      tools: bindableTools(
        adaptMcpClientTools(cleaned, console, {
          requestTimeoutMs: CALL_TIMEOUT_MS,
        }),
      ),
      readOnly,
      close: () => client.close(),
    };
  } catch (error) {
    await client.close().catch(() => undefined);
    throw error;
  }
};

interface ToolDef {
  name: string;
  description: string;
  schema: z.ZodType;
  readOnly: boolean;
}

// Keyed by connector URL only: the connector lists the same tools for every
// signed-in account today. Key it by account too if that ever changes.
const defsCache = new Map<string, { defs: ToolDef[]; expiresAt: number }>();
const defsRefreshing = new Set<string>();

/** Test hook. */
export function clearAsksToolDefs(): void {
  defsCache.clear();
  defsRefreshing.clear();
}

/** The connector's tools a phone chat keeps. */
export function keptDefs(connection: McpConnection): ToolDef[] {
  return connection.tools
    .filter(
      (tool) =>
        tool.name.startsWith(PREFIX) &&
        !LEFT_OUT.has(tool.name.slice(PREFIX.length)),
    )
    .map(({ name, description, schema }) => ({
      name,
      description,
      schema,
      readOnly: connection.readOnly.has(name),
    }));
}

async function listDefs(
  url: string,
  token: string,
  connect: McpConnect,
): Promise<ToolDef[]> {
  const opening = connect(url, token);
  const connection = await withCallTimeout(
    () => opening,
    LIST_TIMEOUT_MS,
    'asks tool list',
    () => opening.then((one) => one.close()).catch(() => undefined),
  );
  try {
    return keptDefs(connection);
  } finally {
    await connection.close().catch(() => undefined);
  }
}

/* ── the upload address: kept, never shown ─────────────────────────────── */

const UPLOAD_ADDRESS =
  /https?:\/\/[^\s"'<>()]+?\/draft-uploads\/du_[A-Za-z0-9_-]{43}\//;
const DRAFT_ID = /ad_[A-Za-z0-9_-]{22}/;

/**
 * Whether an upload address is on asks' own hosts: the connector's host or
 * another under its domain (`https://api.asks.world`, `test.api.asks.world`).
 * The signed PUT it hands out goes to R2 only (`signDraftUpload`, attach.ts).
 */
export function isAsksUploadAddress(address: string, mcpUrl: string): boolean {
  try {
    const url = new URL(address);
    const asks = new URL(mcpUrl).hostname;
    const domain = asks.split('.').slice(-2).join('.');
    return (
      url.protocol === 'https:' &&
      !url.username &&
      !url.port &&
      (url.hostname === asks || url.hostname.endsWith(`.${domain}`))
    );
  } catch {
    return false;
  }
}

/**
 * A tool's text with every upload address line taken out. The address is
 * kept only when `trusted` (submit_work's or set_my_page's own answer) and on asks' hosts:
 * text from the board can carry a look-alike line.
 */
export function hideUploadAddress(
  text: string,
  trusted?: { mcpUrl: string },
): {
  text: string;
  kept: { address: string; draft: string; minutes: number } | null;
} {
  if (!text.includes('/draft-uploads/')) return { text, kept: null };
  const found = UPLOAD_ADDRESS.exec(text)?.[0];
  const address =
    found && trusted && isAsksUploadAddress(found, trusted.mcpUrl)
      ? found
      : undefined;
  const draft = DRAFT_ID.exec(text)?.[0] ?? null;
  const minutes = Number(/works for (\d+) minutes?/.exec(text)?.[1] ?? 60);
  const note =
    draft && address
      ? `Files the person sent in this chat (photos, PDFs) can go with this draft before they open the link: call asks_attach_files with draft "${draft}". Otherwise they add them on the page.`
      : 'Files from this chat cannot go with this answer; the person adds them on the page.';
  let noted = false;
  const lines = text.split('\n').flatMap((line) => {
    if (!line.includes('/draft-uploads/')) return [line];
    if (noted || !trusted) return [];
    noted = true;
    return [note];
  });
  return {
    text: lines.join('\n'),
    kept: draft && address ? { address, draft, minutes } : null,
  };
}

/** Apply `fn` to every text a tool result carries (a string, content blocks, or a block). */
export function mapText(value: unknown, fn: (text: string) => string): unknown {
  if (typeof value === 'string') return fn(value);
  if (Array.isArray(value)) return value.map((one) => mapText(one, fn));
  if (
    value &&
    typeof value === 'object' &&
    typeof (value as { text?: unknown }).text === 'string'
  ) {
    return { ...value, text: fn((value as { text: string }).text) };
  }
  return value;
}

/**
 * Whether an error may be asks refusing the token (HTTP 401) rather than a
 * tool's own refusal (`returned an error`). The MCP adapters flatten the
 * status into text ("(HTTP 401)", "Authentication failed"), so this only
 * decides whether to ask the connection object: it checks the token with
 * asks before anything is forgotten (`ConnectionApi.refused`).
 */
function mayBeUnauthorized(error: unknown): boolean {
  if (error instanceof Error && error.name === 'UnauthorizedError') return true;
  // The MCP SDK's StreamableHTTPError carries the HTTP status as `code`.
  if ((error as { code?: unknown } | null)?.code === 401) return true;
  const message = error instanceof Error ? error.message : String(error);
  return (
    !message.includes('returned an error') &&
    /\(HTTP 401\)|Authentication failed for/.test(message)
  );
}

/* ── the turn ──────────────────────────────────────────────────────────── */

export interface AsksTurn {
  ctx: RuntimeContext;
  conn: ConnectionApi;
  mcpUrl: string;
  channelOrigins: readonly string[];
  skills: readonly Skill[];
  connect: McpConnect;
  fetch: typeof fetch;
  now: () => number;
}

type Seen = { status: 'connected' } | { status: 'pending'; until: number };

async function markSeen(turn: AsksTurn, seen: Seen | null): Promise<void> {
  const kv = turn.ctx.kv;
  if (!kv) return;
  await (
    seen ? kv.set(STATE_NS, 'state', seen) : kv.delete(STATE_NS, 'state')
  ).catch(() => undefined);
}

/**
 * Whether the person is connected, without a call to their object on most
 * turns: their own store remembers it, and the object is asked only while a
 * sign-in is pending (or when there is no store).
 */
export async function isConnected(turn: AsksTurn): Promise<boolean> {
  const kv = turn.ctx.kv;
  const seen = (await kv?.get(STATE_NS, 'state').catch(() => undefined)) as
    | Seen
    | undefined;
  if (seen?.status === 'connected') return true;
  const pending = seen?.status === 'pending' && seen.until > turn.now();
  if (kv && !pending) return false;
  const { connected } = await turn.conn.status();
  if (connected) await markSeen(turn, { status: 'connected' });
  return connected;
}

/** The files the person sent with this turn, kept a week so a later turn can attach them. */
export async function keepTurnFiles(ctx: RuntimeContext): Promise<void> {
  const channel = ctx.session.channel;
  if (!ctx.kv || !channel?.attachments?.length) return;
  for (const file of channel.attachments.slice(0, 10)) {
    if (!/^[0-9a-f]{64}$/.test(file.sha256)) continue;
    const kept: KeptFile = {
      url: file.url,
      sha256: file.sha256,
      mimetype: file.mimetype,
      size: file.size,
      filename: file.filename,
      bindingId: channel.bindingId,
    };
    await ctx.kv.set(FILES_NS, `channel:${file.sha256.slice(0, 16)}`, kept, {
      idleTtlMs: FILES_TTL_MS,
      maxEntries: 200,
    });
  }
}

/** One MCP client per turn, opened on the first call and reopened when the token changes. */
class AsksSession {
  private live: { token: string; connection: Promise<McpConnection> } | null =
    null;

  private closeRegistered = false;

  constructor(private readonly turn: AsksTurn) {}

  close(): void {
    const live = this.live;
    this.live = null;
    void live?.connection.then((one) => one.close()).catch(() => undefined);
  }

  private open(token: string): Promise<McpConnection> {
    if (this.live?.token === token) return this.live.connection;
    this.close();
    if (!this.closeRegistered && this.turn.ctx.onTurnEnd) {
      this.closeRegistered = true;
      this.turn.ctx.onTurnEnd(() => this.close());
    }
    const connection = this.turn.connect(this.turn.mcpUrl, token);
    this.live = { token, connection };
    connection.catch(() => {
      if (this.live?.connection === connection) this.live = null;
    });
    return connection;
  }

  async call(name: string, input: unknown, again = false): Promise<unknown> {
    const read = await this.turn.conn.token();
    if (!read.ok) {
      if (read.reason === 'unreachable')
        throw new Error('asks.world did not answer. Try again in a minute.');
      await markSeen(this.turn, null);
      return SIGN_IN_AGAIN;
    }
    try {
      return await withCallTimeout(
        async () => {
          const tool = (await this.open(read.access)).tools.find(
            (one) => one.name === name,
          );
          if (!tool) throw new Error(`asks.world no longer offers ${name}.`);
          return tool.invoke(input);
        },
        CALL_TIMEOUT_MS,
        `asks tool ${name}`,
        () => this.close(),
      );
    } catch (error) {
      if (!mayBeUnauthorized(error)) throw error;
      const verdict = await this.turn.conn.refused(read.access);
      // Another turn refreshed meanwhile (asks ends the old access token on a
      // refresh). asks checks the token before the call, so a retry is safe.
      if (verdict === 'replaced' && !again) return this.call(name, input, true);
      if (verdict !== 'ended') throw error;
      // asks ended the connection (e.g. a disconnect on /me/agents).
      await markSeen(this.turn, null);
      return SIGN_IN_AGAIN;
    }
  }
}

function connectorTool(
  turn: AsksTurn,
  session: AsksSession,
  def: ToolDef,
): PluginTool {
  return {
    name: def.name,
    description: def.description,
    schema: def.schema,
    effect: def.readOnly ? 'read' : 'write',
    ...(def.name === `${PREFIX}link_status` ? { repeatable: true } : {}),
    handler: async (args) => {
      const result = await session.call(def.name, args);
      let kept: ReturnType<typeof hideUploadAddress>['kept'] = null;
      const trusted =
        // set_my_page hands out the same upload address for a pro page photo.
        def.name === `${PREFIX}submit_work` || def.name === `${PREFIX}set_my_page`
          ? { mcpUrl: turn.mcpUrl }
          : undefined;
      const shown = mapText(result, (text) => {
        const hidden = hideUploadAddress(text, trusted);
        kept ??= hidden.kept;
        return hidden.text;
      });
      const upload = kept as ReturnType<typeof hideUploadAddress>['kept'];
      if (upload)
        await turn.conn.keepUpload(
          upload.draft,
          upload.address,
          turn.now() + upload.minutes * 60_000,
        );
      return shown;
    },
  };
}

/** The connector's tools for this turn: cached definitions, a lazy client. `null`: signed out. */
async function connectorTools(turn: AsksTurn): Promise<PluginTool[] | null> {
  const { mcpUrl } = turn;
  const cached = defsCache.get(mcpUrl);
  const list = async (token: string) => {
    const fresh = await listDefs(mcpUrl, token, turn.connect);
    defsCache.set(mcpUrl, { defs: fresh, expiresAt: turn.now() + DEFS_TTL_MS });
    return fresh;
  };
  let defs = cached?.defs;
  if (!defs) {
    const read = await turn.conn.token();
    if (!read.ok) {
      if (read.reason === 'unreachable')
        throw new Error('asks.world did not answer');
      await markSeen(turn, null);
      return null;
    }
    defs = await list(read.access);
  } else if (
    cached &&
    cached.expiresAt <= turn.now() &&
    !defsRefreshing.has(mcpUrl)
  ) {
    // Stale definitions keep serving while they refresh in the background.
    defsRefreshing.add(mcpUrl);
    const work = turn.conn
      .token()
      .then((read) => (read.ok ? list(read.access) : undefined))
      .catch(() => undefined)
      .finally(() => defsRefreshing.delete(mcpUrl));
    turn.ctx.background?.(work);
  }
  const session = new AsksSession(turn);
  return defs.map((def) => connectorTool(turn, session, def));
}

/* ── the plugin's own tools ────────────────────────────────────────────── */

const accountWords = (account?: string): string =>
  account ? ` as ${shortAccount(account)}` : '';

const surfaceOf = (ctx: RuntimeContext): Surface =>
  ctx.session.client === 'channel' &&
  ctx.session.channel?.provider === 'whatsapp'
    ? 'whatsapp'
    : 'chat';

function connectTool(turn: AsksTurn): PluginTool {
  return {
    name: 'asks_connect',
    description:
      'Start the one-time asks.world sign-in (Google, on asks.world). Gives a link to send the person; they sign in there and come back. Use when asks is not connected or a tool says the sign-in ended.',
    schema: z.object({}),
    handler: async () => {
      const now = await turn.conn.status();
      if (now.connected) {
        await markSeen(turn, { status: 'connected' });
        return `asks.world is already connected for this person${accountWords(now.account)}.`;
      }
      const { link, expiresAt } = await turn.conn.begin(
        turn.ctx.user.did,
        surfaceOf(turn.ctx),
      );
      await markSeen(turn, { status: 'pending', until: expiresAt });
      return [
        'Send the person this link in your final message, on its own line:',
        link,
        'They sign in with Google on asks.world with the same account they use here; it is for them only, works once and lasts 15 minutes. A sign-in with another account is refused. Ask them to tell you when it says "asks is connected". Do not call other asks tools until then.',
      ].join('\n');
    },
  };
}

function statusTool(turn: AsksTurn): PluginTool {
  return {
    name: 'asks_status',
    description:
      'Whether asks.world is connected for this person, or a sign-in is waiting.',
    schema: z.object({}),
    effect: 'read',
    handler: async () => {
      const { connected, pending, account } = await turn.conn.status();
      if (connected) {
        await markSeen(turn, { status: 'connected' });
        return `asks.world is connected${accountWords(account)}. Its tools work from the next message on.`;
      }
      if (!pending) await markSeen(turn, null);
      return pending
        ? 'Not connected yet: the sign-in link is still waiting to be used.'
        : 'Not connected. Call asks_connect for a sign-in link.';
    },
  };
}

function disconnectTool(turn: AsksTurn): PluginTool {
  return {
    name: 'asks_disconnect',
    description:
      'Disconnect asks.world for this person: the sign-in is revoked at asks.world and forgotten here. Only when they ask.',
    schema: z.object({}),
    handler: async () => {
      await turn.conn.disconnect();
      await markSeen(turn, null);
      return 'asks.world is disconnected. Nothing was posted or spent.';
    },
  };
}

function attachTool(turn: AsksTurn): PluginTool {
  return {
    name: 'asks_attach_files',
    description:
      "Attach files the person sent in this chat (PNG, JPG, WebP or PDF, up to 5 MB each, 10 at most) to an answer drafted with submit_work, or the photo for their pro page from set_my_page, before they open its link. Pass the draft (ad_…) and the files' channel references (channel:…); for a report or a form, name each file with the file id the answer expects (e.g. a finding's evidence id). The person checks them on the page and sends from there.",
    schema: z.object({
      draft: z
        .string()
        .regex(/^ad_[A-Za-z0-9_-]{22}$/)
        .describe('The draft submit_work or set_my_page gave (ad_…).'),
      files: z
        .array(
          z.object({
            file: z
              .string()
              .regex(/^channel:[0-9a-f]{16}$/)
              .describe('A file the person sent: channel:<16 hex>.'),
            name: z
              .string()
              .regex(/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/)
              .optional()
              .describe(
                "The file id the answer names for it, without an extension. Leave out for a words answer's one file.",
              ),
          }),
        )
        .min(1)
        .max(10),
    }),
    handler: async (args) => {
      const { draft, files } = args as {
        draft: string;
        files: Array<{ file: string; name?: string }>;
      };
      const address = await turn.conn.uploadOf(draft);
      if (!address) {
        return 'No upload address is kept for that answer: it lasts an hour and closes once the person opens the page. The person adds the files on the answer page.';
      }
      const lines: string[] = [];
      const sentAs: string[] = [];
      for (const { file, name } of files) {
        const kept = (await turn.ctx.kv
          ?.get(FILES_NS, file)
          .catch(() => undefined)) as KeptFile | undefined;
        const sent = kept
          ? await sendFile({
              file: kept,
              name,
              address,
              origins: turn.channelOrigins,
              fetch: turn.fetch,
            })
          : {
              ok: false as const,
              why: 'Not a file the person sent in this chat in the last 7 days.',
            };
        if (sent.ok) sentAs.push(sent.as);
        else lines.push(`- ${file}: ${sent.why}`);
      }
      // asks checks what landed (size, type, names): its verdict is the count.
      const check =
        sentAs.length > 0 ? await checkDraftUploads(turn.fetch, address) : null;
      const refused =
        check?.ok === true
          ? sentAs.filter((one) => check.refused.includes(one))
          : [];
      const attached = sentAs.length - refused.length;
      return [
        `Attached ${attached} of ${files.length} file${files.length === 1 ? '' : 's'}.`,
        ...lines,
        refused.length > 0
          ? `asks refused ${refused.length} after checking them: ${refused.join(', ')}. The person adds those on the page.`
          : '',
        check?.ok === true && check.missing.length > 0
          ? `Still missing for this answer (${check.missing.length}): ${check.missing.join(', ')}.`
          : '',
        check?.ok === false
          ? 'asks could not check the files just now; the answer page shows what arrived.'
          : '',
        attached > 0
          ? 'The person sees them on the answer page and sends from there.'
          : '',
      ]
        .filter(Boolean)
        .join('\n');
    },
  };
}

/** How the skills are written vs. how they work in this chat. */
const SKILL_NOTE =
  'This skill is written for chat assistants with the asks plugin. Here: signing in is asks_connect; files from this chat go with asks_attach_files; the asks tools are named asks__<tool>; there is no plugin to install, update or switch, and this chat uses one network only.';

export function skillTool(skills: readonly Skill[]): PluginTool {
  return {
    name: 'asks_skill',
    description: [
      'Read one asks.world skill: the how-to for one kind of task. Read the one that fits before acting (unless this turn already has it). The skills:',
      ...skills.map((one) => `- ${one.name}: ${one.description}`),
    ].join('\n'),
    schema: z.object({
      name: z.string().describe('The skill name, from the list.'),
    }),
    effect: 'read',
    handler: async (args) => {
      const { name } = args as { name: string };
      const skill = skills.find(
        (one) => one.name === name.trim().toLowerCase(),
      );
      return skill
        ? `${SKILL_NOTE}\n\n${skill.text}`
        : `No asks skill is called "${name}". The skills: ${skills.map((one) => one.name).join(', ')}.`;
    },
  };
}

/** The text a preloaded skill adds to this turn's system prompt. */
export const preloadText = (skill: Skill): string =>
  `\n\n### asks skill for this message: ${skill.name}\n${SKILL_NOTE}\n\n${skill.text}`;

/** Every asks tool for this turn. */
export async function asksTools(turn: AsksTurn): Promise<PluginTool[]> {
  const base = [connectTool(turn), statusTool(turn), skillTool(turn.skills)];
  if (!(await isConnected(turn))) return base;
  const remote = await connectorTools(turn).catch((error: unknown) => {
    turn.ctx.logger.warn(
      `[asks] connector tools unavailable this turn: ${String(error)}`,
    );
    return [];
  });
  if (remote === null) return base;
  return [...base, disconnectTool(turn), attachTool(turn), ...remote];
}

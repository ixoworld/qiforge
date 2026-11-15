import { type MCPAdapterConfig } from '@langchain/mcp-adapters';
import { withCallTimeout } from '../mcp-call-timeout';
import { mcpAdapterConfig } from '../mcp-tool-adapter';
import { z } from 'zod';
import { deliversAttachments } from '../../delivery/prompt';
import { OraclePlugin, type PluginEnv } from '../../plugin-api/oracle-plugin';
import type {
  PluginManifest,
  PluginTool,
  RuntimeContext,
} from '../../plugin-api/types';
import {
  defaultSandboxMcpClientFactory,
  SANDBOX_MCP_TIMEOUT_MS,
} from './sandbox-bridge';
import {
  createDefaultAuthBuilder,
  parseOracleSecrets,
  type SandboxAuthBuilder,
} from './sandbox-mcp';
import { createSandboxWriteBlobTool } from './sandbox-write-blob';
import {
  buildSendFileTool,
  CHAT_URL_NOTE,
  PRESIGNED_URL_TOOL,
  stripArtifactUrls,
  URL_RESULT_TOOLS,
} from './send-file';
import { SANDBOX_CAPABILITY } from '../delegated-capabilities';

/**
 * Env this plugin owns. Unlike the Node runtime — whose Tier-0 base schema
 * declared `ORACLE_SECRETS` — the Workers base env schema deliberately omits
 * it, and unknown keys are stripped from the validated config. Declaring it
 * here (optional) makes the sandbox plugin its owner so the `x-os-*` headers
 * keep working.
 */
const configSchema = z.object({
  SANDBOX_MCP_URL: z.string().url(),
  /** Operator secrets injected as `x-os-*` headers: `KEY1=v1,KEY2=v2`. */
  ORACLE_SECRETS: z.string().optional(),
});

/**
 * Sibling env vars the plugin reads at boot but does not own:
 * `SKILLS_CAPSULES_BASE_URL` is owned by the skills plugin. When set, the
 * sandbox plugin mints a parallel `ixo:skills` invocation and forwards it
 * as `X-Skills-Invocation` so the sandbox can call the skills service on
 * the user's behalf. Optional — a missing value simply skips the header.
 */
const siblingEnvSchema = z.object({
  SKILLS_CAPSULES_BASE_URL: z.string().url().optional(),
});

// In the guide and not in the summary: an `always` host would pay for it in
// the capability block on top of the tool descriptions, and a preload delivers
// a guide but not the manifest.
const OPERATING_GUIDE = [
  '### Sandbox',
  '- `sandbox_run` writes anywhere through the shell, `/tmp` included. `sandbox_write_file` writes raw bytes under `/workspace/data/` only: paths like `/tmp/...` or `/workspace/tmp/...` are rejected.',
  "- A file at a path the user names belongs in their library (`vfs`), not here. Report the path you really wrote: `/workspace/data/...` is the box, not the user's `/...`.",
  '- The box is a scratch disk, not your file store. Files under `/workspace/data/` are pushed up to durable storage after each call, but nothing comes back down automatically and the box is wiped after a few idle minutes. Any file not created in the current call must be fetched with `load_artifact` before you can read it.',
].join('\n');

const manifest: PluginManifest = {
  title: 'Sandbox',
  summary:
    'Per-user Linux box: `sandbox_run` runs shell or python, `sandbox_write_file` writes under `/workspace/data/`.',
  whenToUse: [
    "Execute a skill — call `sandbox_run` with `cid` so host-approved user secrets and oracle secrets are injected; the skill folder mounts read-only at `/workspace/skills/<skill-name>/` (use the absolute paths from `load_skill`'s `skillFiles`).",
    'Read a skill file (SKILL.md, scripts, configs) — call `sandbox_run` with `cid` and shell: `cat /workspace/skills/<skill-name>/SKILL.md`, `ls /workspace/skills/<skill-name>/`, `grep -r "<pattern>" /workspace/skills/<skill-name>/`, or `sed -n "1,80p" <file>` for a line range. There is no dedicated `read_skill` tool.',
    'Hit a JSON/REST API — write curl or python in `sandbox_run`. Never use a web scraper for `/api/`, `/v1/`, `/v2/`, `/v3/` endpoints.',
    'Generate or transform a file the user (or a later turn) will re-read — write it to `/workspace/data/output/<name>` (alias `/workspace/output/`). It is pushed to durable storage after the call; a later turn must `load_artifact` it back before reading.',
    'Re-read ANY file you did not create in this same call — an attachment the user sent earlier, output from a previous turn, anything `artifact_list` shows — call `load_artifact` with its path FIRST, then read it with `sandbox_run`. Do not assume it is still on disk: the box is recycled after a few idle minutes and comes back empty.',
    'An `ls`/`find` under `/workspace/data/` came back empty — that means the container is FRESH, not that your files were lost. They are safe in durable storage. Call `artifact_list` to see them and `load_artifact` to pull one back. Never report a file as missing or re-generate it based on an empty directory listing alone.',
    'Save a large or escape-sensitive blob (multi-line markdown, structured data) byte-perfect to `/workspace/data/...` — use `sandbox_write_file` so quoting bugs do not corrupt it.',
    "Write a scratch / throwaway file (build artefacts, temp scripts you will execute then delete) — use `sandbox_run` with a here-doc: `cat > /tmp/<name> <<'EOF'\\n<content>\\nEOF`. Never use `sandbox_write_file` for `/tmp` or anywhere outside `/workspace/data/` — it will be rejected.",
    'Always check the result envelope: `success === true` AND `exitCode === 0` before trusting `output`. On failure, READ the `error` text and change your approach — do not retry the same call with the same args.',
  ],
  whenNotToUse: [
    'Saving a file at a path the user names: that is their library, use `vfs`.',
    'The value is already inline in chat — just use it; opening the sandbox to echo it back wastes a turn.',
    'Fetching a URL the user just mentioned — prefer `process_file`, which archives it as an artifact (pull it into the box with `load_artifact` when you need to read it).',
    'A long human-readable page (blog, article, news) — use the Firecrawl agent.',
    'Installing native deps in cwd (`pip install -e .`, `bun install`) — `.venv`/`node_modules` get uploaded to R2 by the post-run sync, bloating storage and slowing every subsequent call (they are NOT restored for you, so it buys nothing). Install under `/tmp` (via `sandbox_run`) or inside the skill folder.',
    '`sandbox_write_file` with a path outside `/workspace/data/` (e.g. `/tmp/foo`, `/workspace/tmp/foo`, `/workspace/output-only-if-data-prefix-missing`) — the validator hard-rejects this. For temp/scratch writes, switch to `sandbox_run`.',
  ],
  examples: [
    {
      user: "Read the pptx skill's instructions before generating slides.",
      thought:
        "After `load_skill`, the SKILL.md path is the absolute path the response returned (e.g. /workspace/skills/pptx/SKILL.md). Cat it directly through sandbox_run — there's no separate read tool. Pass `cid` so the same skill context is in place.",
      tool: 'sandbox_run',
      args: {
        code: 'cat /workspace/skills/pptx/SKILL.md',
        cid: 'cid returned by list_skills / search_skills',
      },
    },
    {
      user: 'Run the price-forecast skill on the Q3 sales data.',
      thought:
        'The CSV came from an earlier turn, so it is in durable storage but almost certainly NOT on the box — pull it down first. Then run the skill with its CID so host-approved user secrets and oracle secrets are injected, and write the forecast to /workspace/data/output/ so it is archived for later.',
      tool: 'load_artifact',
      args: {
        path: '/output/q3-sales.csv',
      },
    },
    {
      user: '(same turn, after load_artifact returned the absolute path)',
      thought:
        'Now the file really is on disk at /workspace/data/output/q3-sales.csv — safe to read it.',
      tool: 'sandbox_run',
      args: {
        code: 'cd /workspace/skills/price-forecast && bash run.sh "/workspace/data/output/q3-sales.csv" > /workspace/data/output/forecast.json',
        cid: 'cid from list/search skills',
      },
    },
    {
      user: 'Compute monthly totals from the CSV I attached.',
      thought:
        'The attachment was archived as an artifact, not left on the box. load_artifact it first (artifact_list if I do not know the exact path), THEN compute. Use uv (preferred over pip in this sandbox) to materialize pandas. Write the result so the user can reuse it next turn.',
      tool: 'sandbox_run',
      args: {
        code: "uv run --with pandas python -c \"import pandas as pd, json; df=pd.read_csv('/workspace/data/output/sales.csv'); out=df.groupby('month').sum().reset_index(); out.to_csv('/workspace/data/output/monthly_totals.csv', index=False); print(json.dumps({'rows': len(out)}))\"",
      },
    },
    {
      user: 'Where did the chart you made yesterday go? The folder looks empty.',
      thought:
        'An empty /workspace/data/output means the container was recycled, NOT that the file is gone. Do not re-generate it and do not tell the user it was lost. List what is actually in durable storage, then pull the one I need back down.',
      tool: 'artifact_list',
      args: {},
    },
    {
      user: 'Save this draft report so I can come back to it tomorrow.',
      thought:
        'Multi-line markdown with quotes and code fences → write byte-perfect via sandbox_write_file (no shell-escaping). Writing under /workspace/data archives it durably — tomorrow it will need a load_artifact to come back onto the box.',
      tool: 'sandbox_write_file',
      args: {
        path: '/workspace/data/output/draft-report.md',
        content: '# Q3 Report\n\n## Findings\n\n...',
      },
    },
    {
      user: 'Build a one-off JS script to transform some data and run it.',
      thought:
        'Scratch script — runs once, then discarded. /tmp is the right home, but sandbox_write_file refuses anything outside /workspace/data/. Use sandbox_run with a here-doc to write + execute in one shot.',
      tool: 'sandbox_run',
      args: {
        code: "cat > /tmp/transform.js <<'EOF'\nconst fs = require('fs');\nconst rows = JSON.parse(fs.readFileSync('/workspace/data/output/data.json'));\nconsole.log(JSON.stringify(rows.map(r => ({...r, normalized: r.value / 100}))));\nEOF\nnode /tmp/transform.js > /workspace/data/output/transformed.json",
      },
    },
  ],
  // Every tool loads together: running code, its files and artifacts and the
  // skill lifecycle (`load_skill` included) depend on one another. A host
  // that wants it on every turn sets `visibility: 'always'` through
  // `manifestOverrides`.
  visibility: 'on-demand',
  brief: 'run code; run or publish skills; generate charts and reports',
  stability: 'stable',
  category: 'core',
  tags: ['sandbox', 'execution', 'workspace', 'artifacts'],
  requires: [SANDBOX_CAPABILITY],
};

/** Minimal MCP-client surface — declared structurally so tests can stub it. */
export interface SandboxMcpClientLike {
  getTools(): Promise<SandboxMcpTool[]>;
  close(): Promise<void>;
}

/** Shape of one upstream MCP tool (schema normalised to Zod). */
export interface SandboxMcpTool {
  name: string;
  description: string;
  schema: z.ZodType;
  invoke(input: unknown): Promise<unknown>;
}

export type SandboxMcpClientFactory = (
  config: MCPAdapterConfig,
) => SandboxMcpClientLike;

/**
 * Trusted host decision for the room secrets one sandbox invocation needs.
 * Tool input is model-controlled and may inform the decision, but it must not
 * be treated as approval: implementations must consult a host-owned consent or
 * policy record before returning a secret name. Without an authorizer, room
 * secrets are never read or forwarded.
 */
export type SandboxUserSecretAuthorizer = (request: {
  readonly toolName: string;
  readonly input: unknown;
  readonly context: RuntimeContext;
}) => readonly string[] | Promise<readonly string[]>;

export interface SandboxPluginOptions {
  /**
   * Override the auth header builder. Tests inject a stub here to skip the
   * did:web resolution + UCAN mint; production code lets the default builder
   * do the network work.
   */
  authBuilder?: SandboxAuthBuilder;
  /**
   * Override the MCP-client constructor. Tests inject a stub so they can
   * intercept the headers the plugin sends and the tools it gets back without
   * standing up a real `MCPAdapter`.
   */
  mcpClientFactory?: SandboxMcpClientFactory;
  /**
   * Return the room-secret names approved for one invocation. The callback is
   * a trusted security boundary and must verify host-owned consent rather than
   * accepting names from model-controlled tool input. Defaults to no secrets.
   */
  authorizeUserSecrets?: SandboxUserSecretAuthorizer;
  /**
   * Opt-in to the upstream `oracle_*` management tools (`oracle_list`,
   * `oracle_get`, `oracle_health`, `oracle_stop`, `oracle_restart`,
   * `oracle_get_logs`). Off by default — these are operator-grade controls
   * that most user-facing oracles should not surface to the agent. Flip this
   * on for admin / dev-tooling oracles.
   */
  includeOracleManagementTools?: boolean;
}

/** Prefix the upstream sandbox MCP uses for operator-grade oracle controls. */
const ORACLE_MANAGEMENT_TOOL_PREFIX = 'oracle_';

/**
 * Upstream tool *definition* — the user-independent slice of a
 * {@link SandboxMcpTool}. Auth (UCAN invocation + secret headers) is applied
 * per request at invoke time, so definitions are safe to share.
 */
type SandboxToolDef = Pick<SandboxMcpTool, 'name' | 'description' | 'schema'>;

interface CachedSandboxDefs {
  defs: SandboxToolDef[];
  expiresAt: number;
}

/**
 * Definitions change only on upstream deploys; a short TTL keeps them fresh
 * while removing the per-turn secrets fetch + MCP connect + tools/list chain
 * from the chat hot path.
 */
const SANDBOX_TOOL_DEFS_TTL_MS = 5 * 60 * 1000;

/**
 * Sandbox plugin.
 *
 * Surfaces every upstream sandbox MCP tool — `sandbox_run`, `sandbox_write_file`,
 * the `artifact_*` family, `load_skill`, and the `oracle_*`
 * management tools — to the main agent. Each tool flows through verbatim
 * (name, description, schema all from upstream); the plugin's only job is to
 * authenticate the MCP connection and forward operator secrets plus any room
 * secrets a trusted host policy approves for the specific invocation.
 *
 * Each MCP connection's headers include:
 *   - `Authorization: Bearer <ixo:sandbox UCAN invocation>` + `X-Auth-Type: ucan`
 *   - `X-Skills-Invocation` (when `SKILLS_CAPSULES_BASE_URL` is configured)
 *   - `x-os-<name>` for each entry in `ORACLE_SECRETS`
 *   - `x-us-<name>` only for room secrets approved by `authorizeUserSecrets`
 *
 * Tools are discovered per request via {@link getRequestTools} because the
 * MCP client has to be authenticated as the in-flight user.
 *
 * On a chat surface the model cannot hold a signed link: the upstream
 * `artifact_get_presigned_url` is replaced by `send_file`, and the URL fields
 * of the other `artifact_*` lookups are removed. Portal and every other
 * surface get the upstream tools unchanged.
 */
export class SandboxPlugin extends OraclePlugin {
  /**
   * Static handle other plugins use to test `availablePlugins.has(...)`
   * without hardcoding the string. Mirrors the precedent set by `MemoryPlugin`.
   */
  static readonly NAME = 'sandbox';

  readonly name = SandboxPlugin.NAME;
  readonly version = '1.0.0';
  readonly manifest = manifest;
  override readonly operatingGuide = OPERATING_GUIDE;
  override readonly configSchema = configSchema;
  override readonly autoDetectHint = 'SANDBOX_MCP_URL';

  private readonly authBuilder: SandboxAuthBuilder;
  private readonly mcpClientFactory: SandboxMcpClientFactory;
  private readonly authorizeUserSecrets: SandboxUserSecretAuthorizer | null;
  private readonly includeOracleManagementTools: boolean;

  constructor(opts: SandboxPluginOptions = {}) {
    super();
    this.authBuilder = opts.authBuilder ?? createDefaultAuthBuilder();
    // Shared with the bridge: a cast-free wrapper that keeps `close()`
    // reachable — a cast of the raw adapter client made every connect
    // unclosable.
    this.mcpClientFactory =
      opts.mcpClientFactory ?? defaultSandboxMcpClientFactory;
    this.authorizeUserSecrets = opts.authorizeUserSecrets ?? null;
    this.includeOracleManagementTools =
      opts.includeOracleManagementTools ?? false;
  }

  override autoDetect(env: PluginEnv): boolean {
    return (
      typeof env.SANDBOX_MCP_URL === 'string' && env.SANDBOX_MCP_URL.length > 0
    );
  }

  /** Cached upstream tool definitions, keyed by sandbox MCP URL. */
  private readonly toolDefsCache = new Map<string, CachedSandboxDefs>();

  /**
   * URLs with a background definition refresh in flight — guards a burst of
   * turns from each spawning its own connect when an entry expires.
   */
  private readonly defsRefreshInFlight = new Set<string>();

  override async getRequestTools(rtCtx: RuntimeContext): Promise<PluginTool[]> {
    const parsed = configSchema.safeParse(rtCtx.config);
    if (!parsed.success) {
      throw new Error(
        `sandbox: invalid configuration: ${parsed.error.issues
          .map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`)
          .join('; ')}`,
      );
    }

    const siblings = siblingEnvSchema.safeParse(rtCtx.config);
    const skillsServiceUrl = siblings.success
      ? siblings.data.SKILLS_CAPSULES_BASE_URL
      : undefined;

    const oracleSecrets = parseOracleSecrets(parsed.data.ORACLE_SECRETS ?? '');
    const sandboxMcpUrl = parsed.data.SANDBOX_MCP_URL;

    const cached = this.toolDefsCache.get(sandboxMcpUrl);
    if (cached) {
      // Warm path — definitions are known, so skip the per-turn secrets
      // fetch and MCP connect. The auth *gate* still runs every request:
      // minting is local (service-DID resolution is cached upstream), so an
      // unauthorized user sees no sandbox tools, exactly as before. An
      // expired entry is served as-is (definitions only change on upstream
      // deploys) while a background refresh re-snapshots it, so TTL expiry
      // never puts the secrets fetch + connect chain back on a chat turn.
      const gateHeaders = await this.authBuilder(
        { sandboxMcpUrl, skillsServiceUrl, oracleSecrets: {}, userSecrets: {} },
        rtCtx,
      );
      if (!gateHeaders.Authorization) {
        rtCtx.logger.log(
          '[sandbox] skipping — no UCAN invocation (user not authorized); not connecting to the sandbox MCP server.',
        );
        return [];
      }
      if (
        cached.expiresAt <= Date.now() &&
        !this.defsRefreshInFlight.has(sandboxMcpUrl)
      ) {
        this.defsRefreshInFlight.add(sandboxMcpUrl);
        void this.connectWithHeaders(
          {
            sandboxMcpUrl,
            skillsServiceUrl,
            oracleSecrets,
            rtCtx,
          },
          {},
        )
          .then(async ({ client, tools }) => {
            // Defs are plain data — the refresh connection has nothing left
            // to serve once they're snapshotted.
            await client.close().catch(() => undefined);
            this.toolDefsCache.set(sandboxMcpUrl, {
              defs: tools.map(({ name, description, schema }) => ({
                name,
                description,
                schema,
              })),
              expiresAt: Date.now() + SANDBOX_TOOL_DEFS_TTL_MS,
            });
          })
          .catch((err: unknown) => {
            // Keep serving the stale defs; the next expired-cache turn
            // retries the refresh.
            rtCtx.logger.warn(
              `[sandbox] background tool-defs refresh failed: ${err instanceof Error ? err.message : String(err)}`,
            );
          })
          .finally(() => {
            this.defsRefreshInFlight.delete(sandboxMcpUrl);
          });
      }
      const lazyUpstream = this.buildLazyUpstreamTools(cached.defs, {
        sandboxMcpUrl,
        skillsServiceUrl,
        oracleSecrets,
        rtCtx,
      });
      return this.toPluginTools(lazyUpstream, rtCtx);
    }

    const headers = await this.authBuilder(
      {
        sandboxMcpUrl,
        skillsServiceUrl,
        oracleSecrets,
        userSecrets: {},
      },
      rtCtx,
    );

    // No UCAN invocation could be minted (the user hasn't authorized) → the
    // sandbox MCP server would reject us with 401. Skip connecting entirely
    // and contribute no tools, rather than letting the auth error crash the
    // turn. Mirrors composio/memory's graceful degradation.
    if (!headers.Authorization) {
      rtCtx.logger.log(
        '[sandbox] skipping — no UCAN invocation (user not authorized); not connecting to the sandbox MCP server.',
      );
      return [];
    }

    const client = this.mcpClientFactory(
      mcpAdapterConfig('sandbox', {
        url: sandboxMcpUrl,
        headers,
        toolNames: 'bare',
      }),
    );

    // The cold path only needs the definitions: close the listing client and
    // bind lazy tools, so the first actual invocation reconnects exactly like
    // the warm path — no connection outlives the listing.
    let upstream: SandboxMcpTool[];
    try {
      upstream = await client.getTools();
    } finally {
      await client.close().catch(() => undefined);
    }
    const defs = upstream.map(({ name, description, schema }) => ({
      name,
      description,
      schema,
    }));
    this.toolDefsCache.set(sandboxMcpUrl, {
      defs,
      expiresAt: Date.now() + SANDBOX_TOOL_DEFS_TTL_MS,
    });

    return this.toPluginTools(
      this.buildLazyUpstreamTools(defs, {
        sandboxMcpUrl,
        skillsServiceUrl,
        oracleSecrets,
        rtCtx,
      }),
      rtCtx,
    );
  }

  /**
   * Bind cached definitions to lazily-connected upstream tools. Every actual
   * invocation gets a short-lived connection carrying only the room secrets
   * approved for that tool and input. Discovery connections carry none, and
   * turns that never call the sandbox pay zero invocation round-trips.
   */
  private buildLazyUpstreamTools(
    defs: SandboxToolDef[],
    args: {
      sandboxMcpUrl: string;
      skillsServiceUrl: string | undefined;
      oracleSecrets: Record<string, string>;
      rtCtx: RuntimeContext;
    },
  ): SandboxMcpTool[] {
    return defs.map((def) => ({
      name: def.name,
      description: def.description,
      schema: def.schema,
      invoke: async (input: unknown) => {
        const userSecrets = await this.getAuthorizedUserSecrets(
          def.name,
          input,
          args.rtCtx,
        );
        const { client, tools } = await this.connectWithHeaders(
          args,
          userSecrets,
        );
        let closePromise: Promise<void> | null = null;
        const closeClient = (): Promise<void> => {
          closePromise ??= client.close().catch(() => undefined);
          return closePromise;
        };
        try {
          const upstream = tools.find((tool) => tool.name === def.name);
          if (!upstream) {
            throw new Error(
              `sandbox MCP no longer exposes "${def.name}" — cached definition is stale, retry shortly.`,
            );
          }
          return await withCallTimeout(
            () => upstream.invoke(input),
            SANDBOX_MCP_TIMEOUT_MS,
            `sandbox tool ${def.name}`,
            closeClient,
          );
        } finally {
          await closeClient();
        }
      },
    }));
  }

  private async getAuthorizedUserSecrets(
    toolName: string,
    input: unknown,
    context: RuntimeContext,
  ): Promise<Record<string, string>> {
    if (!this.authorizeUserSecrets) return {};
    const approved = await this.authorizeUserSecrets({
      toolName,
      input,
      context,
    });
    const names = [...new Set(approved)];
    if (names.length === 0) return {};
    const values = await context.secrets.getValues(names);
    const allowed = new Set(names);
    return Object.fromEntries(
      Object.entries(values).filter(([name]) => allowed.has(name)),
    );
  }

  private async connectWithHeaders(
    args: {
      sandboxMcpUrl: string;
      skillsServiceUrl: string | undefined;
      oracleSecrets: Record<string, string>;
      rtCtx: RuntimeContext;
    },
    userSecrets: Record<string, string>,
  ): Promise<{ client: SandboxMcpClientLike; tools: SandboxMcpTool[] }> {
    const { sandboxMcpUrl, skillsServiceUrl, oracleSecrets, rtCtx } = args;

    const headers = await this.authBuilder(
      { sandboxMcpUrl, skillsServiceUrl, oracleSecrets, userSecrets },
      rtCtx,
    );
    if (!headers.Authorization) {
      throw new Error(
        'sandbox: no UCAN invocation could be minted for this call — the user is not authorized.',
      );
    }

    const client = this.mcpClientFactory(
      mcpAdapterConfig('sandbox', {
        url: sandboxMcpUrl,
        headers,
        toolNames: 'bare',
      }),
    );
    try {
      const tools = await client.getTools();
      return { client, tools };
    } catch (error) {
      await client.close().catch(() => undefined);
      throw error;
    }
  }

  /**
   * Shared tail of both paths: visibility filter, chat-surface file delivery,
   * PluginTool mapping, and the synthetic `sandbox_write_blob` companion.
   */
  private toPluginTools(
    upstream: SandboxMcpTool[],
    rtCtx: RuntimeContext,
  ): PluginTool[] {
    const filtered = this.includeOracleManagementTools
      ? upstream
      : upstream.filter(
          (t) => !t.name.startsWith(ORACLE_MANAGEMENT_TOOL_PREFIX),
        );

    const surface = rtCtx.session.surface;
    const chat = surface?.kind === 'chat';
    const upstreamTools: PluginTool[] = filtered
      .filter((tool) => !chat || tool.name !== PRESIGNED_URL_TOOL)
      .map((tool) =>
        chat && URL_RESULT_TOOLS.has(tool.name)
          ? {
              name: tool.name,
              description: `${tool.description} ${CHAT_URL_NOTE}`,
              schema: tool.schema,
              handler: async (args) =>
                stripArtifactUrls(await tool.invoke(args)),
            }
          : {
              name: tool.name,
              description: tool.description,
              schema: tool.schema,
              handler: async (args) => tool.invoke(args),
            },
      );

    const presignTool = filtered.find((t) => t.name === PRESIGNED_URL_TOOL);
    if (chat && presignTool)
      upstreamTools.push(
        buildSendFileTool(presignTool, deliversAttachments(surface.surface)),
      );

    // sandbox_write_blob — companion to mint_invocation. Synthetic wrapper
    // that takes a server-stored blobId + a sandbox path, looks the value up
    // server-side, and forwards it to sandbox_write_file. Only registered
    // when sandbox_write_file is present in the upstream toolset AND the
    // request has a known user DID (the blob store is user-DID-namespaced).
    const sandboxWriteFileTool = filtered.find(
      (t) => t.name === 'sandbox_write_file',
    );
    if (sandboxWriteFileTool && rtCtx.user.did) {
      upstreamTools.push(createSandboxWriteBlobTool({ sandboxWriteFileTool }));
    }

    return upstreamTools;
  }
}

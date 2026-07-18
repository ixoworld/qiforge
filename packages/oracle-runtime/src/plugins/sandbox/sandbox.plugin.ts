import {
  MultiServerMCPClient,
  type ClientConfig,
} from '@langchain/mcp-adapters';
import { z } from 'zod';
import { OraclePlugin } from '../../plugin-api/oracle-plugin.js';
import type {
  PluginManifest,
  PluginTool,
  RuntimeContext,
} from '../../plugin-api/types.js';
import {
  createDefaultAuthBuilder,
  parseOracleSecrets,
  type SandboxAuthBuilder,
} from './sandbox-mcp.js';
import { createSandboxWriteBlobTool } from './sandbox-write-blob.js';

const configSchema = z.object({
  SANDBOX_MCP_URL: z.url(),
});

/**
 * Sibling env vars the plugin reads at boot but does not own:
 *
 * - `ORACLE_SECRETS` is declared in the core (Tier-0) base env schema; the
 *   sandbox plugin parses it and injects each entry as an `x-os-*` header.
 * - `SKILLS_CAPSULES_BASE_URL` is owned by the skills plugin. When set, the
 *   sandbox plugin mints a parallel `ixo:skills` invocation and forwards it
 *   as `X-Skills-Invocation` so the sandbox can call the skills service on
 *   the user's behalf.
 *
 * Both fields are optional — a missing value simply skips the matching
 * header instead of failing the plugin build.
 */
const siblingEnvSchema = z.object({
  ORACLE_SECRETS: z.string().optional(),
  SKILLS_CAPSULES_BASE_URL: z.url().optional(),
});

const manifest: PluginManifest = {
  title: 'Sandbox',
  summary:
    'Per-user Linux box for code execution. `sandbox_run` runs shell/python (writes anywhere via shell — incl. `/tmp` for scratch). `sandbox_write_file` writes raw bytes BUT only under `/workspace/data/` — paths like `/tmp/...` or `/workspace/tmp/...` are rejected; use `sandbox_run` for those.',
  whenToUse: [
    "Execute a skill — call `sandbox_run` with `cid` so user + oracle secrets are injected; the skill folder mounts read-only at `/workspace/skills/<skill-name>/` (use the absolute paths from `load_skill`'s `skillFiles`).",
    'Read a skill file (SKILL.md, scripts, configs) — call `sandbox_run` with `cid` and shell: `cat /workspace/skills/<skill-name>/SKILL.md`, `ls /workspace/skills/<skill-name>/`, `grep -r "<pattern>" /workspace/skills/<skill-name>/`, or `sed -n "1,80p" <file>` for a line range. There is no dedicated `read_skill` tool.',
    'Hit a JSON/REST API — write curl or python in `sandbox_run`. Never use a web scraper for `/api/`, `/v1/`, `/v2/`, `/v3/` endpoints.',
    'Generate or transform a file the user (or a later turn) will re-read — write it to `/workspace/data/output/<name>` (alias `/workspace/output/`).',
    'Re-read an attachment the user sent earlier — it was auto-archived to `/workspace/output/<filename>`; load from there.',
    'Save a large or escape-sensitive blob (multi-line markdown, structured data) byte-perfect to `/workspace/data/...` — use `sandbox_write_file` so quoting bugs do not corrupt it.',
    "Write a scratch / throwaway file (build artefacts, temp scripts you will execute then delete) — use `sandbox_run` with a here-doc: `cat > /tmp/<name> <<'EOF'\\n<content>\\nEOF`. Never use `sandbox_write_file` for `/tmp` or anywhere outside `/workspace/data/` — it will be rejected.",
    'Always check the result envelope: `success === true` AND `exitCode === 0` before trusting `output`. On failure, READ the `error` text and change your approach — do not retry the same call with the same args.',
  ],
  whenNotToUse: [
    'The value is already inline in chat — just use it; opening the sandbox to echo it back wastes a turn.',
    'Fetching a URL the user just mentioned — prefer `process_file` so it auto-archives to `/workspace/output/`.',
    'A long human-readable page (blog, article, news) — use the Firecrawl agent.',
    'Installing native deps in cwd (`pip install -e .`, `bun install`) — `.venv`/`node_modules` get persisted to R2 and slow every future session. Install under `/tmp` (via `sandbox_run`) or inside the skill folder.',
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
        'Skill execution → pass the skill CID so user + oracle secrets are injected. Write the forecast to /workspace/data/output/ so the user can re-read it next turn.',
      tool: 'sandbox_run',
      args: {
        code: 'cd /workspace/skills/price-forecast && bash run.sh "/workspace/output/q3-sales.csv" > /workspace/data/output/forecast.json',
        cid: 'cid from list/search skills',
      },
    },
    {
      user: 'Compute monthly totals from the CSV I attached.',
      thought:
        'The attachment is at /workspace/output/<filename>. Use uv (preferred over pip in this sandbox) to materialize pandas. Write the result so the user can reuse it next turn.',
      tool: 'sandbox_run',
      args: {
        code: "uv run --with pandas python -c \"import pandas as pd, json; df=pd.read_csv('/workspace/output/sales.csv'); out=df.groupby('month').sum().reset_index(); out.to_csv('/workspace/data/output/monthly_totals.csv', index=False); print(json.dumps({'rows': len(out)}))\"",
      },
    },
    {
      user: 'Save this draft report so I can come back to it tomorrow.',
      thought:
        'Multi-line markdown with quotes and code fences → write byte-perfect via sandbox_write_file (no shell-escaping). Persisted under /workspace/data so it survives across sessions.',
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
        code: "cat > /tmp/transform.js <<'EOF'\nconst fs = require('fs');\nconst rows = JSON.parse(fs.readFileSync('/workspace/output/data.json'));\nconsole.log(JSON.stringify(rows.map(r => ({...r, normalized: r.value / 100}))));\nEOF\nnode /tmp/transform.js > /workspace/data/output/transformed.json",
      },
    },
  ],
  visibility: 'always',
  stability: 'stable',
  category: 'core',
  tags: ['sandbox', 'execution', 'workspace', 'artifacts'],
};

/** Minimal MCP-client surface — declared structurally so tests can stub it. */
export interface SandboxMcpClientLike {
  getTools(): Promise<SandboxMcpTool[]>;
  close(): Promise<void>;
}

/** Shape of one upstream MCP tool. `@langchain/mcp-adapters` returns this. */
export interface SandboxMcpTool {
  name: string;
  description: string;
  schema: z.ZodType;
  invoke(input: unknown): Promise<unknown>;
}

export type SandboxMcpClientFactory = (
  config: ClientConfig,
) => SandboxMcpClientLike;

/** Per-tool timeout for sandbox MCP calls (matches today's main-agent wiring). */
const SANDBOX_MCP_TIMEOUT_MS = 180_000;

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
   * standing up a real `MultiServerMCPClient`.
   */
  mcpClientFactory?: SandboxMcpClientFactory;
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
 * authenticate the MCP connection and forward operator + per-user secrets in
 * the request headers.
 *
 * Headers are minted ONCE per request and include:
 *   - `Authorization: Bearer <ixo:sandbox UCAN invocation>` + `X-Auth-Type: ucan`
 *   - `X-Skills-Invocation` (when `SKILLS_CAPSULES_BASE_URL` is configured)
 *   - `x-os-<name>` for each entry in `ORACLE_SECRETS`
 *   - `x-us-<name>` for each per-room secret loaded from `SecretsService`
 *
 * Tools are discovered per request via {@link getRequestTools} because the
 * MCP client has to be authenticated as the in-flight user.
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
  override readonly configSchema = configSchema;
  override readonly autoDetectHint = 'SANDBOX_MCP_URL';

  private readonly authBuilder: SandboxAuthBuilder;
  private readonly mcpClientFactory: SandboxMcpClientFactory;
  private readonly includeOracleManagementTools: boolean;

  constructor(opts: SandboxPluginOptions = {}) {
    super();
    this.authBuilder = opts.authBuilder ?? createDefaultAuthBuilder();
    this.mcpClientFactory =
      opts.mcpClientFactory ??
      ((config) =>
        new MultiServerMCPClient(config) as unknown as SandboxMcpClientLike);
    this.includeOracleManagementTools =
      opts.includeOracleManagementTools ?? false;
  }

  override autoDetect(env: NodeJS.ProcessEnv): boolean {
    return Boolean(env.SANDBOX_MCP_URL);
  }

  /** Cached upstream tool definitions, keyed by sandbox MCP URL. */
  private readonly toolDefsCache = new Map<string, CachedSandboxDefs>();

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
    const oracleSecretsRaw = siblings.success
      ? (siblings.data.ORACLE_SECRETS ?? '')
      : '';

    const oracleSecrets = parseOracleSecrets(oracleSecretsRaw);
    const sandboxMcpUrl = parsed.data.SANDBOX_MCP_URL;

    const cached = this.toolDefsCache.get(sandboxMcpUrl);
    if (cached && cached.expiresAt > Date.now()) {
      // Warm path — definitions are known, so skip the per-turn secrets
      // fetch and MCP connect. The auth *gate* still runs every request:
      // minting is local (service-DID resolution is cached upstream), so an
      // unauthorized user sees no sandbox tools, exactly as before.
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
      const lazyUpstream = this.buildLazyUpstreamTools(cached.defs, {
        sandboxMcpUrl,
        skillsServiceUrl,
        oracleSecrets,
        rtCtx,
      });
      return this.toPluginTools(lazyUpstream, rtCtx);
    }

    const userSecretIndex = await rtCtx.secrets.getIndex();
    const userSecretKeys = Object.keys(userSecretIndex);
    const userSecrets: Record<string, string> =
      userSecretKeys.length > 0
        ? await rtCtx.secrets.getValues(userSecretKeys)
        : {};

    const headers = await this.authBuilder(
      {
        sandboxMcpUrl,
        skillsServiceUrl,
        oracleSecrets,
        userSecrets,
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

    const client = this.mcpClientFactory({
      mcpServers: {
        sandbox: {
          type: 'http',
          url: sandboxMcpUrl,
          transport: 'http',
          headers,
        },
      },
      defaultToolTimeout: SANDBOX_MCP_TIMEOUT_MS,
      useStandardContentBlocks: true,
    });

    const upstream = await client.getTools();
    this.toolDefsCache.set(sandboxMcpUrl, {
      defs: upstream.map(({ name, description, schema }) => ({
        name,
        description,
        schema,
      })),
      expiresAt: Date.now() + SANDBOX_TOOL_DEFS_TTL_MS,
    });

    return this.toPluginTools(upstream, rtCtx);
  }

  /**
   * Bind cached definitions to lazily-connected upstream tools. The full
   * connection chain (secrets fetch → header mint → MCP connect →
   * tools/list) runs once, on the first actual invocation, and is shared by
   * every sandbox tool in the request — turns that never call the sandbox
   * pay zero sandbox round-trips.
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
    let upstreamByName: Promise<Map<string, SandboxMcpTool>> | null = null;
    const connect = (): Promise<Map<string, SandboxMcpTool>> => {
      if (!upstreamByName) {
        upstreamByName = this.connectWithFullHeaders(args).then(
          (tools) => new Map(tools.map((t) => [t.name, t])),
        );
        // A failed connect must not poison the rest of the run — clear the
        // memo so a later invocation retries with a fresh client.
        upstreamByName.catch(() => {
          upstreamByName = null;
        });
      }
      return upstreamByName;
    };

    return defs.map((def) => ({
      name: def.name,
      description: def.description,
      schema: def.schema,
      invoke: async (input: unknown) => {
        const byName = await connect();
        const upstream = byName.get(def.name);
        if (!upstream) {
          throw new Error(
            `sandbox MCP no longer exposes "${def.name}" — cached definition is stale, retry shortly.`,
          );
        }
        return upstream.invoke(input);
      },
    }));
  }

  private async connectWithFullHeaders(args: {
    sandboxMcpUrl: string;
    skillsServiceUrl: string | undefined;
    oracleSecrets: Record<string, string>;
    rtCtx: RuntimeContext;
  }): Promise<SandboxMcpTool[]> {
    const { sandboxMcpUrl, skillsServiceUrl, oracleSecrets, rtCtx } = args;
    const userSecretIndex = await rtCtx.secrets.getIndex();
    const userSecretKeys = Object.keys(userSecretIndex);
    const userSecrets: Record<string, string> =
      userSecretKeys.length > 0
        ? await rtCtx.secrets.getValues(userSecretKeys)
        : {};

    const headers = await this.authBuilder(
      { sandboxMcpUrl, skillsServiceUrl, oracleSecrets, userSecrets },
      rtCtx,
    );
    if (!headers.Authorization) {
      throw new Error(
        'sandbox: no UCAN invocation could be minted for this call — the user is not authorized.',
      );
    }

    const client = this.mcpClientFactory({
      mcpServers: {
        sandbox: {
          type: 'http',
          url: sandboxMcpUrl,
          transport: 'http',
          headers,
        },
      },
      defaultToolTimeout: SANDBOX_MCP_TIMEOUT_MS,
      useStandardContentBlocks: true,
    });
    return client.getTools();
  }

  /**
   * Shared tail of both paths: visibility filter, PluginTool mapping, and
   * the synthetic `sandbox_write_blob` companion.
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

    const upstreamTools: PluginTool[] = filtered.map((tool) => ({
      name: tool.name,
      description: tool.description,
      schema: tool.schema,
      handler: async (args) => tool.invoke(args),
    }));

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

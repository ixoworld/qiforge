import { z } from 'zod';
import { OraclePlugin } from '../../plugin-api/oracle-plugin.js';
import type {
  PluginContext,
  PluginManifest,
  PluginTool,
} from '../../plugin-api/types.js';
import { createDefaultAuthBuilder, type SandboxAuthBuilder } from './sandbox-mcp.js';
import { createSandboxRunTool } from './sandbox-run-tool.js';

const configSchema = z.object({
  SANDBOX_MCP_URL: z.url(),
});

/**
 * Sibling env vars the plugin reads at boot but does not own:
 *
 * - `ORACLE_SECRETS` is declared in the core (Tier-0) base env schema; the
 *   sandbox plugin parses it lazily on every call to inject `x-os-*` headers.
 * - `SKILLS_CAPSULES_BASE_URL` is owned by the skills plugin. When it is set,
 *   the sandbox plugin mints a parallel `ixo:skills` invocation and forwards
 *   it as `X-Skills-Invocation` so the sandbox can call the skills service
 *   on the user's behalf.
 *
 * Both fields are optional here — a missing value simply skips the matching
 * header rather than failing the plugin build.
 */
const siblingEnvSchema = z.object({
  ORACLE_SECRETS: z.string().optional(),
  SKILLS_CAPSULES_BASE_URL: z.url().optional(),
});

const manifest: PluginManifest = {
  title: 'Sandbox',
  summary:
    'Per-user filesystem at `/workspace/` and code execution via `sandbox_run`. Attachments the user sends are auto-archived to `/workspace/output/<filename>`; for media files an `<filename>-analysis.md` is saved alongside.',
  whenToUse: [
    'You need to execute code, run a skill, or process data with shell/Python.',
    'You want to save a generated artifact (file, script, report) so it persists across turns — write it under `/workspace/output/`.',
    'You need to re-read or transform a previously archived attachment from its `/workspace/output/<filename>` path.',
  ],
  whenNotToUse: [
    'Re-reading an attachment whose content is already embedded inline in this conversation — the text is already here.',
    'Fetching a URL the user just mentioned in chat — use `process_file` instead.',
  ],
  examples: [
    {
      user: 'Generate a CSV of last quarter\'s totals and save it.',
      thought:
        'Write the CSV under `/workspace/output/` so the user can reuse it. Reference it back by its path.',
      tool: 'sandbox_run',
    },
    {
      user: 'Run that Python script you wrote on the data file I sent.',
      thought:
        'The attachment was archived to `/workspace/output/<filename>` — pass that path to the script.',
      tool: 'sandbox_run',
    },
  ],
  visibility: 'always',
  stability: 'stable',
  category: 'core',
  tags: ['sandbox', 'execution', 'workspace', 'artifacts'],
};

export interface SandboxPluginOptions {
  /**
   * Optional override for the auth header builder. Tests inject a stub here
   * to skip did:web resolution / UCAN minting; production code lets the
   * default builder do the network work.
   */
  authBuilder?: SandboxAuthBuilder;
}

/**
 * Sandbox plugin.
 *
 * Exposes the `sandbox_run` MCP tool to the runtime. Visibility is `silent`
 * — the agent does not see "sandbox" in the capability list; instead, the
 * skills, editor and file-processing plugins call `sandbox_run` directly
 * through the registered tool registry.
 *
 * The plugin owns:
 *   - UCAN minting for the sandbox MCP server (`ixo:sandbox` capability)
 *   - UCAN minting for a parallel skills invocation (`ixo:skills`), forwarded
 *     to the skills service as `X-Skills-Invocation`
 *   - Lazy injection of oracle (`x-os-*`) and per-user (`x-us-*`) secrets
 *     into the sandbox HTTP headers on every call
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

  private readonly authBuilderOverride?: SandboxAuthBuilder;

  constructor(opts: SandboxPluginOptions = {}) {
    super();
    this.authBuilderOverride = opts.authBuilder;
  }

  override autoDetect(env: NodeJS.ProcessEnv): boolean {
    return Boolean(env.SANDBOX_MCP_URL);
  }

  override getTools(ctx: PluginContext): PluginTool[] {
    const parsed = configSchema.safeParse(ctx.config);
    if (!parsed.success) {
      throw new Error(
        `sandbox: invalid configuration: ${parsed.error.issues
          .map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`)
          .join('; ')}`,
      );
    }

    const siblings = siblingEnvSchema.safeParse(ctx.config);
    const skillsServiceUrl = siblings.success
      ? siblings.data.SKILLS_CAPSULES_BASE_URL
      : undefined;
    const oracleSecretsRaw = siblings.success
      ? (siblings.data.ORACLE_SECRETS ?? '')
      : '';

    const authBuilder =
      this.authBuilderOverride ?? createDefaultAuthBuilder();

    return [
      createSandboxRunTool({
        sandboxMcpUrl: parsed.data.SANDBOX_MCP_URL,
        skillsServiceUrl,
        oracleSecretsRaw,
        authBuilder,
      }),
    ];
  }
}

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
    'Sandboxed code execution capability (used internally by skills, editor, ' +
    'and file processing).',
  whenToUse: [],
  visibility: 'silent',
  stability: 'stable',
  category: 'core',
  tags: ['sandbox', 'execution', 'ucan'],
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

import type { DynamicModule, Type } from '@nestjs/common';
import { z } from 'zod';
import { OraclePlugin } from '../../plugin-api/oracle-plugin.js';
import type {
  AuthExcludedRoute,
  PluginContext,
  PluginManifest,
  PluginTool,
} from '../../plugin-api/types.js';
import {
  createCodexResolveApprovalTool,
  createCodexRunTaskTool,
} from './codex-tools.js';
import { codexConfigSchema } from './domain/config.js';
import { preflight } from './domain/preflight.js';
import { CodexHttpModule } from './http/codex.module.js';
import {
  CodexRuntimeRegistry,
  type CodexRegistryOptions,
} from './session/registry.js';
import type { CodexTransportFactory } from './session/codex-session.js';

const NAME = 'codex';
const VERSION = '1.0.0';

/** Env the plugin reads but does not own — declared in the core base schema. */
const siblingEnvSchema = z.object({
  ORACLE_ENTITY_DID: z.string().min(1),
});

/** How long a Codex approval may sit unanswered before it is declined. */
const APPROVAL_TIMEOUT_MS = 5 * 60 * 1000;

const manifest: PluginManifest = {
  title: 'Codex',
  summary:
    "Delegates coding work to the user's OpenAI Codex runtime — reading, writing and running code in a configured workspace, with human approval for commands and file changes.",
  whenToUse: [
    'User asks for a change to a codebase that needs more than one file read or edited: "refactor the auth middleware", "add a migration and wire it up", "fix the failing test in the parser".',
    'User asks Codex by name — "run this through Codex", "have Codex look at it".',
    'A task needs to run commands in the workspace and inspect their output before deciding the next step (build, test, lint loops).',
    'When `codex_run_task` returns `status: "requires_sign_in"` or `"invalid_credentials"`, relay the `actionRequired` text to the user — do not retry the call.',
    'When Codex asks for approval, tell the user exactly what it wants to run and wait. Call `codex_resolve_approval` only after the user answers.',
  ],
  whenNotToUse: [
    'Running a one-off script or command with no repository context — use the Sandbox.',
    'Answering a question about code that is already in the conversation — just answer it.',
    'The user has not connected Codex. Point them at settings instead of retrying.',
    "Approving on the user's behalf. Never call `codex_resolve_approval` with `accept` unless the user said so.",
  ],
  examples: [
    {
      user: 'Have Codex add retry logic to the HTTP client and run the tests.',
      thought:
        'A multi-file coding task in the workspace — exactly what the Codex runtime is for.',
      tool: 'codex_run_task',
      args: {
        task: 'Add bounded exponential-backoff retry to the HTTP client, then run the test suite and report failures.',
      },
    },
    {
      user: 'Yes, let it run the test command.',
      thought:
        'The user answered the pending approval. Relay the decision verbatim.',
      tool: 'codex_resolve_approval',
      args: {
        approvalId: 'the id from the approval request',
        decision: 'accept',
      },
    },
  ],
  tags: ['codex', 'openai', 'coding', 'approvals'],
  category: 'integration',
  visibility: 'on-demand',
  stability: 'experimental',
};

export interface CodexPluginOptions {
  /**
   * Override how the App Server process is started. Tests point this at a
   * fixture server so the protocol is exercised without the Codex binary.
   */
  transportFactory?: CodexTransportFactory;
}

/**
 * Codex provider plugin.
 *
 * Integrates through the Codex App Server — the same bidirectional JSON-RPC
 * boundary Codex's own clients use — rather than driving a UI or reusing
 * browser credentials. Auth is an explicit operator choice between ChatGPT
 * subscription access and an OpenAI API key; the two never fall back to one
 * another. Runtime state and credentials are scoped per tenant.
 */
export class CodexPlugin extends OraclePlugin {
  readonly name = NAME;

  readonly version = VERSION;

  readonly manifest = manifest;

  override readonly configSchema = codexConfigSchema;

  override readonly autoDetectHint = 'CODEX_AUTH_MODE';

  private registry: CodexRuntimeRegistry | null = null;

  constructor(private readonly options: CodexPluginOptions = {}) {
    super();
  }

  /**
   * Off unless an operator has chosen a mode. There is no default: picking one
   * silently would decide how the user's Codex usage is billed.
   */
  override autoDetect(env: NodeJS.ProcessEnv): boolean {
    return Boolean(env.CODEX_AUTH_MODE);
  }

  override getTools(ctx: PluginContext): PluginTool[] {
    const registry = this.ensureRegistry(ctx);
    const { ORACLE_ENTITY_DID } = siblingEnvSchema.parse(ctx.config);
    const args = { registry, oracleEntityDid: ORACLE_ENTITY_DID };
    return [createCodexRunTaskTool(args), createCodexResolveApprovalTool(args)];
  }

  override getNestModules(ctx?: PluginContext): Array<Type | DynamicModule> {
    if (!ctx) return [];
    return [CodexHttpModule.register(this.ensureRegistry(ctx))];
  }

  /** Every Codex route is UCAN-authenticated — the control plane is per-user. */
  override getAuthExcludedRoutes(): AuthExcludedRoute[] {
    return [];
  }

  /**
   * The registry is built once, on first use, from a validated plan. Boot fails
   * here rather than at the first turn if config or tool policy is wrong.
   */
  private ensureRegistry(ctx: PluginContext): CodexRuntimeRegistry {
    if (this.registry) return this.registry;

    const plan = preflight(ctx.config);
    const options: CodexRegistryOptions = {
      plan,
      logger: ctx.logger,
      clientVersion: VERSION,
      approvalTimeoutMs: APPROVAL_TIMEOUT_MS,
      ...(this.options.transportFactory
        ? { transportFactory: this.options.transportFactory }
        : {}),
    };
    this.registry = new CodexRuntimeRegistry(options);
    return this.registry;
  }
}

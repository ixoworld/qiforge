import { z } from 'zod';
import { CODEX_AUTH_MODES, type CodexAuthMode } from './provider.js';

/**
 * Sandbox policy handed to `thread/start`. Values mirror the App Server's
 * `sandbox` enum verbatim so they pass through without translation.
 */
export const CODEX_SANDBOX_MODES = [
  'readOnly',
  'workspaceWrite',
  'dangerFullAccess',
] as const;
export type CodexSandboxMode = (typeof CODEX_SANDBOX_MODES)[number];

/** Approval policy handed to `thread/start`. Mirrors the App Server enum. */
export const CODEX_APPROVAL_POLICIES = [
  'never',
  'onRequest',
  'unlessTrusted',
] as const;
export type CodexApprovalPolicy = (typeof CODEX_APPROVAL_POLICIES)[number];

export const CODEX_REASONING_EFFORTS = ['low', 'medium', 'high'] as const;
export type CodexReasoningEffort = (typeof CODEX_REASONING_EFFORTS)[number];

/**
 * Plugin-owned env vars. `CODEX_AUTH_MODE` is required with no default: the
 * mode is an explicit operator choice, never inferred from which credential
 * happens to be present.
 */
export const codexConfigSchema = z.object({
  CODEX_AUTH_MODE: z.enum(CODEX_AUTH_MODES),
  CODEX_APP_SERVER_COMMAND: z.string().min(1).default('codex'),
  /** Space-separated argv appended to the command. */
  CODEX_APP_SERVER_ARGS: z.string().default('app-server'),
  /**
   * Parent directory for per-tenant `CODEX_HOME` roots. Each tenant gets an
   * isolated subdirectory so credential material never crosses tenants.
   */
  CODEX_HOME_ROOT: z.string().min(1).default('.codex-tenants'),
  /** Working directory Codex threads are rooted at. */
  CODEX_WORKSPACE_ROOT: z.string().min(1).default(process.cwd()),
  CODEX_MODEL: z.string().min(1).optional(),
  CODEX_REASONING_EFFORT: z.enum(CODEX_REASONING_EFFORTS).default('medium'),
  CODEX_SANDBOX_MODE: z.enum(CODEX_SANDBOX_MODES).default('readOnly'),
  CODEX_APPROVAL_POLICY: z.enum(CODEX_APPROVAL_POLICIES).default('onRequest'),
  /** Name of the per-room secret holding the OpenAI API key in `api_key` mode. */
  CODEX_API_KEY_SECRET_NAME: z.string().min(1).default('OPENAI_API_KEY'),
  CODEX_STARTUP_TIMEOUT_MS: z.coerce.number().int().positive().default(30_000),
  CODEX_TURN_TIMEOUT_MS: z.coerce.number().int().positive().default(600_000),
  /** Reconnect attempts after an unexpected App Server exit. */
  CODEX_MAX_RECONNECT_ATTEMPTS: z.coerce
    .number()
    .int()
    .min(0)
    .max(10)
    .default(3),
});

export type CodexRawConfig = z.infer<typeof codexConfigSchema>;

/** Config after parsing, argv splitting and cross-field policy checks. */
export interface CodexNormalizedConfig {
  readonly authMode: CodexAuthMode;
  readonly command: string;
  readonly args: readonly string[];
  readonly homeRoot: string;
  readonly workspaceRoot: string;
  readonly model?: string;
  readonly reasoningEffort: CodexReasoningEffort;
  readonly sandboxMode: CodexSandboxMode;
  readonly approvalPolicy: CodexApprovalPolicy;
  readonly apiKeySecretName: string;
  readonly startupTimeoutMs: number;
  readonly turnTimeoutMs: number;
  readonly maxReconnectAttempts: number;
}

export class CodexConfigError extends Error {
  constructor(message: string) {
    super(`codex: ${message}`);
    this.name = 'CodexConfigError';
  }
}

/**
 * Parse and normalize raw merged env into the runtime's config shape.
 * Throws `CodexConfigError` on anything the runtime cannot start under.
 */
export function normalizeCodexConfig(raw: unknown): CodexNormalizedConfig {
  const parsed = codexConfigSchema.safeParse(raw);
  if (!parsed.success) {
    const detail = parsed.error.issues
      .map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`)
      .join('; ');
    throw new CodexConfigError(`invalid configuration — ${detail}`);
  }

  const cfg = parsed.data;
  const args = cfg.CODEX_APP_SERVER_ARGS.split(/\s+/u).filter(Boolean);
  if (args.length === 0) {
    throw new CodexConfigError(
      'CODEX_APP_SERVER_ARGS resolved to an empty argv — expected at least `app-server`.',
    );
  }

  const normalized: CodexNormalizedConfig = {
    authMode: cfg.CODEX_AUTH_MODE,
    command: cfg.CODEX_APP_SERVER_COMMAND,
    args,
    homeRoot: cfg.CODEX_HOME_ROOT,
    workspaceRoot: cfg.CODEX_WORKSPACE_ROOT,
    ...(cfg.CODEX_MODEL ? { model: cfg.CODEX_MODEL } : {}),
    reasoningEffort: cfg.CODEX_REASONING_EFFORT,
    sandboxMode: cfg.CODEX_SANDBOX_MODE,
    approvalPolicy: cfg.CODEX_APPROVAL_POLICY,
    apiKeySecretName: cfg.CODEX_API_KEY_SECRET_NAME,
    startupTimeoutMs: cfg.CODEX_STARTUP_TIMEOUT_MS,
    turnTimeoutMs: cfg.CODEX_TURN_TIMEOUT_MS,
    maxReconnectAttempts: cfg.CODEX_MAX_RECONNECT_ATTEMPTS,
  };

  assertToolPolicy(normalized);
  return normalized;
}

/**
 * Reject sandbox/approval combinations that leave the agent with no guardrail
 * at all. `dangerFullAccess` gives Codex unrestricted host access; pairing it
 * with `never` also removes the approval gate, so nothing remains to stop a
 * destructive command.
 */
export function assertToolPolicy(config: CodexNormalizedConfig): void {
  if (
    config.sandboxMode === 'dangerFullAccess' &&
    config.approvalPolicy === 'never'
  ) {
    throw new CodexConfigError(
      'CODEX_SANDBOX_MODE=dangerFullAccess with CODEX_APPROVAL_POLICY=never removes every guardrail. Set an approval policy of `onRequest` or `unlessTrusted`, or narrow the sandbox.',
    );
  }
}

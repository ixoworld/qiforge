import { z } from 'zod';
import { tool } from '../../plugin-api/tool-helper.js';
import type { PluginTool, RuntimeContext } from '../../plugin-api/types.js';
import type { CodexTenantScope } from './domain/provider.js';
import { CodexSessionError } from './session/codex-session.js';
import type { CodexRuntimeRegistry } from './session/registry.js';

const runTaskSchema = z.object({
  task: z
    .string()
    .min(1)
    .describe(
      'The coding task for Codex, stated as you would to an engineer: what to change and what "done" looks like.',
    ),
  threadId: z
    .string()
    .optional()
    .describe(
      "Continue an existing Codex thread. Omit to continue this user's current thread, or to start one.",
    ),
});

/** Shape returned to the agent. Deliberately explicit about non-success. */
interface CodexToolResult {
  ok: boolean;
  status: string;
  threadId?: string;
  turnId?: string;
  output?: string;
  error?: string;
  actionRequired?: string;
}

function scopeFor(
  ctx: RuntimeContext,
  oracleEntityDid: string,
): CodexTenantScope {
  return { userDid: ctx.user.did, oracleEntityDid };
}

/**
 * Hands a task to the tenant's Codex runtime and returns the agent's output.
 *
 * Approvals raised mid-turn are surfaced through the approval gate (an
 * `action_call` event plus `POST /codex/approvals`), so a human decides. If
 * nobody answers, Codex is declined and the tool reports it — the agent never
 * silently gains unapproved access.
 */
export function createCodexRunTaskTool(params: {
  registry: CodexRuntimeRegistry;
  oracleEntityDid: string;
}): PluginTool {
  const { registry, oracleEntityDid } = params;

  return tool(
    async (args, ctx): Promise<CodexToolResult> => {
      const { task, threadId } = runTaskSchema.parse(args);
      const scope = scopeFor(ctx, oracleEntityDid);
      const session = registry.for(scope);

      try {
        const result = await session.runTurn({
          prompt: task,
          ...(threadId ? { threadId } : {}),
          ctx,
        });

        return {
          ok: result.status === 'completed',
          status: result.status,
          threadId: result.threadId,
          turnId: result.turnId,
          output: result.text,
          ...(result.error ? { error: result.error } : {}),
        };
      } catch (error) {
        if (error instanceof CodexSessionError) {
          const guidance = authGuidance(error.status);
          return {
            ok: false,
            status: error.status,
            error: error.message,
            ...(guidance ? { actionRequired: guidance } : {}),
          };
        }
        return {
          ok: false,
          status: 'error',
          error: error instanceof Error ? error.message : String(error),
        };
      }
    },
    {
      name: 'codex_run_task',
      description:
        "Delegate a coding task to the user's Codex runtime and return its result. Codex works in the configured workspace and may ask for approval before running commands or editing files.",
      schema: runTaskSchema,
    },
  );
}

/** What the user must do, in plain language, for each actionable auth state. */
function authGuidance(status: string): string | undefined {
  switch (status) {
    case 'requires_sign_in':
      return 'Ask the user to connect Codex in settings — ChatGPT sign-in for subscription access, or an API key for usage-based access.';
    case 'requires_device_authorization':
      return 'A ChatGPT sign-in is pending. Ask the user to finish authorizing in their browser.';
    case 'invalid_credentials':
      return 'Codex rejected the stored credentials. Ask the user to reauthorize in settings.';
    case 'unsupported_environment':
      return 'The Codex App Server could not start in this deployment. This needs an operator, not the user.';
    default:
      return undefined;
  }
}

const approvalSchema = z.object({
  approvalId: z.string().min(1).describe('Id from the approval request.'),
  decision: z
    .enum(['accept', 'acceptForSession', 'decline', 'cancel'])
    .describe("The user's decision. Only pass what the user actually said."),
});

/**
 * Relays a decision the user gave in chat to a Codex approval that is blocking.
 * Exists so an approval can be answered conversationally as well as through the
 * HTTP control plane; both paths land on the same gate.
 */
export function createCodexResolveApprovalTool(params: {
  registry: CodexRuntimeRegistry;
  oracleEntityDid: string;
}): PluginTool {
  const { registry, oracleEntityDid } = params;

  return tool(
    async (args, ctx) => {
      const { approvalId, decision } = approvalSchema.parse(args);
      const settled = registry.resolveApproval(
        scopeFor(ctx, oracleEntityDid),
        approvalId,
        decision,
      );
      return settled
        ? { ok: true, approvalId, decision }
        : {
            ok: false,
            error:
              'No pending approval with that id. It may have already been answered or timed out.',
          };
    },
    {
      name: 'codex_resolve_approval',
      description:
        'Answer a Codex approval the user has decided on. Never call this without an explicit decision from the user.',
      schema: approvalSchema,
    },
  );
}

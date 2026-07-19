import { tool } from '@langchain/core/tools';
import type { StructuredTool } from 'langchain';
import { sha256Hex } from '../kernel/audit.js';
import {
  attenuateRuntimeContext,
  PermissionDeniedError,
} from '../kernel/context-guard.js';
import type { ExecutionBrokerPort } from '../kernel/execution-broker.js';
import type {
  PermissionsEnforcement,
  PluginPermissions,
} from '../kernel/permissions.js';
import type { PluginTool, RuntimeContext } from '../plugin-api/types.js';
import type { AmbientServices } from '../runtime-context/ambient.js';
import {
  buildRuntimeContext,
  type RunConfig,
  type RuntimeStateInput,
} from '../runtime-context/build-runtime.js';

/**
 * What `wrapPluginTool` needs at each call: the captured ambient bag, the
 * current graph state, the plugin title used for the description prefix,
 * and — on the kernel path — the owning plugin's identity/grant plus the
 * execution broker.
 */
export interface WrapPluginToolOptions {
  ambient: AmbientServices;
  /** Snapshot of the graph state for the in-flight build. */
  state: RuntimeStateInput;
  /** Plugin manifest title used to auto-prefix the description. */
  pluginTitle?: string;
  /**
   * Owning plugin name. When set together with `enforcement`, the handler
   * receives an attenuated context limited to `permissions`.
   */
  pluginName?: string;
  /** The owning plugin's manifest grant. Absent = nothing granted. */
  permissions?: PluginPermissions;
  /** Permission enforcement mode. Attenuation is skipped when omitted. */
  enforcement?: PermissionsEnforcement;
  /**
   * Execution broker. When present, every handler invocation routes through
   * it (budget gate, per-tool timeout, audit). Omitted only by lightweight
   * test paths.
   */
  broker?: ExecutionBrokerPort;
}

/**
 * Kernel-enforced inbound-authority check: when a tool declares
 * `requiresCapability`, the authenticated user's delegation must cover it
 * BEFORE the handler runs. A miss audits a denial and throws — the agent
 * sees a denial it can relay, the handler never executes.
 */
async function enforceRequiredCapability(
  pluginTool: PluginTool,
  ctx: RuntimeContext,
  options: WrapPluginToolOptions,
): Promise<void> {
  const required = pluginTool.requiresCapability;
  if (!required) return;

  const { ambient } = options;
  const delegation = ctx.user.ucanDelegation;
  const held = ambient.ucan.hasCapability(
    delegation,
    required.resource,
    required.action,
  );
  if (held) return;

  if (ambient.audit) {
    const record = {
      kind: 'tool.deny' as const,
      at: new Date().toISOString(),
      sessionId: ctx.session.id,
      requestId: ctx.session.requestId,
      userDidDigest: await sha256Hex(ctx.user.did),
      detail: {
        plugin: options.pluginName ?? 'unknown',
        tool: pluginTool.name,
        reason: 'ucan',
        resource: required.resource,
        action: required.action,
      },
    };
    void Promise.resolve(ambient.audit.append(record)).catch(() => undefined);
  }

  throw new Error(
    `Denied: tool '${pluginTool.name}' requires UCAN capability ` +
      `'${required.action}' on '${required.resource}', which the current ` +
      `delegation does not grant.`,
  );
}

/**
 * Bridge a `PluginTool` (handler signature `(args, ctx: RuntimeContext)`)
 * into LangChain's `tool()` calling convention `(args, runConfig)`.
 *
 * Per-call, the wrapper synthesises a fresh `RuntimeContext` via
 * `buildRuntimeContext`, enforces the tool's declared inbound capability,
 * attenuates the context to the owning plugin's manifest grant, and routes
 * the handler through the execution broker (budget, timeout, audit). The
 * handler sees the same shape regardless of where the call originates
 * (HTTP, WS, scheduled task).
 *
 * The agent-facing description is auto-prefixed with the plugin's
 * `manifest.title` so the agent always knows which plugin a tool belongs to.
 */
export function wrapPluginTool(
  pluginTool: PluginTool,
  options: WrapPluginToolOptions,
): StructuredTool {
  const { ambient, state, pluginTitle } = options;
  const description = pluginTitle
    ? `[${pluginTitle}] ${pluginTool.description}`
    : pluginTool.description;

  return tool(
    async (args, runConfig) => {
      // LangChain passes the runtime as `runConfig` — cast to the shape we
      // depend on. The framework always provides a `context` channel with the
      // user/session payload established by the request middleware.
      const ctx = buildRuntimeContext(
        runConfig as unknown as RunConfig,
        ambient,
        state,
        options.pluginName,
      );

      await enforceRequiredCapability(pluginTool, ctx, options);

      const handlerCtx =
        options.pluginName !== undefined && options.enforcement !== undefined
          ? attenuateRuntimeContext(ctx, {
              pluginName: options.pluginName,
              permissions: options.permissions,
              enforcement: options.enforcement,
              logger: ambient.logger,
            })
          : ctx;

      if (!options.broker) {
        return pluginTool.handler(args, handlerCtx);
      }

      return options.broker.execute({
        pluginName: options.pluginName ?? 'unknown',
        toolName: pluginTool.name,
        tenant: {
          sessionId: ctx.session.id,
          requestId: ctx.session.requestId,
          userDid: ctx.user.did,
        },
        run: () => pluginTool.handler(args, handlerCtx),
        ...(pluginTool.timeoutMs !== undefined
          ? { timeoutMs: pluginTool.timeoutMs }
          : {}),
      });
    },
    {
      name: pluginTool.name,
      description,
      schema: pluginTool.schema,
    },
  );
}

export { PermissionDeniedError };

import { z } from 'zod';

/**
 * Manifest-declared permissions — what a plugin's request-time code (tool
 * handlers, request hooks, sub-agent tools, middlewares) is allowed to touch
 * on the `RuntimeContext`. Undeclared surfaces are replaced with throwing
 * guards by the context attenuator, turning the manifest from usage guidance
 * into an enforced least-authority declaration.
 *
 * Absent field = not granted. Surfaces that carry no side-effect authority
 * (config, identity, logger, history, user, session, abortSignal) are always
 * available and need no declaration.
 */
export interface PluginPermissions {
  /** Matrix room operations: `read` = getRoomState/getEventById, `write` = postToRoom. */
  matrix?: Array<'read' | 'write'>;
  /** Per-room user secrets (`ctx.secrets`). */
  secrets?: boolean;
  /** Short-TTL blob store (`ctx.blobStore`). */
  blobStore?: boolean;
  ucan?: {
    /**
     * Minting/resolution on the user's proof chain: `mintInvocation`,
     * `getServiceDelegation`, `createInvocationFromDelegation`,
     * `resolveServiceDid`, plus the read-only helpers.
     */
    invoke?: boolean;
    /**
     * Self-signed oracle authority (`mintSelfSignedInvocation`) — the oracle
     * acting as itself with no user proof chain. Granted only when a plugin
     * genuinely needs service-to-service identity.
     */
    selfSign?: boolean;
  };
  /** Model access (`ctx.llm.get`). */
  llm?: boolean;
  /** UI event emission (`ctx.emit`). */
  emit?: boolean;
  /**
   * Declared outbound origins for the plugin's own fetches (e.g.
   * `https://api.weatherapi.com`). Recorded and surfaced today; enforced once
   * execution is brokered through an isolation boundary (outbound Workers /
   * sandbox). Declaring it now makes the eventual enforcement a no-op change
   * for compliant plugins.
   */
  egress?: string[];
  /** Where this plugin's tools should execute. Default `in-process`. */
  execution?: 'in-process' | 'isolated';
}

export const pluginPermissionsSchema: z.ZodType<PluginPermissions> = z.object({
  matrix: z.array(z.enum(['read', 'write'])).optional(),
  secrets: z.boolean().optional(),
  blobStore: z.boolean().optional(),
  ucan: z
    .object({
      invoke: z.boolean().optional(),
      selfSign: z.boolean().optional(),
    })
    .optional(),
  llm: z.boolean().optional(),
  emit: z.boolean().optional(),
  egress: z.array(z.string().url()).optional(),
  execution: z.enum(['in-process', 'isolated']).optional(),
});

/**
 * Enforcement mode for permission grants. `enforce` (default) replaces
 * undeclared surfaces with throwing guards; `warn` logs the first access to
 * each undeclared surface but lets it through — a loudly-logged migration
 * escape for forks whose plugins predate permission declarations.
 */
export type PermissionsEnforcement = 'enforce' | 'warn';

/** Permissions granted to runtime-internal callers (meta-tools, builders). */
export const RUNTIME_INTERNAL_PERMISSIONS: PluginPermissions = {
  matrix: ['read', 'write'],
  secrets: true,
  blobStore: true,
  ucan: { invoke: true, selfSign: false },
  llm: true,
  emit: true,
};

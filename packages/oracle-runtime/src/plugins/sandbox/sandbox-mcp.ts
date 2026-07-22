import type { RuntimeContext } from '../../plugin-api/types.js';

/** Tool name surfaced by the upstream sandbox MCP. */
export const SANDBOX_RUN_TOOL_NAME = 'sandbox_run';

/**
 * Parse the `ORACLE_SECRETS` env value (format: `KEY1=value1,KEY2=value2`).
 *
 * Lifted from `apps/app/src/graph/agents/main-agent.ts` (lines 752-763).
 * Whitespace around keys and values is trimmed; entries lacking an `=` or
 * an empty key/value are skipped silently so a stray comma can't break boot.
 */
export function parseOracleSecrets(raw: string): Record<string, string> {
  const out: Record<string, string> = {};
  if (!raw) return out;
  for (const pair of raw.split(',')) {
    const eqIdx = pair.indexOf('=');
    if (eqIdx <= 0) continue;
    const key = pair.slice(0, eqIdx).trim();
    const val = pair.slice(eqIdx + 1).trim();
    if (key && val) out[key] = val;
  }
  return out;
}

/** Inputs to a {@link SandboxAuthBuilder} invocation. */
export interface SandboxHeaderInputs {
  /** Sandbox MCP base URL — resolved to a did:web audience. */
  sandboxMcpUrl: string;
  /** Optional skills-service base URL for the X-Skills-Invocation header. */
  skillsServiceUrl?: string;
  /** Oracle operator secrets — mapped to `x-os-{key}` headers. */
  oracleSecrets: Record<string, string>;
  /** Per-room user secrets — mapped to `x-us-{key}` headers. */
  userSecrets: Record<string, string>;
}

/**
 * Mints the headers needed to call the sandbox MCP server on behalf of
 * the current user. Encapsulates the four security-sensitive steps:
 *
 * 1. Resolve the sandbox service DID via did:web.
 * 2. Mint an `ixo:sandbox` UCAN invocation → `Authorization: Bearer ...`.
 * 3. Optionally mint a parallel `ixo:skills` invocation →
 *    `X-Skills-Invocation: ...` (forwarded by sandbox to the skills service).
 * 4. Layer oracle + user secrets as `x-os-*` / `x-us-*` headers.
 *
 * UCAN-only — no Matrix-OpenID fallback. If minting fails for any reason
 * (no signing key, no cached delegation, did:web unresolved) the returned
 * header set simply omits the relevant token and the downstream service
 * surfaces a clean unauthorized error instead of leaking a half-built
 * request.
 */
export type SandboxAuthBuilder = (
  inputs: SandboxHeaderInputs,
  runCtx: RuntimeContext,
) => Promise<Record<string, string>>;

/**
 * Default {@link SandboxAuthBuilder}. Service-DID resolution and caching is
 * delegated to `runCtx.ucan.resolveServiceDid` (cached per origin inside the
 * Tier-0 UCAN service), so this builder is stateless.
 */
export function createDefaultAuthBuilder(): SandboxAuthBuilder {
  return async (inputs, runCtx) => {
    const headers: Record<string, string> = {};

    const sandboxDid = await runCtx.ucan.resolveServiceDid(
      inputs.sandboxMcpUrl,
    );
    if (sandboxDid) {
      try {
        const invocation = await runCtx.ucan.mintInvocation(
          { did: sandboxDid, capability: 'ixo:sandbox' },
          // Claim the ability the user's delegation actually grants. A `'*'`
          // claim is satisfiable only by a `'*'` grant.
          { can: 'sandbox/*' },
        );
        if (invocation) {
          headers.Authorization = `Bearer ${invocation}`;
          headers['X-Auth-Type'] = 'ucan';
        }
      } catch (error) {
        const detail =
          error instanceof Error
            ? `${error.name}: ${error.message}`
            : String(error);
        runCtx.logger.warn(
          `[sandbox] failed to mint sandbox UCAN invocation: ${detail}`,
        );
      }
    }

    if (inputs.skillsServiceUrl) {
      const skillsDid = await runCtx.ucan.resolveServiceDid(
        inputs.skillsServiceUrl,
      );
      if (skillsDid) {
        try {
          const skillsInvocation = await runCtx.ucan.mintInvocation(
            { did: skillsDid, capability: 'ixo:skills' },
            { can: 'skills/*' },
          );
          if (skillsInvocation) {
            headers['X-Skills-Invocation'] = skillsInvocation;
          }
        } catch (error) {
          const detail =
            error instanceof Error
              ? `${error.name}: ${error.message}`
              : String(error);
          runCtx.logger.warn(
            `[sandbox] failed to mint skills UCAN invocation: ${detail}`,
          );
        }
      }
    }

    for (const [k, v] of Object.entries(inputs.oracleSecrets)) {
      headers[`x-os-${k.toLowerCase()}`] = v;
    }
    for (const [k, v] of Object.entries(inputs.userSecrets)) {
      headers[`x-us-${k.toLowerCase()}`] = v;
    }

    return headers;
  };
}

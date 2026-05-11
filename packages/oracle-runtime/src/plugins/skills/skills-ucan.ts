import type { RuntimeContext } from '../../plugin-api/types.js';

/**
 * Mints an `ixo:skills` UCAN invocation for outbound calls to the skills
 * registry. The invocation lets ai-skills surface the caller's own published
 * private skills alongside the public registry rows.
 *
 * Returns `undefined` when:
 *   - the registry's did:web document cannot be resolved (e.g. dev box, no
 *     network), or
 *   - the UCAN service cannot mint an invocation (no signing key, no cached
 *     delegation, etc).
 *
 * The skills tools degrade to public-only mode when no token is available —
 * we never throw, we just skip the authorization header.
 */
export type SkillsUcanBuilder = (
  skillsServiceUrl: string,
  runCtx: RuntimeContext,
) => Promise<string | undefined>;

/**
 * Default {@link SkillsUcanBuilder}. Uses the same primitives as the sandbox
 * plugin: `runCtx.ucan.resolveServiceDid` for did:web resolution +
 * `runCtx.ucan.mintInvocation` to obtain the bearer token. Failures are
 * logged at `warn` and swallowed — the caller falls back to public-only.
 */
export function createDefaultSkillsUcanBuilder(): SkillsUcanBuilder {
  return async (skillsServiceUrl, runCtx) => {
    const skillsDid = await runCtx.ucan.resolveServiceDid(skillsServiceUrl);
    if (!skillsDid) {
      return undefined;
    }
    try {
      const invocation = await runCtx.ucan.mintInvocation({
        did: skillsDid,
        capability: 'ixo:skills',
      });
      return invocation || undefined;
    } catch (error) {
      const detail =
        error instanceof Error
          ? `${error.name}: ${error.message}`
          : String(error);
      runCtx.logger.warn(
        `[skills] failed to mint skills UCAN invocation: ${detail}`,
      );
      return undefined;
    }
  };
}

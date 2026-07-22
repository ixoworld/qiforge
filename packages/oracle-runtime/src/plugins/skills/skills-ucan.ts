import type { RuntimeContext } from '../../plugin-api/types.js';
import {
  mintInvocationSafely,
  resolveServiceDidSafely,
} from '../ucan-failure.js';

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
 * `runCtx.ucan.mintInvocation` to obtain the bearer token. All failures are
 * contained by the shared UCAN helpers — nothing throws past this boundary,
 * and the caller falls back to public-only. The "no delegation present" case
 * logs at `debug`; a genuine resolve/mint failure logs at `warn`.
 */
export function createDefaultSkillsUcanBuilder(): SkillsUcanBuilder {
  return async (skillsServiceUrl, runCtx) => {
    const skillsDid = await resolveServiceDidSafely(
      runCtx,
      skillsServiceUrl,
      'skills',
    );
    if (!skillsDid) {
      return undefined;
    }
    const invocation = await mintInvocationSafely(
      runCtx,
      { did: skillsDid, capability: 'ixo:skills' },
      'skills',
      // Claim the ability the user's delegation actually grants. A `'*'` claim
      // is satisfiable only by a `'*'` grant — `'*'.startsWith('skills/')` is
      // false.
      { can: 'skills/*' },
    );
    return invocation ?? undefined;
  };
}

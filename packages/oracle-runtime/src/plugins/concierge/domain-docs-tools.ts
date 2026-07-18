import { z } from 'zod';
import { tool } from '../../plugin-api/tool-helper.js';
import type { PluginTool, RuntimeContext } from '../../plugin-api/types.js';
import {
  VfsAuthError,
  VfsClient,
  VfsHttpError,
  type VfsMintFn,
} from '../vfs/index.js';

/** Domain (entity) namespace on the VFS worker, keyed by the entity's DID. */
const entityNamespace = (entityDid: string): string =>
  `ixo:filesystem/${entityDid}`;

/** Invocations are single-use per call, so a short TTL suffices. */
const INVOCATION_TTL_SECONDS = 60;

const DOCS_UNAVAILABLE =
  "Domain documentation is not accessible right now — answer from the domain card (get_oracle_info) instead, and offer human support if that doesn't cover the question.";

const schema = z.object({
  query: z
    .string()
    .min(1, 'query is required')
    .describe(
      'What to look for in this oracle\'s domain documentation, phrased like a search (e.g. "pricing", "how onboarding works", "supported regions").',
    ),
});

const DESCRIPTION = `Search THIS oracle's domain documentation (its entity filesystem) for passages relevant to a visitor's question. Returns matching file paths with highlighted snippets and line ranges.

Use it when the domain card (get_oracle_info) doesn't answer the question and the topic is still within this oracle's domain. Quote or paraphrase the returned snippets — don't invent content beyond them.

If it reports that documentation is unavailable, fall back to the domain card and offer human support.`;

/**
 * Bearer for the oracle's OWN entity namespace: a self-signed invocation
 * issued by the oracle (no user delegation involved — concierge visitors
 * don't have one). The VFS worker authorizes entity namespaces by domain
 * membership, so the oracle account's own signature carries the access.
 */
function entityDocsMint(
  rtCtx: RuntimeContext,
  vfsBaseUrl: string,
  entityDid: string,
): VfsMintFn {
  return async (ability) => {
    const minted = await rtCtx.ucan.mintSelfSignedInvocation(
      vfsBaseUrl,
      { can: ability, with: entityNamespace(entityDid) },
      { maxTtlSeconds: INVOCATION_TTL_SECONDS },
    );
    if ('error' in minted) {
      return { error: 'mint-failed', detail: minted.error };
    }
    return { bearer: minted.invocation };
  };
}

export interface CreateDomainDocsToolsDeps {
  /** VFS worker origin (e.g. `https://devnet.vfs.ixo.earth`). */
  vfsBaseUrl: string;
  /** This oracle's entity DID (`identity.entityDid`). */
  entityDid: string;
  /** Per-request timeout for the VFS worker. */
  timeoutMs: number;
}

/**
 * `search_domain_docs` — semantic + lexical search over the oracle's domain
 * documentation on the VFS. Non-throwing on auth/permission failures: those
 * degrade to an agent-actionable fallback message so an unconfigured or
 * unauthorized namespace never breaks a concierge turn.
 */
export function createDomainDocsTools({
  vfsBaseUrl,
  entityDid,
  timeoutMs,
}: CreateDomainDocsToolsDeps): PluginTool[] {
  const search = tool(
    async (rawArgs, rtCtx) => {
      const { query } = schema.parse(rawArgs);
      const client = new VfsClient({
        baseUrl: `${vfsBaseUrl}/api/fs`,
        mint: entityDocsMint(rtCtx, vfsBaseUrl, entityDid),
        timeoutMs,
        signal: rtCtx.abortSignal,
      });

      try {
        const result = await client.search(query, '/');
        if (result.results.length === 0) {
          return {
            results: [],
            note: 'No documentation passages matched. Try the domain card (get_oracle_info), or offer human support.',
          };
        }
        return result;
      } catch (error) {
        if (error instanceof VfsAuthError) {
          rtCtx.logger.warn(
            `[concierge] domain docs bearer failed (${error.kind}): ${error.message} — degrading to domain card`,
          );
          return { error: DOCS_UNAVAILABLE };
        }
        if (
          error instanceof VfsHttpError &&
          (error.status === 401 || error.status === 403)
        ) {
          rtCtx.logger.warn(
            `[concierge] VFS rejected the oracle's entity-namespace invocation (${error.status}) — degrading to domain card`,
          );
          return { error: DOCS_UNAVAILABLE };
        }
        throw error;
      }
    },
    {
      name: 'search_domain_docs',
      description: DESCRIPTION,
      schema,
    },
  );

  return [search];
}

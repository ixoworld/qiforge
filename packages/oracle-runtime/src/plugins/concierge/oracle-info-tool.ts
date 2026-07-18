import { z } from 'zod';
import { tool } from '../../plugin-api/tool-helper.js';
import type { PluginTool } from '../../plugin-api/types.js';
import {
  projectDomainCard,
  type DomainCardSummary,
} from '../domain-indexer/index.js';

const schema = z.object({});

const DESCRIPTION = `Get THIS oracle's own public profile from its domain card: name, description, summary, overview, FAQ (question/answer pairs), website, and keywords.

This is your primary grounding source for questions about this oracle — who runs it, what it does, what it offers, and its frequently asked questions. Call it before answering any "what is this / what do you do / how does this work" question, and use the FAQ entries verbatim where they apply.

Takes no arguments. The result is cached briefly, so calling it again within a conversation is cheap.`;

/** Successful lookups are cached briefly; a miss is retried on next call. */
const CACHE_TTL_MS = 5 * 60 * 1000;
const cardCache = new Map<string, { card: DomainCardSummary; at: number }>();

export interface CreateOracleInfoToolDeps {
  /** Domain-indexer base URL (from `resolveDomainIndexerUrl`). */
  baseUrl: string;
  /** This oracle's entity DID (`identity.entityDid`). */
  entityDid: string;
}

/**
 * `get_oracle_info` — fetch and project this oracle's own domain card. A
 * missing card degrades to an agent-actionable message (the concierge then
 * answers only from identity config and offers human support).
 */
export function createOracleInfoTool({
  baseUrl,
  entityDid,
}: CreateOracleInfoToolDeps): PluginTool {
  return tool(
    async () => {
      const cached = cardCache.get(entityDid);
      if (cached && Date.now() - cached.at < CACHE_TTL_MS) {
        return cached.card;
      }

      const url = new URL(`/domain-cards/${entityDid}`, baseUrl);
      const response = await fetch(url.toString());
      if (!response.ok) {
        if (response.status === 404) {
          return {
            error:
              'This oracle has no public domain card yet. Answer only from the identity you already know, and offer human support for anything else.',
          };
        }
        throw new Error(
          `Failed to fetch this oracle's domain card: ${response.statusText}`,
        );
      }
      const card = projectDomainCard(await response.json());
      cardCache.set(entityDid, { card, at: Date.now() });
      return card;
    },
    {
      name: 'get_oracle_info',
      description: DESCRIPTION,
      schema,
    },
  );
}

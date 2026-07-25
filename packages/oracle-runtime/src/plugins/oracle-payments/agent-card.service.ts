import { IXO } from '@ixo/oracles-chain-client';
import { Logger as NestLogger } from '@nestjs/common';
import { z } from 'zod';
import type { Logger } from '../../plugin-api/types.js';
import {
  DisplayCardSchema,
  type AgentCardServiceView,
  type ResolvedAgentCard,
} from './types.js';
import { errorMessage } from './util.js';

/** Match the engine's KV TTL: card updates propagate within 5 minutes. */
const CARD_CACHE_TTL_MS = 300_000;

/** A single `linkedResource` entry on the entity doc. */
const LinkedResourceSchema = z.object({
  type: z.string().optional(),
  id: z.string().optional(),
  serviceEndpoint: z.string().optional(),
  proof: z.string().optional(),
});

/** The slice of the Blocksync entity doc this resolver reads. */
const EntitySchema = z.object({
  linkedResource: z.array(LinkedResourceSchema).nullish(),
});

/** Fetch the entity doc for a DID. Returns the raw doc, or `null` when absent. */
export type EntityFetcher = (entityDid: string) => Promise<unknown>;

/**
 * Fetch the card JSON from a LinkedResource `serviceEndpoint`. Returns the
 * parsed JSON value, or `null` on any transport/parse failure. Cards are public
 * (Matrix media / cellnode) so a plain GET suffices.
 */
export type CardFetcher = (serviceEndpoint: string) => Promise<unknown | null>;

export interface AgentCardServiceDeps {
  /** Blocksync entity read. Defaults to `IXO.entities.getEntityById`. */
  getEntity?: EntityFetcher;
  /** Card-document fetch. Defaults to a plain JSON GET on the endpoint. */
  fetchCard?: CardFetcher;
  clock?: () => number;
  logger?: Logger;
}

interface CacheEntry {
  card: ResolvedAgentCard;
  expiresAt: number;
}

const defaultGetEntity: EntityFetcher = (entityDid) =>
  IXO.entities.getEntityById(entityDid);

const defaultFetchCard: CardFetcher = async (serviceEndpoint) => {
  try {
    const res = await fetch(serviceEndpoint, {
      headers: { accept: 'application/json' },
    });
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  }
};

/**
 * Resolves the oracle's own Agent Card from chain, mirroring the engine's
 * resolver: Blocksync entity → `agentCard`/`#acard` LinkedResource → fetch its
 * `serviceEndpoint` → display-shape validation → in-memory cache (300s TTL,
 * re-resolved on expiry). A missing resource, a fetch failure, or an invalid
 * shape all resolve to `null` — the normal "no published card" state.
 */
export class AgentCardService {
  private readonly getEntity: EntityFetcher;
  private readonly fetchCard: CardFetcher;
  private readonly clock: () => number;
  private readonly logger: Logger;
  private readonly cache = new Map<string, CacheEntry>();
  private localSeed: ResolvedAgentCard | null = null;
  private driftWarnedForProof?: string;

  constructor(deps: AgentCardServiceDeps = {}) {
    this.getEntity = deps.getEntity ?? defaultGetEntity;
    this.fetchCard = deps.fetchCard ?? defaultFetchCard;
    this.clock = deps.clock ?? Date.now;
    this.logger = deps.logger ?? new NestLogger(AgentCardService.name);
  }

  /**
   * Seed a locally-loaded card (the `AGENT_CARD_PATH` file). Used as the
   * fallback whenever the on-chain resolution is unavailable — the anchored
   * card stays the contracting truth once it resolves.
   */
  setLocalSeed(card: ResolvedAgentCard): void {
    this.localSeed = card;
  }

  /**
   * Resolve the full card for `entityDid`, or `null`. Successful resolutions
   * are cached for 300s; failures are never cached (a transient blocksync/media
   * outage must not stick). When the chain has nothing, the local seed (if any)
   * answers instead.
   */
  async getCard(entityDid: string): Promise<ResolvedAgentCard | null> {
    const cached = this.cache.get(entityDid);
    if (cached && cached.expiresAt > this.clock()) {
      return cached.card;
    }

    const card = await this.resolve(entityDid);
    if (card) {
      this.warnOnLocalDrift(card);
      this.cache.set(entityDid, {
        card,
        expiresAt: this.clock() + CARD_CACHE_TTL_MS,
      });
      return card;
    }

    if (this.localSeed && this.localSeed.oracleEntityDid === entityDid) {
      return this.localSeed;
    }
    return null;
  }

  /**
   * A local card that disagrees with the anchored one means the manifest is
   * describing services users can't actually contract — warn loudly, once per
   * on-chain card version.
   */
  private warnOnLocalDrift(onChain: ResolvedAgentCard): void {
    if (!this.localSeed || this.driftWarnedForProof === onChain.cardProof) {
      return;
    }
    const differs =
      JSON.stringify(this.localSeed.services) !==
      JSON.stringify(onChain.services);
    if (differs) {
      this.driftWarnedForProof = onChain.cardProof;
      this.logger.warn(
        `[oracle-payments] local agent card (AGENT_CARD_PATH) differs from the on-chain #acard (proof ${onChain.cardProof}) — republish or update the local file; the manifest may advertise services users cannot contract`,
      );
    }
  }

  /** The card's services, or `null` when the oracle publishes no usable card. */
  async getServices(entityDid: string): Promise<AgentCardServiceView[] | null> {
    const card = await this.getCard(entityDid);
    return card?.services ?? null;
  }

  private async resolve(entityDid: string): Promise<ResolvedAgentCard | null> {
    let rawEntity: unknown;
    try {
      rawEntity = await this.getEntity(entityDid);
    } catch (error) {
      this.logger.warn(
        `[oracle-payments] entity read failed for ${entityDid}: ${errorMessage(error)}`,
      );
      return null;
    }

    // Every `null` below is "this oracle publishes no usable card", which
    // makes the message router skip its classifier and run every Matrix turn
    // as support. Each reason is named: silence here is indistinguishable
    // from a routing bug once it reaches the chat.
    const entity = EntitySchema.safeParse(rawEntity);
    if (!entity.success) {
      this.logger.warn(
        `[oracle-payments] entity doc for ${entityDid} has no readable linkedResource list — no agent card`,
      );
      return null;
    }

    const resource = (entity.data.linkedResource ?? []).find(
      (r) => r.type === 'agentCard' && (r.id?.endsWith('#acard') ?? false),
    );
    if (!resource?.serviceEndpoint) {
      this.logger.warn(
        `[oracle-payments] entity ${entityDid} has no agentCard '#acard' linked resource with a serviceEndpoint — no agent card, so every turn routes as support`,
      );
      return null;
    }

    const rawCard = await this.fetchCard(resource.serviceEndpoint);
    if (rawCard === null || rawCard === undefined) {
      this.logger.warn(
        `[oracle-payments] agent card fetch returned nothing from ${resource.serviceEndpoint}`,
      );
      return null;
    }

    const parsed = DisplayCardSchema.safeParse(rawCard);
    if (!parsed.success) {
      this.logger.warn(
        `[oracle-payments] agent card for ${entityDid} failed shape check`,
      );
      return null;
    }

    const subject = parsed.data.credentialSubject;
    // The card must be ABOUT the entity it is anchored on.
    if (subject.id !== entityDid) {
      this.logger.warn(
        `[oracle-payments] agent card at ${resource.serviceEndpoint} describes ${subject.id} but is anchored on ${entityDid} — ignoring it`,
      );
      return null;
    }

    return {
      oracleEntityDid: entityDid,
      cardProof: resource.proof ?? '',
      services: subject.services,
    };
  }
}

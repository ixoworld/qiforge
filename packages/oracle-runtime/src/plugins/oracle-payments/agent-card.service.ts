import { IXO } from '@ixo/oracles-chain-client';
import { Logger as NestLogger } from '@nestjs/common';
import { z } from 'zod';
import type { Logger } from '../../plugin-api/types.js';
import { sweepExpired } from '../../utils/expiring-map.js';
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

/**
 * The outcome of one card resolution. `card: null` with no `error` is the
 * ordinary "this oracle publishes no agent card"; `card: null` WITH an `error`
 * means one exists but could not be read — a Blocksync outage, a dead media
 * endpoint, a card that failed its shape check.
 *
 * Kept apart because the two call for opposite replies: the first is "I sell
 * nothing", the second is "I could not load my catalogue just now", and the
 * tools would otherwise tell every user the former whenever the latter happens.
 */
export interface AgentCardLookup {
  card: ResolvedAgentCard | null;
  error?: string;
}

const defaultGetEntity: EntityFetcher = (entityDid) =>
  IXO.entities.getEntityById(entityDid);

const defaultFetchCard: CardFetcher = async (serviceEndpoint) => {
  // Named on the way out: the caller only learns the card is unavailable, so
  // the status or transport error has to be logged here or it exists nowhere.
  const log = new NestLogger(AgentCardService.name);
  try {
    const res = await fetch(serviceEndpoint, {
      headers: { accept: 'application/json' },
    });
    if (!res.ok) {
      log.warn(
        `[oracle-payments] agent card fetch from ${serviceEndpoint} returned ${res.status}`,
      );
      return null;
    }
    return await res.json();
  } catch (error) {
    log.warn(
      `[oracle-payments] agent card fetch from ${serviceEndpoint} failed: ${errorMessage(error)}`,
    );
    return null;
  }
};

/**
 * Resolves the oracle's own Agent Card from chain, mirroring the engine's
 * resolver: Blocksync entity → `agentCard`/`#acard` LinkedResource → fetch its
 * `serviceEndpoint` → display-shape validation → in-memory cache (300s TTL,
 * re-resolved on expiry). A missing `#acard` resource is the normal "no
 * published card" state; a fetch failure or an invalid shape resolves to the
 * same empty card but carries the reason, because those are outages, not
 * catalogues.
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
   * Resolve the full card for `entityDid`, with the reason when none resolves.
   * Successful resolutions are cached for 300s; failures are never cached (a
   * transient blocksync/media outage must not stick). When the chain has
   * nothing, the local seed (if any) answers instead — and a seed that answers
   * is a success, not a degraded one, so no error rides along with it.
   */
  async getCard(entityDid: string): Promise<AgentCardLookup> {
    const cached = this.cache.get(entityDid);
    if (cached && cached.expiresAt > this.clock()) {
      return { card: cached.card };
    }

    const resolved = await this.resolve(entityDid);
    if (resolved.card) {
      this.warnOnLocalDrift(resolved.card);
      sweepExpired(this.cache, this.clock());
      this.cache.set(entityDid, {
        card: resolved.card,
        expiresAt: this.clock() + CARD_CACHE_TTL_MS,
      });
      return { card: resolved.card };
    }

    if (this.localSeed && this.localSeed.oracleEntityDid === entityDid) {
      return { card: this.localSeed };
    }
    return resolved;
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
    const { card } = await this.getCard(entityDid);
    return card?.services ?? null;
  }

  private async resolve(entityDid: string): Promise<AgentCardLookup> {
    let rawEntity: unknown;
    try {
      rawEntity = await this.getEntity(entityDid);
    } catch (error) {
      const detail = errorMessage(error);
      this.logger.warn(
        `[oracle-payments] entity read failed for ${entityDid}: ${detail}`,
      );
      return {
        card: null,
        error: `the oracle's on-chain entity record could not be read (${detail})`,
      };
    }

    // Every empty result below makes the message router skip its classifier
    // and run every Matrix turn as support. Each reason is named: silence here
    // is indistinguishable from a routing bug once it reaches the chat. Only
    // the missing-resource case is a plain "nothing published" — the rest are
    // failures the tools relay rather than mistake for an empty catalogue.
    const entity = EntitySchema.safeParse(rawEntity);
    if (!entity.success) {
      this.logger.warn(
        `[oracle-payments] entity doc for ${entityDid} has no readable linkedResource list — no agent card`,
      );
      return {
        card: null,
        error:
          "the oracle's on-chain entity record could not be read (it lists no resources in the expected shape)",
      };
    }

    const resource = (entity.data.linkedResource ?? []).find(
      (r) => r.type === 'agentCard' && (r.id?.endsWith('#acard') ?? false),
    );
    if (!resource?.serviceEndpoint) {
      this.logger.warn(
        `[oracle-payments] entity ${entityDid} has no agentCard '#acard' linked resource with a serviceEndpoint — no agent card, so every turn routes as support`,
      );
      return { card: null };
    }

    const rawCard = await this.fetchCard(resource.serviceEndpoint);
    if (rawCard === null || rawCard === undefined) {
      this.logger.warn(
        `[oracle-payments] agent card fetch returned nothing from ${resource.serviceEndpoint}`,
      );
      return {
        card: null,
        error:
          'the published agent card could not be downloaded from where it is anchored',
      };
    }

    const parsed = DisplayCardSchema.safeParse(rawCard);
    if (!parsed.success) {
      this.logger.warn(
        `[oracle-payments] agent card for ${entityDid} failed shape check`,
      );
      return {
        card: null,
        error:
          'the published agent card did not match the expected shape, so it cannot be used',
      };
    }

    const subject = parsed.data.credentialSubject;
    // The card must be ABOUT the entity it is anchored on.
    if (subject.id !== entityDid) {
      this.logger.warn(
        `[oracle-payments] agent card at ${resource.serviceEndpoint} describes ${subject.id} but is anchored on ${entityDid} — ignoring it`,
      );
      return {
        card: null,
        error: `the published agent card describes ${subject.id} but is anchored on ${entityDid}, so it cannot be trusted`,
      };
    }

    return {
      card: {
        oracleEntityDid: entityDid,
        cardProof: resource.proof ?? '',
        services: subject.services,
      },
    };
  }
}

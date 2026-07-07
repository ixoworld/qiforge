import { BoundedMap, type BoundedMapOptions } from './bounded-map.js';
import type { BlueprintSection, PodBlueprint } from './blueprint-types.js';

/**
 * Durable per-thread store for the evolving POD blueprint. The blueprint must
 * outlive a single request (each request builds a fresh `RuntimeContext`), so
 * it is held outside the graph state — never as a graph-state field.
 */
export interface BlueprintStore {
  /** Create the blueprint for a thread, or return the existing one. */
  init(threadId: string, brief: string | undefined): Promise<PodBlueprint>;
  /** Read the current blueprint, or `null` if no session has started. */
  get(threadId: string): Promise<PodBlueprint | null>;
  /** Record or replace a section; returns the updated blueprint. */
  putSection(
    threadId: string,
    section: BlueprintSection,
  ): Promise<PodBlueprint>;
  /** Discard the thread's blueprint so a fresh design can start. */
  reset(threadId: string): Promise<void>;
}

const nowIso = (): string => new Date().toISOString();

/** A design session that idles longer than this is discarded. */
const DEFAULT_TTL_MS = 24 * 60 * 60 * 1000;
/** Concurrent design sessions retained before LRU eviction. */
const DEFAULT_MAX_ENTRIES = 500;

/** Defensive copy so callers can't mutate the stored document in place. */
function snapshot(bp: PodBlueprint): PodBlueprint {
  return structuredClone(bp);
}

/**
 * Process-local {@link BlueprintStore}. Held on the plugin instance, so a
 * blueprint persists across every request in the running process and survives
 * a fresh `RuntimeContext` — but NOT a process restart. Bounded (LRU + idle
 * TTL) so long-running oracles don't accumulate dead sessions. A cross-restart
 * durable backend is a separate, swappable implementation of this interface.
 */
export class InMemoryBlueprintStore implements BlueprintStore {
  private readonly docs: BoundedMap<PodBlueprint>;

  constructor(options: Partial<BoundedMapOptions> = {}) {
    this.docs = new BoundedMap({
      maxEntries: options.maxEntries ?? DEFAULT_MAX_ENTRIES,
      ttlMs: options.ttlMs ?? DEFAULT_TTL_MS,
      ...(options.now ? { now: options.now } : {}),
    });
  }

  async init(
    threadId: string,
    brief: string | undefined,
  ): Promise<PodBlueprint> {
    const existing = this.docs.get(threadId);
    if (existing) {
      if (brief && existing.brief === undefined) {
        existing.brief = brief;
        existing.updatedAt = nowIso();
        this.docs.set(threadId, existing);
      }
      return snapshot(existing);
    }
    const now = nowIso();
    const created: PodBlueprint = {
      threadId,
      sections: {},
      createdAt: now,
      updatedAt: now,
    };
    if (brief !== undefined) {
      created.brief = brief;
    }
    this.docs.set(threadId, created);
    return snapshot(created);
  }

  async get(threadId: string): Promise<PodBlueprint | null> {
    const bp = this.docs.get(threadId);
    return bp ? snapshot(bp) : null;
  }

  async putSection(
    threadId: string,
    section: BlueprintSection,
  ): Promise<PodBlueprint> {
    let bp = this.docs.get(threadId);
    if (!bp) {
      const now = nowIso();
      bp = { threadId, sections: {}, createdAt: now, updatedAt: now };
    }
    bp.sections[section.role] = section;
    bp.updatedAt = nowIso();
    this.docs.set(threadId, bp);
    return snapshot(bp);
  }

  async reset(threadId: string): Promise<void> {
    this.docs.delete(threadId);
  }
}

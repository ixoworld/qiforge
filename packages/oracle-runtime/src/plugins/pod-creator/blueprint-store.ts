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
}

const nowIso = (): string => new Date().toISOString();

/** Defensive copy so callers can't mutate the stored document in place. */
function snapshot(bp: PodBlueprint): PodBlueprint {
  return structuredClone(bp);
}

/**
 * Process-local {@link BlueprintStore}. Held on the plugin instance, so a
 * blueprint persists across every request in the running process and survives
 * a fresh `RuntimeContext` — but NOT a process restart. A cross-restart durable
 * backend is a separate, swappable implementation of this interface.
 */
export class InMemoryBlueprintStore implements BlueprintStore {
  private readonly docs = new Map<string, PodBlueprint>();

  async init(
    threadId: string,
    brief: string | undefined,
  ): Promise<PodBlueprint> {
    const existing = this.docs.get(threadId);
    if (existing) {
      if (brief && existing.brief === undefined) {
        existing.brief = brief;
        existing.updatedAt = nowIso();
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
      this.docs.set(threadId, bp);
    }
    bp.sections[section.role] = section;
    bp.updatedAt = nowIso();
    return snapshot(bp);
  }
}

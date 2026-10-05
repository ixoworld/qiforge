import type { RuntimeContext, UserKvSurface } from '../../plugin-api/types';
import {
  podBlueprintSchema,
  type BlueprintSection,
  type PodBlueprint,
} from './blueprint-types';

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

/** Resolves the blueprint store for one request (it lives in the user's database). */
export type BlueprintStoreFor = (ctx: RuntimeContext) => BlueprintStore;

/** `ctx.kv` namespace holding one blueprint per thread. */
export const BLUEPRINT_NAMESPACE = 'pod-creator/blueprints';

/** A design session that idles longer than this is discarded. */
const DEFAULT_TTL_MS = 24 * 60 * 60 * 1000;
/** Design sessions retained per user before LRU eviction. */
const DEFAULT_MAX_ENTRIES = 500;

export interface KvBlueprintStoreOptions {
  maxEntries?: number;
  ttlMs?: number;
}

const nowIso = (): string => new Date().toISOString();

/**
 * Parse a stored blueprint. A row that no longer matches the schema is
 * reported rather than silently treated as absent: the user can discard it
 * with `start_pod_design({ restart: true })`.
 */
function parseStored(threadId: string, value: unknown): PodBlueprint | null {
  if (value === undefined) return null;
  const parsed = podBlueprintSchema.safeParse(value);
  if (!parsed.success) {
    throw new Error(
      `The stored POD blueprint for thread ${threadId} is unreadable (${parsed.error.issues
        .map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`)
        .join(
          '; ',
        )}). Restart the design with start_pod_design({ restart: true }).`,
    );
  }
  return parsed.data;
}

/**
 * {@link BlueprintStore} over the host's `ctx.kv` rows in the user's own
 * database: the blueprint survives the user object being evicted and restored
 * from its owner copy. Bounded per user (LRU + idle TTL, enforced by the KV
 * store on every write), and every mutation is one atomic read-modify-write,
 * so specialists submitting sections concurrently never lose one another's.
 * Values cross the store as JSON, so a caller can never mutate the stored
 * document in place.
 */
export class KvBlueprintStore implements BlueprintStore {
  private readonly writeOptions: { idleTtlMs: number; maxEntries: number };

  constructor(
    private readonly kv: UserKvSurface,
    options: KvBlueprintStoreOptions = {},
  ) {
    this.writeOptions = {
      idleTtlMs: options.ttlMs ?? DEFAULT_TTL_MS,
      maxEntries: options.maxEntries ?? DEFAULT_MAX_ENTRIES,
    };
  }

  async init(
    threadId: string,
    brief: string | undefined,
  ): Promise<PodBlueprint> {
    const written = await this.kv.update(
      BLUEPRINT_NAMESPACE,
      threadId,
      (current) => {
        const existing = parseStored(threadId, current);
        if (existing) {
          if (brief && existing.brief === undefined) {
            return { ...existing, brief, updatedAt: nowIso() };
          }
          return existing;
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
        return created;
      },
      this.writeOptions,
    );
    return this.required(threadId, written);
  }

  async get(threadId: string): Promise<PodBlueprint | null> {
    return parseStored(
      threadId,
      await this.kv.get(BLUEPRINT_NAMESPACE, threadId),
    );
  }

  async putSection(
    threadId: string,
    section: BlueprintSection,
  ): Promise<PodBlueprint> {
    const written = await this.kv.update(
      BLUEPRINT_NAMESPACE,
      threadId,
      (current) => {
        const now = nowIso();
        const bp = parseStored(threadId, current) ?? {
          threadId,
          sections: {},
          createdAt: now,
          updatedAt: now,
        };
        return {
          ...bp,
          sections: { ...bp.sections, [section.role]: section },
          updatedAt: now,
        };
      },
      this.writeOptions,
    );
    return this.required(threadId, written);
  }

  async reset(threadId: string): Promise<void> {
    await this.kv.delete(BLUEPRINT_NAMESPACE, threadId);
  }

  private required(threadId: string, written: unknown): PodBlueprint {
    const bp = parseStored(threadId, written);
    if (!bp) {
      throw new Error(`POD blueprint for thread ${threadId} was not written`);
    }
    return bp;
  }
}

/**
 * A minimal, in-process, conformant Memory Engine.
 *
 * Purpose is NOT to be a usable engine — there is no extraction, no ranking,
 * no persistence. It exists so the conformance suite can be verified against a
 * known-good target, and so each check can be shown to FAIL when a specific
 * rule is broken (`defects`). A suite that has never been shown to fail is
 * indistinguishable from a suite that cannot fail.
 *
 * It also doubles as the smallest readable answer to "what does the contract
 * actually require?" — roughly 200 lines, no graph database involved.
 *
 * Spec: `specs/memory-engine-contract-v1.md`.
 */
import {
  REQUIRED_TOOLS,
  type BatchQuery,
  type BatchSlot,
  type IngestMessage,
  type MemoryEngineProbe,
  type ProbeAuth,
  type ProbeOutcome,
  type ProbeToolDescriptor,
} from './types.js';

/**
 * Deliberate contract violations, used to prove the checks discriminate.
 * Each flag should break exactly one check.
 */
export interface ReferenceEngineDefects {
  /** Accept requests with no invocation → breaks MEC-04. */
  allowUnauthenticated?: boolean;
  /** Accept expired invocations → breaks MEC-05. */
  ignoreExpiry?: boolean;
  /** Serve requests with no `x-room-id` → breaks MEC-07. */
  ignoreRoomId?: boolean;
  /** Treat missing confirmation flags as consent → breaks MEC-11. */
  ignoreConfirmation?: boolean;
  /** Return user-space rows at `knowledge_level=oracle` → breaks MEC-12. */
  leakUserSpaceToOracleScope?: boolean;
  /** Partition on the room header alone, ignoring the issuer → breaks MEC-13. */
  partitionByRoomOnly?: boolean;
  /** Omit a tool from `tools/list` → breaks MEC-02. */
  omitTool?: string;
  /** Return fewer batch slots than queries → breaks MEC-15. */
  truncateBatch?: boolean;
  /** Fail the whole batch when any query is malformed → breaks MEC-16. */
  failWholeBatch?: boolean;
}

/** Invocation format this double understands: `ref:<did>` / `ref-expired:<did>`. */
const VALID_PREFIX = 'ref:';
const EXPIRED_PREFIX = 'ref-expired:';

/** Mint an opaque invocation for a test identity. */
export function referenceInvocation(did: string): string {
  return `${VALID_PREFIX}${did}`;
}

/** Mint an already-expired invocation for the same identity. */
export function expiredReferenceInvocation(did: string): string {
  return `${EXPIRED_PREFIX}${did}`;
}

interface Episode {
  uuid: string;
  name: string;
  content: string;
  space: 'user' | 'oracle';
}

const ok = <T>(value: T): ProbeOutcome<T> => ({ ok: true, value });
const reject = <T>(status: number, error: string): ProbeOutcome<T> => ({
  ok: false,
  status,
  error,
});

export class ReferenceMemoryEngine implements MemoryEngineProbe {
  /** partition key → episodes. */
  private readonly store = new Map<string, Episode[]>();

  private seq = 0;

  constructor(private readonly defects: ReferenceEngineDefects = {}) {}

  // ─── auth + partitioning (§3, §4) ──────────────────────────────────────────

  /**
   * Resolve a request to a partition, or an HTTP status describing why not.
   * The issuer comes from the invocation, never from the body — that is the
   * property MEC-13 exists to verify.
   */
  private partition(
    auth: ProbeAuth,
  ): { key: string } | { status: number; error: string } {
    if (auth.invocation === null) {
      if (!this.defects.allowUnauthenticated) {
        return { status: 401, error: 'missing UCAN invocation' };
      }
    } else if (auth.invocation.startsWith(EXPIRED_PREFIX)) {
      if (!this.defects.ignoreExpiry) {
        return { status: 401, error: 'invocation expired' };
      }
    } else if (!auth.invocation.startsWith(VALID_PREFIX)) {
      return { status: 401, error: 'malformed invocation' };
    }

    if (auth.roomId === null && !this.defects.ignoreRoomId) {
      return { status: 400, error: 'missing x-room-id' };
    }

    const issuer =
      auth.invocation?.replace(EXPIRED_PREFIX, '').replace(VALID_PREFIX, '') ??
      'anonymous';

    // The defect: keying on the room alone lets anyone who knows a room id read
    // that room's memory, which is exactly the shared-database failure mode.
    const key = this.defects.partitionByRoomOnly
      ? `room:${auth.roomId ?? 'none'}`
      : `${issuer}::${auth.roomId ?? 'none'}`;
    return { key };
  }

  private episodes(key: string): Episode[] {
    let list = this.store.get(key);
    if (!list) {
      list = [];
      this.store.set(key, list);
    }
    return list;
  }

  private confirmed(args: Record<string, unknown>, field: string): boolean {
    return this.defects.ignoreConfirmation || args[field] === true;
  }

  // ─── MCP surface (§5) ──────────────────────────────────────────────────────

  async listTools(
    auth: ProbeAuth,
  ): Promise<ProbeOutcome<ProbeToolDescriptor[]>> {
    const p = this.partition(auth);
    if ('status' in p) return reject(p.status, p.error);

    return ok(
      REQUIRED_TOOLS.filter((name) => name !== this.defects.omitTool).map(
        (name) => ({
          name,
          description: `Reference implementation of ${name} (contract v1).`,
        }),
      ),
    );
  }

  async callTool(
    name: string,
    args: Record<string, unknown>,
    auth: ProbeAuth,
  ): Promise<ProbeOutcome<unknown>> {
    const p = this.partition(auth);
    if ('status' in p) return reject(p.status, p.error);
    const store = this.episodes(p.key);

    switch (name) {
      case 'search_memory_engine': {
        const query = typeof args.query === 'string' ? args.query : '';
        if (query.length === 0) return reject(400, 'query is required');
        const strategy = typeof args.strategy === 'string' ? args.strategy : '';
        if (
          strategy === 'contextual' &&
          typeof args.center_node_uuid !== 'string'
        ) {
          return reject(400, 'strategy "contextual" requires center_node_uuid');
        }

        const level = (args.knowledge_level as string | undefined) ?? 'both';
        const visible = store.filter((e) => {
          if (this.defects.leakUserSpaceToOracleScope) return true;
          if (level === 'both') return true;
          return e.space === level;
        });

        // Substring match stands in for hybrid retrieval. Ranking is explicitly
        // not constrained by the contract (§1), so a trivial matcher is
        // conformant.
        const hits = visible.filter(
          (e) => e.content.includes(query) || e.name.includes(query),
        );
        return ok({
          strategy_used: strategy || 'balanced',
          query,
          total_results: {
            facts: 0,
            entities: 0,
            episodes: hits.length,
            communities: 0,
          },
          facts: [],
          entities: [],
          episodes: hits.map((e) => ({
            uuid: e.uuid,
            name: e.name,
            content: e.content,
            created_at: new Date(0).toISOString(),
            group_id: p.key,
          })),
          communities: [],
        });
      }

      case 'add_memory': {
        if (typeof args.name !== 'string' || typeof args.content !== 'string') {
          return reject(400, 'name and content are required');
        }
        const uuid = `ep-${++this.seq}`;
        store.push({
          uuid,
          name: args.name,
          content: args.content,
          space: 'user',
        });
        return ok({ uuid, status: 'stored' });
      }

      case 'add_oracle_knowledge': {
        if (!this.confirmed(args, 'confirmed_insertion_from_user')) {
          return reject(400, 'confirmed_insertion_from_user must be true');
        }
        if (
          args.knowledge_space_type !== 'public' &&
          args.knowledge_space_type !== 'private'
        ) {
          return reject(
            400,
            'knowledge_space_type must be "public" or "private"',
          );
        }
        if (typeof args.name !== 'string' || typeof args.content !== 'string') {
          return reject(400, 'name and content are required');
        }
        const uuid = `ok-${++this.seq}`;
        store.push({
          uuid,
          name: args.name,
          content: args.content,
          space: 'oracle',
        });
        return ok({ uuid, status: 'stored' });
      }

      case 'delete_episode': {
        if (!this.confirmed(args, 'confirmed_deletion_from_user')) {
          return reject(400, 'confirmed_deletion_from_user must be true');
        }
        const uuid = args.episode_uuid;
        const index = store.findIndex((e) => e.uuid === uuid);
        if (index >= 0) store.splice(index, 1);
        return ok({ deleted: index >= 0 });
      }

      case 'delete_edge': {
        if (!this.confirmed(args, 'confirmed_deletion_from_user')) {
          return reject(400, 'confirmed_deletion_from_user must be true');
        }
        return ok({ deleted: false });
      }

      case 'clear': {
        if (!this.confirmed(args, 'confirmed_deletion_from_user')) {
          return reject(400, 'confirmed_deletion_from_user must be true');
        }
        this.store.set(p.key, []);
        return ok({ cleared: true });
      }

      default:
        return reject(404, `unknown tool "${name}"`);
    }
  }

  // ─── REST surface (§6) ─────────────────────────────────────────────────────

  async searchBatch(
    queries: BatchQuery[],
    auth: ProbeAuth,
  ): Promise<ProbeOutcome<{ results: BatchSlot[] }>> {
    const p = this.partition(auth);
    if ('status' in p) return reject(p.status, p.error);

    const malformed = queries.some(
      (q) => q.strategy === 'contextual' && !q.center_node_uuid,
    );
    if (malformed && this.defects.failWholeBatch) {
      return reject(400, 'batch contains an invalid query');
    }

    const results: BatchSlot[] = queries.map((q) => {
      if (q.strategy === 'contextual' && !q.center_node_uuid) {
        return {
          error: {
            status_code: 400,
            detail: 'contextual requires center_node_uuid',
          },
          query: q.query,
          strategy_used: 'contextual',
        };
      }
      return {
        strategy_used: q.strategy ?? 'balanced',
        query: q.query,
        total_results: { facts: 0, entities: 0, episodes: 0, communities: 0 },
        facts: [],
        entities: [],
        episodes: [],
        communities: [],
      };
    });

    return ok({
      results: this.defects.truncateBatch ? results.slice(1) : results,
    });
  }

  async postMessages(
    messages: IngestMessage[],
    auth: ProbeAuth,
  ): Promise<ProbeOutcome<unknown>> {
    const p = this.partition(auth);
    if ('status' in p) return reject(p.status, p.error);
    if (!Array.isArray(messages) || messages.length === 0) {
      return reject(400, 'messages must be a non-empty array');
    }
    for (const m of messages) {
      if (typeof m.content !== 'string' || typeof m.role_type !== 'string') {
        return reject(400, 'each message needs content and role_type');
      }
    }
    return ok({ accepted: messages.length });
  }
}

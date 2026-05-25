import { Logger } from '@ixo/logger';
import {
  isBatchErrorSlot,
  type SearchEnhancedBatchRequest,
  type SearchEnhancedBatchResponse,
  type SearchEnhancedRequest,
  type SearchEnhancedResponse,
  type UserContextData,
} from './types.js';

interface MemoryEngineAuthHeaders {
  oracleToken: string;
  userToken: string;
  oracleHomeServer: string;
  userHomeServer: string;
  /** When set, uses UCAN auth instead of Matrix tokens */
  ucanInvocation?: string;
}

export class MemoryEngineService {
  // Soft deadline: how long the caller waits before falling back to empty
  // context. The underlying fetch keeps running in the background up to
  // BATCH_HARD_TIMEOUT_MS so the server-side query can still finish (and warm
  // caches) even after the user's turn has moved on.
  private readonly BATCH_TIMEOUT_MS = 30000;
  // Hard cap on the underlying fetch — prevents leaking sockets if the server
  // never responds. Anything slower than this is treated as a real failure.
  private readonly BATCH_HARD_TIMEOUT_MS = 60000;

  constructor(private readonly memoryEngineUrl: string) {}

  /**
   * Build HTTP headers for memory engine requests (UCAN or Matrix)
   */
  private buildHeaders(
    auth: MemoryEngineAuthHeaders,
    roomId: string,
  ): Record<string, string> {
    if (auth.ucanInvocation) {
      return {
        Authorization: `Bearer ${auth.ucanInvocation}`,
        'X-Auth-Type': 'ucan',
        'x-room-id': roomId,
        'Content-Type': 'application/json',
      };
    }
    return {
      'x-oracle-token': auth.oracleToken,
      'x-user-token': auth.userToken,
      'x-oracle-matrix-homeserver': auth.oracleHomeServer,
      'x-user-matrix-homeserver': auth.userHomeServer,
      'x-room-id': roomId,
      'Content-Type': 'application/json',
    };
  }

  /**
   * Gather user context from Memory Engine by executing 6 parallel queries
   */
  async gatherUserContext(params: {
    oracleDid: string;
    roomId: string;
    oracleToken: string;
    userToken: string;
    oracleHomeServer: string;
    userHomeServer: string;
    /** When set, uses UCAN auth instead of Matrix tokens */
    ucanInvocation?: string;
  }): Promise<UserContextData> {
    const {
      oracleDid,
      roomId,
      oracleToken,
      userToken,
      oracleHomeServer,
      userHomeServer,
      ucanInvocation,
    } = params;

    Logger.info(
      `[MemoryEngineService] Gathering user context for oracle: ${oracleDid}, room: ${roomId}`,
    );

    const authHeaders: MemoryEngineAuthHeaders = {
      oracleToken,
      userToken,
      oracleHomeServer,
      userHomeServer,
      ucanInvocation,
    };

    // The 6 queries that make up userContext. Order matters: it determines
    // how we map batch result slots back to UserContextData fields.
    const labels = [
      'identity',
      'work',
      'goals',
      'interests',
      'relationships',
      'recent',
    ] as const;
    const requests: SearchEnhancedRequest[] = [
      this.buildIdentityRequest(oracleDid),
      this.buildWorkRequest(oracleDid),
      this.buildGoalsRequest(oracleDid),
      this.buildInterestsRequest(oracleDid),
      this.buildRelationshipsRequest(oracleDid),
      this.buildRecentRequest(oracleDid),
    ];

    const gatherStart = Date.now();
    const batch = await this.executeBatch(requests, roomId, authHeaders);
   
    const gatherElapsed = Date.now() - gatherStart;

    if (!batch) {
      Logger.error(
        `[MemoryEngineService] gatherUserContext failed after ${gatherElapsed}ms — returning empty context`,
      );
      return {};
    }
    
    // Map each slot back to the labelled field. Error slots become undefined.
    const fields: (SearchEnhancedResponse | undefined)[] = batch.results.map(
      (slot, index) => {
        const label = labels[index];
        if (isBatchErrorSlot(slot)) {
          Logger.warn(
            `[MemoryEngineService] Batch slot "${label}" failed (${slot.error.status_code}): ${slot.error.detail}`,
          );
          return undefined;
        }
        return slot;
      },
    );

    if (batch.results.length !== labels.length) {
      Logger.warn(
        `[MemoryEngineService] Batch length mismatch: expected ${labels.length}, got ${batch.results.length}`,
      );
    }

    const summary = labels.map((label, index) => {
      const value = fields[index];
      if (value === undefined) return `${label}=missing`;
      return `${label}=ok(f${value.total_results.facts}/e${value.total_results.entities})`;
    });
    Logger.info(
      `[MemoryEngineService] gatherUserContext completed in ${gatherElapsed}ms (batch) — ${summary.join(', ')}`,
    );

    return {
      identity: fields[0],
      work: fields[1],
      goals: fields[2],
      interests: fields[3],
      relationships: fields[4],
      recent: fields[5],
    };
  }

  /**
   * POST /search-enhanced-batch — single round-trip for N parallel queries.
   * Returns undefined on transport/HTTP failure; a partially-failed batch
   * still resolves with per-slot error markers (handled by caller via
   * `isBatchErrorSlot`).
   */
  private async executeBatch(
    queries: SearchEnhancedRequest[],
    roomId: string,
    auth: MemoryEngineAuthHeaders,
  ): Promise<SearchEnhancedBatchResponse | undefined> {
    if (!roomId) {
      Logger.warn(
        `[MemoryEngineService] No room id provided, skipping batch search`,
      );
      return undefined;
    }
    if (!auth.ucanInvocation && (!auth.oracleToken || !auth.userToken)) {
      Logger.warn(
        `[MemoryEngineService] Missing auth (no UCAN and no Matrix tokens), skipping batch search`,
      );
      return undefined;
    }

    const body: SearchEnhancedBatchRequest = { queries };

    // Hard cap aborts the fetch so a hung server can't leak sockets. The soft
    // deadline below is what the caller actually awaits.
    const hardController = new AbortController();
    const hardTimer = setTimeout(
      () => hardController.abort(),
      this.BATCH_HARD_TIMEOUT_MS,
    );

    const start = Date.now();

    const requestPromise: Promise<SearchEnhancedBatchResponse | undefined> =
      (async () => {
        try {
          const response = await fetch(
            `${this.memoryEngineUrl}/search-enhanced-batch`,
            {
              method: 'POST',
              headers: this.buildHeaders(auth, roomId),
              body: JSON.stringify(body),
              signal: hardController.signal,
            },
          );

          if (!response.ok) {
            const errorText = await response.text();
            Logger.warn(
              `[MemoryEngineService] Batch search failed (${response.status}): ${errorText}`,
            );
            return undefined;
          }

          return (await response.json()) as SearchEnhancedBatchResponse;
        } catch (error) {
          if ((error as Error).name === 'AbortError') {
            Logger.warn(
              `[MemoryEngineService] Batch search hit hard cap after ${this.BATCH_HARD_TIMEOUT_MS}ms — aborted`,
            );
          } else {
            Logger.error(`[MemoryEngineService] Batch search threw:`, error);
          }
          return undefined;
        } finally {
          clearTimeout(hardTimer);
        }
      })();

    type Outcome =
      | { kind: 'result'; value: SearchEnhancedBatchResponse | undefined }
      | { kind: 'timeout' };

    let softTimer: ReturnType<typeof setTimeout> | undefined;
    const softDeadline = new Promise<Outcome>((resolve) => {
      softTimer = setTimeout(
        () => resolve({ kind: 'timeout' }),
        this.BATCH_TIMEOUT_MS,
      );
    });

    const outcome = await Promise.race<Outcome>([
      requestPromise.then((value): Outcome => ({ kind: 'result', value })),
      softDeadline,
    ]);

    if (softTimer) clearTimeout(softTimer);

    if (outcome.kind === 'timeout') {
      Logger.warn(
        `[MemoryEngineService] Batch search exceeded ${this.BATCH_TIMEOUT_MS}ms soft deadline — returning empty context, request continues in background (hard cap ${this.BATCH_HARD_TIMEOUT_MS}ms)`,
      );
      void requestPromise.then((result) => {
        const elapsed = Date.now() - start;
        if (result) {
          Logger.info(
            `[MemoryEngineService] Background batch search finished after ${elapsed}ms (caller gave up at ${this.BATCH_TIMEOUT_MS}ms)`,
          );
        } else {
          Logger.warn(
            `[MemoryEngineService] Background batch search returned no data after ${elapsed}ms`,
          );
        }
      });
      return undefined;
    }

    return outcome.value;
  }

  // ── Per-query request builders ────────────────────────────────────────────
  // These produce SearchEnhancedRequest payloads consumed by gatherUserContext
  // via the batch endpoint. Order matches the labels array in
  // gatherUserContext — keep the two in sync.

  // Design notes for the query builders:
  //
  // 1. Queries are natural-language sentences, not keyword bags. Embedding
  //    search ranks by semantic similarity — a sentence that names both the
  //    abstract concept ("what the user works on") and concrete examples
  //    ("tools, projects, people they collaborate with") aligns far better
  //    with how real memories are phrased than a thesaurus of synonyms.
  //
  // 2. `edge_types` is deliberately not used. It is AND-ed with node_labels
  //    before scoring, and the extractor's edge choices vary too much to
  //    predict (a work mention may produce WorksWith, Mentions, Discusses,
  //    RelatesTo). One filter miss drops the whole fact. Semantic scoring
  //    handles discrimination better than guessing edge types.
  //
  // 3. `node_labels` is kept where it's discriminating but broadened to cover
  //    the EntityType variants the extractor actually emits (Event/Experience/
  //    Procedure/Task all show up for work episodes, for example).
  //
  // 4. `invalid_at IS NULL` filters out facts that have been superseded —
  //    kept everywhere except `recent`, which already constrains on created_at.

  private buildIdentityRequest(oracleDid: string): SearchEnhancedRequest {
    return {
      oracle_dids: [oracleDid],
      query:
        'Who is the user — their name, age, background, personality traits, communication style, beliefs, values, and the core attributes that define how they see themselves and how they like to be addressed.',
      strategy: 'balanced',
      max_facts: 12,
      max_entities: 8,
      max_episodes: 3,
      max_communities: 2,
      knowledge_level: 'both',
      search_filters: {
        node_labels: [
          'Person',
          'Trait',
          'Value',
          'Identity',
          'Attribute',
          'Belief',
          'CommunicationStyle',
          'Language',
        ],
        invalid_at: [[{ date: null, comparison_operator: 'IS NULL' }]],
      },
    };
  }

  private buildWorkRequest(oracleDid: string): SearchEnhancedRequest {
    return {
      oracle_dids: [oracleDid],
      query:
        'What the user works on — their job and role, current and past projects, the tools and technologies they use, code or systems they build, technical problems they solve (migrations, refactors, bug fixes, integrations), and the people they collaborate with at work.',
      strategy: 'balanced',
      max_facts: 15,
      max_entities: 10,
      max_episodes: 5,
      max_communities: 2,
      knowledge_level: 'both',
      search_filters: {
        invalid_at: [[{ date: null, comparison_operator: 'IS NULL' }]],
      },
    };
  }

  private buildGoalsRequest(oracleDid: string): SearchEnhancedRequest {
    return {
      oracle_dids: [oracleDid],
      query:
        'What the user is trying to achieve or improve — goals and aspirations they have stated, things they are learning, habits and routines they are building, milestones they are working toward, and causes they care about.',
      strategy: 'balanced',
      max_facts: 10,
      max_entities: 6,
      max_episodes: 3,
      max_communities: 1,
      knowledge_level: 'both',
      search_filters: {
        invalid_at: [[{ date: null, comparison_operator: 'IS NULL' }]],
      },
    };
  }

  private buildInterestsRequest(oracleDid: string): SearchEnhancedRequest {
    return {
      oracle_dids: [oracleDid],
      query:
        'What the user enjoys, cares about, or finds interesting — hobbies, favorite topics, preferences, products and content they engage with, things they like and dislike, and areas they have built expertise in outside of work.',
      strategy: 'balanced',
      max_facts: 10,
      max_entities: 6,
      max_episodes: 3,
      max_communities: 1,
      knowledge_level: 'both',
      search_filters: {
        invalid_at: [[{ date: null, comparison_operator: 'IS NULL' }]],
      },
    };
  }

  private buildRelationshipsRequest(oracleDid: string): SearchEnhancedRequest {
    return {
      oracle_dids: [oracleDid],
      query:
        'People the user interacts with or has mentioned — colleagues they work with, collaborators on projects, friends and family members, and any named individuals or groups they have brought up in conversation.',
      strategy: 'balanced',
      max_facts: 8,
      max_entities: 10,
      max_episodes: 3,
      max_communities: 1,
      knowledge_level: 'both',
      search_filters: {
        invalid_at: [[{ date: null, comparison_operator: 'IS NULL' }]],
      },
    };
  }

  private buildRecentRequest(oracleDid: string): SearchEnhancedRequest {
    // Server-side `recent_memory` strategy auto-injects a created_at >= now-90d
    // filter. We still pass it explicitly as defense-in-depth — the server's
    // merge logic respects an existing lower bound and won't double-apply.
    // No node_labels filter: recent activity can be of any type, and the
    // created_at window is already doing the heavy filtering.
    const ninetyDaysAgo = new Date();
    ninetyDaysAgo.setDate(ninetyDaysAgo.getDate() - 90);
    const dateString = ninetyDaysAgo.toISOString();

    return {
      oracle_dids: [oracleDid],
      query:
        'What the user has been doing, focusing on, or talking about recently — current activities, decisions they have made, ongoing problems they are working through, and topics that have come up in recent conversations.',
      strategy: 'recent_memory',
      max_facts: 10,
      max_entities: 6,
      max_episodes: 8,
      max_communities: 2,
      knowledge_level: 'both',
      search_filters: {
        created_at: [[{ date: dateString, comparison_operator: '>=' }]],
      },
    };
  }

  /**
   * Process conversation history by sending messages to the Memory Engine
   */
  async processConversationHistory({
    messages,
    roomId,
    oracleToken = '',
    userToken = '',
    oracleHomeServer = '',
    userHomeServer = '',
    ucanInvocation,
  }: {
    messages: Array<{
      content: string;
      role_type: 'user' | 'assistant' | 'system';
      role?: string;
      name?: string;
      source_description?: string;
    }>;
    roomId: string;
    /** Deprecated — Matrix bearer auth. Use `ucanInvocation` instead. */
    oracleToken?: string;
    /** Deprecated — Matrix bearer auth. Use `ucanInvocation` instead. */
    userToken?: string;
    /** Deprecated — Matrix bearer auth. Use `ucanInvocation` instead. */
    oracleHomeServer?: string;
    /** Deprecated — Matrix bearer auth. Use `ucanInvocation` instead. */
    userHomeServer?: string;
    /** Required under UCAN-only auth. */
    ucanInvocation?: string;
  }): Promise<{ success: boolean }> {
    if (!roomId) {
      Logger.warn(
        `[MemoryEngineService] No room id provided, skipping conversation processing`,
      );
      return { success: false };
    }
    if (!ucanInvocation && (!oracleToken || !userToken)) {
      Logger.warn(
        `[MemoryEngineService] Missing auth (no UCAN and no Matrix tokens), skipping conversation processing`,
      );
      return { success: false };
    }
    if (!messages || messages.length === 0) {
      Logger.info(
        `[MemoryEngineService] No messages to process for room ${roomId}`,
      );
      return { success: true };
    }

    try {
      const auth: MemoryEngineAuthHeaders = {
        oracleToken,
        userToken,
        oracleHomeServer,
        userHomeServer,
        ucanInvocation,
      };
      const response = await fetch(`${this.memoryEngineUrl}/messages`, {
        method: 'POST',
        headers: this.buildHeaders(auth, roomId),
        body: JSON.stringify({ messages }),
      });

      if (!response.ok) {
        const errorText = await response.text();
        Logger.warn(
          `[MemoryEngineService] Memory Engine conversation processing failed (${response.status}): ${errorText}`,
        );
        return { success: false };
      }

      Logger.info(
        `[MemoryEngineService] Successfully processed ${messages.length} messages for room ${roomId}`,
      );
      return { success: true };
    } catch (error) {
      Logger.error(
        `[MemoryEngineService] Failed to process conversation history for room ${roomId}:`,
        error,
      );
      return { success: false };
    }
  }
}

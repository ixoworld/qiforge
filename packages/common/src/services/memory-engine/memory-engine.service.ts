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
  // Batch covers 6 queries running in parallel server-side. Bound by the
  // slowest query, not 6× — but we leave headroom for cold caches.
  private readonly BATCH_TIMEOUT_MS = 15000;

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

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.BATCH_TIMEOUT_MS);

    try {
      const response = await fetch(
        `${this.memoryEngineUrl}/search-enhanced-batch`,
        {
          method: 'POST',
          headers: this.buildHeaders(auth, roomId),
          body: JSON.stringify(body),
          signal: controller.signal,
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
          `[MemoryEngineService] Batch search aborted after ${this.BATCH_TIMEOUT_MS}ms`,
        );
      } else {
        Logger.error(`[MemoryEngineService] Batch search threw:`, error);
      }
      return undefined;
    } finally {
      clearTimeout(timer);
    }
  }

  // ── Per-query request builders ────────────────────────────────────────────
  // These produce SearchEnhancedRequest payloads consumed by gatherUserContext
  // via the batch endpoint. Order matches the labels array in
  // gatherUserContext — keep the two in sync.

  private buildIdentityRequest(oracleDid: string): SearchEnhancedRequest {
    return {
      oracle_dids: [oracleDid],
      query:
        'username and nickname and age user identity traits values personality characteristics communication style beliefs preferences',
      strategy: 'balanced',
      max_facts: 10,
      max_entities: 6,
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
          'Emotion',
          'Belief',
          'CommunicationStyle',
        ],
        invalid_at: [[{ date: null, comparison_operator: 'IS NULL' }]],
      },
    };
  }

  private buildWorkRequest(oracleDid: string): SearchEnhancedRequest {
    return {
      oracle_dids: [oracleDid],
      query:
        'work job career projects skills organization employment role responsibilities expertise',
      strategy: 'balanced',
      max_facts: 10,
      max_entities: 6,
      max_episodes: 3,
      max_communities: 2,
      knowledge_level: 'both',
      search_filters: {
        node_labels: [
          'Job',
          'Project',
          'Organization',
          'Skill',
          'Tool',
          'Expertise',
          'Task',
        ],
        edge_types: [
          'EmployedAt',
          'WorksOn',
          'Manages',
          'Uses',
          'ExpertiseIn',
          'WorksWith',
        ],
        invalid_at: [[{ date: null, comparison_operator: 'IS NULL' }]],
      },
    };
  }

  private buildGoalsRequest(oracleDid: string): SearchEnhancedRequest {
    return {
      oracle_dids: [oracleDid],
      query:
        'goals aspirations objectives milestones habits routines patterns achievements progress',
      strategy: 'balanced',
      max_facts: 8,
      max_entities: 4,
      max_episodes: 3,
      max_communities: 1,
      knowledge_level: 'both',
      search_filters: {
        node_labels: [
          'Goal',
          'Milestone',
          'Habit',
          'Routine',
          'Pattern',
          'LearningGoal',
        ],
        edge_types: ['Pursuing', 'Achieved', 'Practices', 'Motivates'],
        invalid_at: [[{ date: null, comparison_operator: 'IS NULL' }]],
      },
    };
  }

  private buildInterestsRequest(oracleDid: string): SearchEnhancedRequest {
    return {
      oracle_dids: [oracleDid],
      query:
        'interests hobbies passions preferences likes dislikes expertise topics content',
      strategy: 'balanced',
      max_facts: 8,
      max_entities: 4,
      max_episodes: 3,
      max_communities: 1,
      knowledge_level: 'both',
      search_filters: {
        node_labels: [
          'Interest',
          'Hobby',
          'Preference',
          'Product',
          'Content',
          'Expertise',
          'Resource',
        ],
        edge_types: [
          'Prefers',
          'Likes',
          'Dislikes',
          'InterestedIn',
          'ExpertiseIn',
        ],
        invalid_at: [[{ date: null, comparison_operator: 'IS NULL' }]],
      },
    };
  }

  private buildRelationshipsRequest(oracleDid: string): SearchEnhancedRequest {
    return {
      oracle_dids: [oracleDid],
      query:
        'relationships people connections social network colleagues friends family contacts',
      strategy: 'balanced',
      max_facts: 6,
      max_entities: 6,
      max_episodes: 2,
      max_communities: 1,
      knowledge_level: 'both',
      search_filters: {
        node_labels: ['Person', 'Group'],
        edge_types: [
          'Knows',
          'WorksWith',
          'MemberOf',
          'Influences',
          'Supports',
          'RelatesTo',
        ],
        invalid_at: [[{ date: null, comparison_operator: 'IS NULL' }]],
      },
    };
  }

  private buildRecentRequest(oracleDid: string): SearchEnhancedRequest {
    // Server-side `recent_memory` strategy auto-injects a created_at >= now-90d
    // filter. We still pass it explicitly as defense-in-depth — the server's
    // merge logic respects an existing lower bound and won't double-apply.
    const ninetyDaysAgo = new Date();
    ninetyDaysAgo.setDate(ninetyDaysAgo.getDate() - 90);
    const dateString = ninetyDaysAgo.toISOString();

    return {
      oracle_dids: [oracleDid],
      query:
        'recent conversations messages discussions activities updates interactions',
      strategy: 'recent_memory',
      max_facts: 8,
      max_entities: 4,
      max_episodes: 6,
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

/**
 * Session-history → memory-engine indexing — the Workers port of the Node
 * runtime's `SessionHistoryProcessor` (`modules/sessions/session-history-
 * processor.service.ts`).
 *
 * Policy (identical to Node):
 *  - Runs in the background when a session is CREATED (indexes the most
 *    recent previous session) and when a session is DELETED (indexes it
 *    before it goes). The request never waits for, or fails on, indexing.
 *  - Only messages after the session's `lastProcessedCount` are sent, then
 *    the count is advanced — a session is never indexed twice.
 *  - Speakers get real identities (the user's preferred name / the oracle's
 *    preferred or configured name) so Graphiti's extractor does not pin
 *    facts to literal "user"/"assistant" nodes. Tool replies fold into the
 *    assistant role (the engine has no tool role).
 *  - Auth is the oracle's two-hop UCAN invocation minted from the user's
 *    delegation (`ixo:memory` / `memory/*`) — no delegation, no indexing.
 *  - Endpoint: `POST <MEMORY_ENGINE_URL>/messages` with `x-room-id`, as
 *    `@ixo/common`'s `MemoryEngineService.processConversationHistory`.
 *  - A per-session lock prevents overlapping runs; a failed upload is
 *    retried 3× with a 10 s pause (Node's numbers).
 *
 * Not ported: Node also asks Matrix for the user's display name when no
 * preferred name is set; here the fallback is the literal "Me" straight away.
 */
import type { Logger } from '../plugin-api/types';

export interface HistoryMessage {
  /** LangChain message type: `human` | `ai` | `tool` | `system`. */
  type: string;
  content: string;
}

export interface MemoryEngineMessage {
  content: string;
  role_type: 'user' | 'assistant' | 'system';
  role?: string;
  name?: string;
  source_description?: string;
}

export interface IndexableSession {
  title?: string;
  roomId?: string;
  lastProcessedCount?: number;
}

export interface SpeakerLabels {
  user: string;
  oracle: string;
}

export interface SessionHistoryIndexerDeps {
  /** `MEMORY_ENGINE_URL`; undefined disables indexing (memory plugin absent). */
  memoryEngineUrl: string | undefined;
  getSession(sessionId: string): Promise<IndexableSession | undefined>;
  /** The session transcript, summarisation bookkeeping already removed. */
  listMessages(sessionId: string): Promise<HistoryMessage[]>;
  setProcessedCount(sessionId: string, count: number): Promise<void>;
  /** The user↔oracle room, for sessions whose row carries none. */
  resolveUserRoom(): Promise<{ roomId: string } | null>;
  ucan: {
    hasSigningKey(): boolean;
    resolveServiceDid(serviceUrl: string): Promise<string | null>;
    mintInvocation(
      target: { did: string; capability: string },
      opts?: { can?: string },
    ): Promise<string>;
  };
  speakerLabels(roomId: string): Promise<SpeakerLabels>;
  logger: Logger;
  fetchImpl?: typeof fetch;
  /** Test hooks. */
  sleep?: (ms: number) => Promise<void>;
  maxRetries?: number;
  retryDelayMs?: number;
  /** Hard timeout for the memory-engine request (default 20 s). */
  requestTimeoutMs?: number;
}

export type IndexOutcome = 'processed' | 'skipped' | 'failed';

/**
 * Bounded background work: the indexer runs under `ctx.waitUntil`, so the
 * whole retry envelope keeps the user object resident (and un-hibernatable
 * with sockets attached). Two attempts, a short pause, and a hard timeout on
 * the memory-engine request keep that under a minute; a failed session is
 * simply retried on the next session create (the watermark did not move).
 */
const DEFAULT_MAX_RETRIES = 2;
const DEFAULT_RETRY_DELAY_MS = 3_000;
const DEFAULT_REQUEST_TIMEOUT_MS = 20_000;

/** Node's `transformMessagesToMemoryEngineFormat`, verbatim in mapping. */
export function transformMessagesToMemoryEngineFormat(
  messages: readonly HistoryMessage[],
  sessionTitle: string,
  userSpeakerLabel: string,
  oracleSpeakerLabel: string,
): MemoryEngineMessage[] {
  return messages.map((message) => {
    let role_type: MemoryEngineMessage['role_type'];
    let label: string;
    switch (message.type) {
      case 'human':
        role_type = 'user';
        label = userSpeakerLabel;
        break;
      case 'ai':
        role_type = 'assistant';
        label = oracleSpeakerLabel;
        break;
      case 'system':
        role_type = 'system';
        label = 'System';
        break;
      case 'tool':
        // The engine has no tool role — tool replies are the oracle
        // reporting back, so they share the oracle speaker label.
        role_type = 'assistant';
        label = oracleSpeakerLabel;
        break;
      default:
        role_type = 'user';
        label = userSpeakerLabel;
    }
    return {
      content: message.content,
      role_type,
      role: label,
      name: label,
      source_description: `Chat Session: ${sessionTitle}`,
    };
  });
}

function describe(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export class SessionHistoryIndexer {
  private readonly inFlight = new Set<string>();

  private readonly fetchImpl: typeof fetch;

  private readonly sleep: (ms: number) => Promise<void>;

  private readonly maxRetries: number;

  private readonly retryDelayMs: number;

  private readonly requestTimeoutMs: number;

  constructor(private readonly deps: SessionHistoryIndexerDeps) {
    this.fetchImpl = deps.fetchImpl ?? fetch.bind(globalThis);
    this.sleep =
      deps.sleep ??
      ((ms) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
    this.maxRetries = deps.maxRetries ?? DEFAULT_MAX_RETRIES;
    this.retryDelayMs = deps.retryDelayMs ?? DEFAULT_RETRY_DELAY_MS;
    this.requestTimeoutMs = deps.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
  }

  /** Sessions currently being indexed (background work keeping the object busy). */
  get inFlightCount(): number {
    return this.inFlight.size;
  }

  /** Whether indexing is configured at all (memory engine URL present). */
  get enabled(): boolean {
    return typeof this.deps.memoryEngineUrl === 'string';
  }

  /**
   * Index a session's unprocessed messages. Never throws: outcomes are
   * `processed`, `skipped` (nothing to do / prerequisites missing) or
   * `failed` (upload failed after retries). Concurrent calls for the same
   * session collapse into one.
   */
  async process(sessionId: string): Promise<IndexOutcome> {
    const { logger } = this.deps;
    if (!this.enabled) {
      logger.log(
        `[history-indexer] MEMORY_ENGINE_URL not configured; not indexing session ${sessionId}`,
      );
      return 'skipped';
    }
    if (this.inFlight.has(sessionId)) {
      logger.log(
        `[history-indexer] session ${sessionId} is already being indexed, skipping`,
      );
      return 'skipped';
    }
    this.inFlight.add(sessionId);
    try {
      for (let attempt = 1; attempt <= this.maxRetries; attempt += 1) {
        try {
          const outcome = await this.processOnce(sessionId);
          if (outcome === 'processed') {
            logger.log(
              `[history-indexer] indexed session ${sessionId} into the memory engine`,
            );
          }
          return outcome;
        } catch (err) {
          logger.warn(
            `[history-indexer] attempt ${attempt}/${this.maxRetries} failed for session ${sessionId}: ${describe(err)}`,
          );
          if (attempt === this.maxRetries) {
            logger.error(
              `[history-indexer] giving up on session ${sessionId} after ${this.maxRetries} attempts`,
            );
            return 'failed';
          }
          await this.sleep(this.retryDelayMs);
        }
      }
      return 'failed';
    } finally {
      this.inFlight.delete(sessionId);
    }
  }

  private async processOnce(sessionId: string): Promise<IndexOutcome> {
    const { deps } = this;
    const { logger } = deps;
    const memoryEngineUrl = deps.memoryEngineUrl!.replace(/\/+$/, '');

    const session = await deps.getSession(sessionId);
    if (!session) {
      logger.warn(`[history-indexer] session ${sessionId} not found, skipping`);
      return 'skipped';
    }

    const roomId =
      session.roomId ?? (await deps.resolveUserRoom())?.roomId ?? null;
    if (!roomId) {
      logger.warn(
        `[history-indexer] no oracle room for session ${sessionId}, skipping`,
      );
      return 'skipped';
    }

    const messages = await deps.listMessages(sessionId);
    if (messages.length === 0) {
      logger.log(`[history-indexer] no messages in session ${sessionId}`);
      return 'skipped';
    }

    const lastProcessedCount = session.lastProcessedCount ?? 0;
    const newMessages = messages.slice(lastProcessedCount);
    if (newMessages.length === 0) {
      logger.log(
        `[history-indexer] no new messages for session ${sessionId} (lastProcessedCount: ${lastProcessedCount})`,
      );
      return 'skipped';
    }

    const labels = await deps.speakerLabels(roomId);
    const transformed = transformMessagesToMemoryEngineFormat(
      // Tool-call-only AI turns carry no text; the engine has nothing to
      // extract from them and rejects empty episodes.
      newMessages.filter((m) => m.content.trim().length > 0),
      session.title ?? '',
      labels.user,
      labels.oracle,
    );

    if (!deps.ucan.hasSigningKey()) {
      logger.warn(
        `[history-indexer] no UCAN signing key; skipping memory engine processing for session ${sessionId}`,
      );
      return 'skipped';
    }

    // Node: a failed mint is a warn + skip, not a retry — the user simply has
    // not delegated `ixo:memory` to this oracle (yet).
    let invocation: string | null = null;
    try {
      const memoryDid = await deps.ucan.resolveServiceDid(memoryEngineUrl);
      if (memoryDid) {
        invocation = await deps.ucan.mintInvocation(
          { did: memoryDid, capability: 'ixo:memory' },
          // Claim the ability the user's delegation actually grants. A `'*'`
          // claim is satisfiable only by a `'*'` grant.
          { can: 'memory/*' },
        );
      }
    } catch (err) {
      logger.warn(
        `[history-indexer] could not mint a memory engine invocation: ${describe(err)}`,
      );
    }
    if (!invocation) {
      logger.warn(
        `[history-indexer] no memory engine invocation for session ${sessionId}; skipping`,
      );
      return 'skipped';
    }

    if (transformed.length > 0) {
      const res = await this.fetchImpl(`${memoryEngineUrl}/messages`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${invocation}`,
          'X-Auth-Type': 'ucan',
          'x-room-id': roomId,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ messages: transformed }),
        signal: AbortSignal.timeout(this.requestTimeoutMs),
      });
      if (!res.ok) {
        const text = await res.text().catch(() => '');
        throw new Error(
          `memory engine rejected the conversation (${res.status}): ${text.slice(0, 200)}`,
        );
      }
    }

    const newCount = lastProcessedCount + newMessages.length;
    await deps.setProcessedCount(sessionId, newCount);
    logger.log(
      `[history-indexer] processed ${newMessages.length} new messages for session ${sessionId} (lastProcessedCount → ${newCount})`,
    );
    return 'processed';
  }
}

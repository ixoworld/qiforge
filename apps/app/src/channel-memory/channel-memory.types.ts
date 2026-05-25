/**
 * Channel memory — distilled long-term memory of group rooms.
 *
 * Each `ChannelMemoryChunk` is an LLM-compacted summary of a batch of recent
 * room messages. Chunks accumulate immutably. They are NEVER overwritten.
 *
 * `tier` is reserved for future age-based consolidation:
 *   - tier=1 — recent, granular (default)
 *   - tier=2 — older, weekly rollup (v2)
 *   - tier=3 — ancient, monthly rollup (v2)
 */
export interface ChannelMemoryChunk {
  id: string;
  roomId: string;
  summary: string;
  fromEventId: string;
  toEventId: string;
  fromTimestamp: number;
  toTimestamp: number;
  messageCount: number;
  participants: string[];
  threadIds: string[];
  tier: number;
  createdAt: number;
}

export interface PinnedFact {
  id: string;
  roomId: string;
  fact: string;
  pinnedByDid: string;
  sourceEventId?: string;
  createdAt: number;
}

export interface ChannelMember {
  matrixUserId: string;
  displayName: string;
  did?: string;
}

export interface ObservedMessage {
  eventId: string;
  threadId: string;
  senderDid: string;
  senderMatrixUserId: string;
  senderDisplayName: string;
  body: string;
  timestamp: number;
}

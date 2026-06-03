import 'dotenv/config';

import type { RunnableConfig } from '@langchain/core/runnables';
import {
  BaseCheckpointSaver,
  type Checkpoint,
  type CheckpointListOptions,
  type CheckpointMetadata,
  type CheckpointPendingWrite,
  type CheckpointTuple,
  type PendingWrite,
  type SerializerProtocol,
  TASKS,
  WRITES_IDX_MAP,
  copyCheckpoint,
  maxChannelVersion,
} from '@langchain/langgraph-checkpoint';

import { Logger } from '@ixo/logger';

import { matrixStateManager } from '../matrix-state-manager/matrix-state-manager.js';
import type {
  IGraphStateWithRequiredFields,
  IRunnableConfigWithRequiredFields,
} from './types.js';

// Thread mapping interface (like SQL index)
interface ThreadMap {
  [threadId: string]: string; // threadId -> latestCheckpointId
}

// Storage interfaces - simplified like SQL
interface StoredCheckpoint {
  thread_id: string;
  checkpoint_id: string;
  checkpoint_ns: string;
  parent_checkpoint_id?: string;
  type: string;
  checkpoint: string; // serialized
  metadata: string; // serialized
  lastUpdatedAt?: number;
  sizeBytes?: number;
}

interface StoredWrite {
  thread_id: string;
  checkpoint_id: string;
  checkpoint_ns: string;
  task_id: string;
  idx: number;
  channel: string;
  type: string;
  value: string; // serialized
}

// LRU Cache implementation
class LRUCache<T> {
  private cache: Map<string, { value: T; timestamp: number }> = new Map();
  private readonly max: number;
  private readonly ttl: number;

  constructor(max: number = 5000, ttl: number = 30000) {
    this.max = max;
    this.ttl = ttl;
  }

  get(key: string): T | undefined {
    const entry = this.cache.get(key);
    if (!entry) return undefined;

    // Check TTL
    if (Date.now() - entry.timestamp > this.ttl) {
      this.cache.delete(key);
      return undefined;
    }

    // Move to end (LRU)
    this.cache.delete(key);
    this.cache.set(key, entry);
    return entry.value;
  }

  set(key: string, value: T): void {
    // Remove if exists (to update position)
    this.cache.delete(key);

    // Evict oldest if at capacity
    if (this.cache.size >= this.max) {
      const firstKey = this.cache.keys().next().value;
      if (firstKey) this.cache.delete(firstKey);
    }

    this.cache.set(key, { value, timestamp: Date.now() });
  }

  delete(key: string): void {
    this.cache.delete(key);
  }

  clear(): void {
    this.cache.clear();
  }

  deletePattern(pattern: string): void {
    const keysToDelete: string[] = [];
    for (const key of this.cache.keys()) {
      if (key.includes(pattern)) {
        keysToDelete.push(key);
      }
    }
    for (const key of keysToDelete) {
      this.cache.delete(key);
    }
  }
}

// Cache metrics
interface CacheMetrics {
  hits: number;
  misses: number;
  indexRebuilds: number;
  filteredEvents: number;
  duplicateEvents: number;
}

export class MatrixCheckpointSaver<
  _GraphState extends IGraphStateWithRequiredFields =
    IGraphStateWithRequiredFields,
> extends BaseCheckpointSaver {
  private stateManager = matrixStateManager;

  // LRU Caches (simplified for thread mapping approach)
  private checkpointCache: LRUCache<StoredCheckpoint>;
  private writesCache: LRUCache<StoredWrite[]>;
  private latestCache: LRUCache<{
    checkpointId: string;
    lastUpdatedAt: number;
  }>;
  private indexCache: LRUCache<ThreadMap>;

  // Metrics
  private metrics: CacheMetrics = {
    hits: 0,
    misses: 0,
    indexRebuilds: 0,
    filteredEvents: 0,
    duplicateEvents: 0,
  };

  // Config
  private readonly cacheTTL: number;
  private readonly cacheMax: number;
  private readonly maxCheckpointSizeBytes: number;

  constructor(serde?: SerializerProtocol) {
    super(serde);

    // Read config from env
    this.cacheTTL = parseInt(
      process.env.MATRIX_CP_CACHE_TTL_MS || '300000',
      10,
    );
    this.cacheMax = parseInt(process.env.MATRIX_CP_CACHE_MAX || '50000', 10);
    this.maxCheckpointSizeBytes = parseInt(
      process.env.MATRIX_CP_MAX_SIZE_BYTES || '10485760',
      10,
    ); // 10MB default

    // Initialize caches
    this.checkpointCache = new LRUCache(this.cacheMax, this.cacheTTL);
    this.writesCache = new LRUCache<StoredWrite[]>(
      this.cacheMax,
      this.cacheTTL,
    );
    this.latestCache = new LRUCache(this.cacheMax, this.cacheTTL);
    this.indexCache = new LRUCache(this.cacheMax, this.cacheTTL); // For thread map
  }

  // Sanitize oracleDid to safe token
  private sanitizeOracleDid(oracleDid: string): string {
    return oracleDid.replace(/[^a-zA-Z0-9._-]/g, '_');
  }

  // Storage keys - following SQL table pattern with sanitization
  private getCheckpointKey(
    oracleDid: string,
    threadId: string,
    checkpointNs: string,
    checkpointId: string,
  ): string {
    const safe = this.sanitizeOracleDid(oracleDid);
    return `${safe}_ckpt_${threadId}_${checkpointNs}_${checkpointId}`;
  }

  private getWritesKey(
    oracleDid: string,
    threadId: string,
    checkpointNs: string,
    checkpointId: string,
  ): string {
    const safe = this.sanitizeOracleDid(oracleDid);
    return `${safe}_writes_${threadId}_${checkpointNs}_${checkpointId}`;
  }

  private getLatestCheckpointKey(
    oracleDid: string,
    threadId: string,
    checkpointNs: string,
  ): string {
    const safe = this.sanitizeOracleDid(oracleDid);
    return `${safe}_latest_${threadId}_${checkpointNs}`;
  }

  // Thread mapping keys (like SQL table names)
  private getThreadMapKey(oracleDid: string): string {
    const safe = this.sanitizeOracleDid(oracleDid);
    return `${safe}_thread_map`;
  }

  // Cache key builders (simplified for thread mapping approach)
  private getCacheWritesKey(
    roomId: string,
    oracleDid: string,
    threadId: string,
    checkpointNs: string,
    checkpointId: string,
  ): string {
    return `${roomId}:${oracleDid}:${threadId}:${checkpointNs}:${checkpointId}:writes`;
  }

  private getCacheLatestKey(
    roomId: string,
    oracleDid: string,
    threadId: string,
    checkpointNs: string,
  ): string {
    return `${roomId}:${oracleDid}:${threadId}:${checkpointNs}:latest`;
  }

  private getCacheCheckpointKey(
    roomId: string,
    oracleDid: string,
    threadId: string,
    checkpointNs: string,
    checkpointId: string,
  ): string {
    return `${roomId}:${oracleDid}:${threadId}:${checkpointNs}:${checkpointId}:checkpoint`;
  }

  // Get thread mapping (like SQL SELECT from thread_map)
  private async getThreadMap(
    roomId: string,
    oracleDid: string,
  ): Promise<ThreadMap> {
    const cacheKey = `thread_map:${roomId}:${oracleDid}`;

    // Try cache first
    const cached = this.indexCache.get(cacheKey);
    if (cached) {
      this.metrics.hits++;
      return cached;
    }

    this.metrics.misses++;

    try {
      const threadMapKey = this.getThreadMapKey(oracleDid);
      const threadMap = await this.stateManager.getState<ThreadMap>(
        roomId,
        threadMapKey,
      );

      if (
        threadMap &&
        !(
          'deleted' in threadMap &&
          (threadMap as Record<string, unknown>).deleted
        )
      ) {
        this.indexCache.set(cacheKey, threadMap);
        return threadMap;
      }
    } catch {
      // Thread map doesn't exist yet
    }

    // Return empty thread map
    const emptyMap: ThreadMap = {};
    this.indexCache.set(cacheKey, emptyMap);
    return emptyMap;
  }

  // Update thread mapping (like SQL UPDATE thread_map)
  private async updateThreadMap(
    roomId: string,
    oracleDid: string,
    threadId: string,
    checkpointId: string,
  ): Promise<void> {
    const threadMap = await this.getThreadMap(roomId, oracleDid);
    threadMap[threadId] = checkpointId;

    const threadMapKey = this.getThreadMapKey(oracleDid);
    await this.stateManager.setState({
      roomId,
      stateKey: threadMapKey,
      data: threadMap,
    });

    // Update cache
    const cacheKey = `thread_map:${roomId}:${oracleDid}`;
    this.indexCache.set(cacheKey, threadMap);

    Logger.debug(`Updated thread mapping: ${threadId} -> ${checkpointId}`);
  }

  // Store checkpoint with thread mapping update (like SQL INSERT + UPDATE)
  private async storeCheckpoint(
    roomId: string,
    oracleDid: string,
    storedCheckpoint: StoredCheckpoint,
  ): Promise<void> {
    const key = this.getCheckpointKey(
      oracleDid,
      storedCheckpoint.thread_id,
      storedCheckpoint.checkpoint_ns,
      storedCheckpoint.checkpoint_id,
    );

    // Add timestamp
    storedCheckpoint.lastUpdatedAt = Date.now();

    // Check size and warn
    const serialized = JSON.stringify(storedCheckpoint);
    storedCheckpoint.sizeBytes = serialized.length;
    if (serialized.length > this.maxCheckpointSizeBytes) {
      Logger.warn(
        `Checkpoint ${storedCheckpoint.checkpoint_id} exceeds size limit: ${serialized.length} bytes`,
        {
          threadId: storedCheckpoint.thread_id,
          checkpointNs: storedCheckpoint.checkpoint_ns,
          maxSize: this.maxCheckpointSizeBytes,
        },
      );
    }

    // Write checkpoint first (like SQL INSERT INTO checkpoints)
    await this.stateManager.setState({
      roomId,
      stateKey: key,
      data: storedCheckpoint,
    });

    // Update thread mapping (like SQL UPDATE thread_map)
    await this.updateThreadMap(
      roomId,
      oracleDid,
      storedCheckpoint.thread_id,
      storedCheckpoint.checkpoint_id,
    );

    // Update latest pointer (for backward compatibility)
    const latestKey = this.getLatestCheckpointKey(
      oracleDid,
      storedCheckpoint.thread_id,
      storedCheckpoint.checkpoint_ns,
    );

    await this.stateManager.setState({
      roomId,
      stateKey: latestKey,
      data: storedCheckpoint,
    });

    const latestCacheKey = this.getCacheLatestKey(
      roomId,
      oracleDid,
      storedCheckpoint.thread_id,
      storedCheckpoint.checkpoint_ns,
    );
    this.latestCache.set(latestCacheKey, {
      checkpointId: storedCheckpoint.checkpoint_id,
      lastUpdatedAt: Date.now(),
    });
  }

  // Store writes (idempotent)
  private async storeWrites(
    roomId: string,
    oracleDid: string,
    writes: StoredWrite[],
  ): Promise<void> {
    if (!writes || writes.length === 0 || !writes[0]) return;

    const key = this.getWritesKey(
      oracleDid,
      writes[0].thread_id,
      writes[0].checkpoint_ns,
      writes[0].checkpoint_id,
    );

    // Get existing writes
    const existingWrites = await this.getStoredWrites(
      roomId,
      oracleDid,
      writes[0].thread_id,
      writes[0].checkpoint_ns,
      writes[0].checkpoint_id,
    );

    // Merge writes (replace by taskId+idx)
    const writeMap = new Map<string, StoredWrite>();

    // Add existing
    for (const write of existingWrites) {
      const compositeKey = `${write.task_id}:${write.idx}`;
      writeMap.set(compositeKey, write);
    }

    // Replace or add new
    let replacedCount = 0;
    let appendedCount = 0;
    for (const write of writes) {
      const compositeKey = `${write.task_id}:${write.idx}`;
      if (writeMap.has(compositeKey)) {
        replacedCount++;
      } else {
        appendedCount++;
      }
      writeMap.set(compositeKey, write);
    }

    // Convert back to array and sort by idx
    const allWrites = Array.from(writeMap.values()).sort(
      (a, b) => a.idx - b.idx,
    );

    await this.stateManager.setState({
      roomId,
      stateKey: key,
      data: allWrites,
    });

    // Update cache
    const cacheKey = this.getCacheWritesKey(
      roomId,
      oracleDid,
      writes[0].thread_id,
      writes[0].checkpoint_ns,
      writes[0].checkpoint_id,
    );
    this.writesCache.set(cacheKey, allWrites);

    Logger.debug(
      `Stored writes for checkpoint ${writes[0].checkpoint_id}: ${replacedCount} replaced, ${appendedCount} appended`,
    );
  }

  // Get stored checkpoint (with caching) - like SQL SELECT
  private async getStoredCheckpoint(
    roomId: string,
    oracleDid: string,
    threadId: string,
    checkpointNs: string,
    checkpointId?: string,
  ): Promise<StoredCheckpoint | undefined> {
    try {
      if (!checkpointId) {
        // Get latest checkpoint from thread mapping (like SQL ORDER BY DESC LIMIT 1)
        const threadMap = await this.getThreadMap(roomId, oracleDid);
        const latestCheckpointId = threadMap[threadId];

        if (!latestCheckpointId) {
          Logger.debug(`No checkpoint found for thread ${threadId}`);
          return undefined;
        }

        // Use the latest checkpoint ID
        checkpointId = latestCheckpointId;
      }

      // For specific checkpoint ID - try checkpoint cache first
      const checkpointCacheKey = this.getCacheCheckpointKey(
        roomId,
        oracleDid,
        threadId,
        checkpointNs,
        checkpointId,
      );
      const cachedCheckpoint = this.checkpointCache.get(checkpointCacheKey);
      if (cachedCheckpoint) {
        this.metrics.hits++;
        Logger.debug(`Checkpoint cache HIT for ${checkpointId}`, {
          threadId,
          checkpointNs,
          checkpointId,
        });
        return cachedCheckpoint;
      }

      this.metrics.misses++;

      const key = this.getCheckpointKey(
        oracleDid,
        threadId,
        checkpointNs,
        checkpointId,
      );
      const stored = await this.stateManager.getState<StoredCheckpoint>(
        roomId,
        key,
      );

      // Skip null/deleted/invalid states
      if (
        !stored ||
        ('deleted' in stored && (stored as Record<string, unknown>).deleted) ||
        !this.isValidCheckpoint(stored)
      ) {
        return undefined;
      }

      // Cache the checkpoint for future reads
      this.checkpointCache.set(checkpointCacheKey, stored);

      return stored;
    } catch (error) {
      Logger.debug(
        `Failed to get checkpoint: ${checkpointId || 'latest'}`,
        error,
      );
      return undefined;
    }
  }

  // Validate checkpoint has required fields
  private isValidCheckpoint(
    checkpoint: unknown,
  ): checkpoint is StoredCheckpoint {
    return (
      checkpoint != null &&
      typeof checkpoint === 'object' &&
      typeof (checkpoint as Record<string, unknown>).thread_id === 'string' &&
      typeof (checkpoint as Record<string, unknown>).checkpoint_id ===
        'string' &&
      typeof (checkpoint as Record<string, unknown>).checkpoint_ns ===
        'string' &&
      typeof (checkpoint as Record<string, unknown>).type === 'string' &&
      typeof (checkpoint as Record<string, unknown>).checkpoint === 'string' &&
      typeof (checkpoint as Record<string, unknown>).metadata === 'string'
    );
  }

  // Get stored writes (with caching)
  private async getStoredWrites(
    roomId: string,
    oracleDid: string,
    threadId: string,
    checkpointNs: string,
    checkpointId: string,
  ): Promise<StoredWrite[]> {
    const cacheKey = this.getCacheWritesKey(
      roomId,
      oracleDid,
      threadId,
      checkpointNs,
      checkpointId,
    );

    // Try cache first
    const cached = this.writesCache.get(cacheKey);
    if (cached) {
      this.metrics.hits++;
      Logger.debug(`Writes cache HIT for checkpoint ${checkpointId}`, {
        checkpointId,
        cacheKey,
      });
      return cached;
    }

    this.metrics.misses++;

    try {
      const key = this.getWritesKey(
        oracleDid,
        threadId,
        checkpointNs,
        checkpointId,
      );
      const writes = await this.stateManager.getState<StoredWrite[]>(
        roomId,
        key,
      );

      // Skip null/deleted states
      if (
        !writes ||
        ('deleted' in writes && (writes as Record<string, unknown>).deleted)
      ) {
        return [];
      }

      // Ensure sorted by idx
      const sorted = (writes || []).sort((a, b) => a.idx - b.idx);

      // Cache it
      this.writesCache.set(cacheKey, sorted);

      return sorted;
    } catch (error: unknown) {
      // M_NOT_FOUND is expected when checkpoint has no writes
      if (
        error != null &&
        typeof error === 'object' &&
        'errcode' in error &&
        error.errcode === 'M_NOT_FOUND'
      ) {
        Logger.debug(
          `No writes found for checkpoint ${checkpointId} (expected for checkpoints with writesCount=0)`,
        );
      } else {
        Logger.debug(
          `Failed to get writes for checkpoint ${checkpointId}`,
          error,
        );
      }
      return [];
    }
  }

  // Migrate pending_sends for v < 4 checkpoints (follows SQL pattern)
  private async migratePendingSends(
    mutableCheckpoint: Checkpoint,
    roomId: string,
    oracleDid: string,
    threadId: string,
    checkpointNs: string,
    parentCheckpointId: string,
  ): Promise<void> {
    // Get writes from parent checkpoint
    const parentWrites = await this.getStoredWrites(
      roomId,
      oracleDid,
      threadId,
      checkpointNs,
      parentCheckpointId,
    );

    // Filter for TASKS channel and sort by idx
    const taskWrites = parentWrites
      .filter((write) => write.channel === TASKS)
      .sort((a, b) => a.idx - b.idx);

    // Deserialize task values
    const pendingSends = await Promise.all(
      taskWrites.map(async (write) => {
        return await this.serde.loadsTyped(write.type, write.value);
      }),
    );

    // Add to checkpoint.channel_values[TASKS]
    mutableCheckpoint.channel_values ??= {};
    mutableCheckpoint.channel_values[TASKS] = pendingSends;

    // Update channel versions
    mutableCheckpoint.channel_versions ??= {};
    mutableCheckpoint.channel_versions[TASKS] =
      Object.keys(mutableCheckpoint.channel_versions).length > 0
        ? maxChannelVersion(
            ...Object.values(mutableCheckpoint.channel_versions),
          )
        : this.getNextVersion(undefined);
  }

  async getTuple(config: RunnableConfig): Promise<CheckpointTuple | undefined> {
    const startTime = Date.now();
    const {
      thread_id: threadId,
      checkpoint_ns: checkpointNs = '',
      checkpoint_id: checkpointId,
    } = config.configurable ?? {};

    if (!threadId) {
      return undefined;
    }

    // Extract Matrix configs (Matrix-specific)
    const configs = (
      config.configurable as IRunnableConfigWithRequiredFields['configurable']
    )?.configs;
    if (!configs) {
      Logger.error('Missing Matrix configs in configurable', {
        threadId,
        checkpointNs,
        checkpointId,
      });
      return undefined;
    }

    const { matrix } = configs;

    // Get stored checkpoint
    const storedCheckpoint = await this.getStoredCheckpoint(
      matrix.roomId,
      matrix.oracleDid,
      threadId,
      checkpointNs,
      checkpointId,
    );

    if (!storedCheckpoint) {
      Logger.debug('Checkpoint not found', {
        roomId: matrix.roomId,
        threadId,
        checkpointNs,
        checkpointId: checkpointId || 'latest',
      });
      return undefined;
    }

    // Deserialize checkpoint and metadata
    const checkpoint = (await this.serde.loadsTyped(
      storedCheckpoint.type,
      storedCheckpoint.checkpoint,
    )) as Checkpoint;

    const metadata = (await this.serde.loadsTyped(
      storedCheckpoint.type,
      storedCheckpoint.metadata,
    )) as CheckpointMetadata;

    // Migration check for v < 4 checkpoints
    if (checkpoint.v < 4 && storedCheckpoint.parent_checkpoint_id != null) {
      Logger.debug('Migrating v<4 checkpoint', {
        threadId,
        checkpointId: storedCheckpoint.checkpoint_id,
        parentCheckpointId: storedCheckpoint.parent_checkpoint_id,
      });
      await this.migratePendingSends(
        checkpoint,
        matrix.roomId,
        matrix.oracleDid,
        storedCheckpoint.thread_id,
        storedCheckpoint.checkpoint_ns,
        storedCheckpoint.parent_checkpoint_id,
      );
    }

    // Get pending writes for current checkpoint (sorted by idx)
    const storedWrites = await this.getStoredWrites(
      matrix.roomId,
      matrix.oracleDid,
      storedCheckpoint.thread_id,
      storedCheckpoint.checkpoint_ns,
      storedCheckpoint.checkpoint_id,
    );

    // Map to CheckpointPendingWrite[] (already sorted by idx from getStoredWrites)
    const pendingWrites: CheckpointPendingWrite[] = await Promise.all(
      storedWrites.map(async (write): Promise<CheckpointPendingWrite> => {
        const value = await this.serde.loadsTyped(write.type, write.value);
        return [write.task_id, write.channel, value];
      }),
    );

    const finalConfig = {
      configurable: {
        thread_id: storedCheckpoint.thread_id,
        checkpoint_ns: storedCheckpoint.checkpoint_ns,
        checkpoint_id: storedCheckpoint.checkpoint_id,
      },
    };

    const duration = Date.now() - startTime;
    Logger.debug(`getTuple completed in ${duration}ms`, {
      threadId,
      checkpointId: storedCheckpoint.checkpoint_id,
      writesCount: pendingWrites.length,
    });

    return {
      config: finalConfig,
      checkpoint,
      metadata,
      parentConfig: storedCheckpoint.parent_checkpoint_id
        ? {
            configurable: {
              thread_id: storedCheckpoint.thread_id,
              checkpoint_ns: storedCheckpoint.checkpoint_ns,
              checkpoint_id: storedCheckpoint.parent_checkpoint_id,
            },
          }
        : undefined,
      pendingWrites,
    };
  }

  async *list(
    config: RunnableConfig,
    options?: CheckpointListOptions,
  ): AsyncGenerator<CheckpointTuple> {
    const startTime = Date.now();
    const { thread_id: threadId, checkpoint_ns: checkpointNs = '' } =
      config.configurable ?? {};

    if (!threadId) {
      return;
    }

    // Extract Matrix configs (Matrix-specific)
    const configs = (
      config.configurable as IRunnableConfigWithRequiredFields['configurable']
    )?.configs;
    if (!configs) {
      Logger.error('Missing Matrix configs in list', { threadId });
      return;
    }

    const { matrix } = configs;

    // Extract options
    const { filter, before, limit } = options ?? {};

    // Get thread mapping (like SQL SELECT from thread_map)
    const threadMap = await this.getThreadMap(matrix.roomId, matrix.oracleDid);
    const latestCheckpointId = threadMap[threadId];

    if (!latestCheckpointId) {
      Logger.debug('No checkpoints found for thread (empty thread map)', {
        threadId,
        checkpointNs,
      });
      return;
    }

    Logger.debug(`Listing checkpoints for thread ${threadId}`, {
      threadId,
      checkpointNs,
      latestCheckpointId,
    });

    // Walk checkpoint chain backwards (like SQL ORDER BY checkpoint_id DESC)
    let currentId: string | undefined = latestCheckpointId;
    let yieldedCount = 0;

    while (currentId && (limit === undefined || yieldedCount < limit)) {
      try {
        // Apply "before" filter (lexicographic <)
        if (
          before?.configurable?.checkpoint_id &&
          currentId >= before.configurable.checkpoint_id
        ) {
          break;
        }

        // Get stored checkpoint
        const storedCheckpoint = await this.getStoredCheckpoint(
          matrix.roomId,
          matrix.oracleDid,
          threadId,
          checkpointNs,
          currentId,
        );

        if (!storedCheckpoint) {
          Logger.warn('Checkpoint in chain but not found in storage', {
            threadId,
            checkpointId: currentId,
          });
          break;
        }

        // Deserialize checkpoint and metadata
        const checkpoint = (await this.serde.loadsTyped(
          storedCheckpoint.type,
          storedCheckpoint.checkpoint,
        )) as Checkpoint;

        const metadata = (await this.serde.loadsTyped(
          storedCheckpoint.type,
          storedCheckpoint.metadata,
        )) as CheckpointMetadata;

        // Apply metadata filter (shallow equality match)
        if (filter && Object.keys(filter).length > 0) {
          let matches = true;
          for (const [key, value] of Object.entries(filter)) {
            if (
              (metadata as unknown as Record<string, unknown>)[key] !== value
            ) {
              matches = false;
              break;
            }
          }
          if (!matches) {
            // Continue to next checkpoint in chain
            currentId = storedCheckpoint.parent_checkpoint_id;
            continue;
          }
        }

        // Migration check for v < 4 checkpoints
        if (checkpoint.v < 4 && storedCheckpoint.parent_checkpoint_id != null) {
          await this.migratePendingSends(
            checkpoint,
            matrix.roomId,
            matrix.oracleDid,
            storedCheckpoint.thread_id,
            storedCheckpoint.checkpoint_ns,
            storedCheckpoint.parent_checkpoint_id,
          );
        }

        yield {
          config: {
            configurable: {
              thread_id: storedCheckpoint.thread_id,
              checkpoint_ns: storedCheckpoint.checkpoint_ns,
              checkpoint_id: storedCheckpoint.checkpoint_id,
            },
          },
          checkpoint,
          metadata,
          parentConfig: storedCheckpoint.parent_checkpoint_id
            ? {
                configurable: {
                  thread_id: storedCheckpoint.thread_id,
                  checkpoint_ns: storedCheckpoint.checkpoint_ns,
                  checkpoint_id: storedCheckpoint.parent_checkpoint_id,
                },
              }
            : undefined,
        };

        yieldedCount++;

        // Move to parent checkpoint (walk backwards through chain)
        currentId = storedCheckpoint.parent_checkpoint_id;
      } catch (error) {
        // Skip corrupted checkpoints
        Logger.warn('Skipping corrupted checkpoint in chain', {
          checkpointId: currentId,
          error: error instanceof Error ? error.message : String(error),
        });
        break;
      }
    }

    const duration = Date.now() - startTime;
    Logger.debug(`list completed in ${duration}ms`, {
      threadId,
      yieldedCount,
      cacheHits: this.metrics.hits,
      cacheMisses: this.metrics.misses,
    });
  }

  async put(
    config: RunnableConfig,
    checkpoint: Checkpoint,
    metadata: CheckpointMetadata,
  ): Promise<RunnableConfig> {
    const {
      thread_id: threadId,
      checkpoint_ns: checkpointNs = '',
      checkpoint_id: parentCheckpointId,
    } = config.configurable ?? {};

    if (!threadId) {
      throw new Error('Missing thread_id in config.configurable');
    }

    // Extract Matrix configs (Matrix-specific)
    const configs = (
      config.configurable as IRunnableConfigWithRequiredFields['configurable']
    )?.configs;
    if (!configs) {
      throw new Error('Missing Matrix configs in configurable');
    }

    const { matrix } = configs;

    // NEW: Use copyCheckpoint to prepare checkpoint
    const preparedCheckpoint: Partial<Checkpoint> = copyCheckpoint(checkpoint);

    // Serialize checkpoint and metadata
    const [serializationType, serializedCheckpoint] =
      await this.serde.dumpsTyped(preparedCheckpoint);
    const [, serializedMetadata] = await this.serde.dumpsTyped(metadata);

    const storedCheckpoint: StoredCheckpoint = {
      thread_id: threadId,
      checkpoint_id: checkpoint.id,
      checkpoint_ns: checkpointNs,
      parent_checkpoint_id: parentCheckpointId,
      type: serializationType,
      checkpoint: new TextDecoder().decode(serializedCheckpoint),
      metadata: new TextDecoder().decode(serializedMetadata),
    };

    await this.storeCheckpoint(
      matrix.roomId,
      matrix.oracleDid,
      storedCheckpoint,
    );

    // NEW: Return standard RunnableConfig
    return {
      configurable: {
        thread_id: threadId,
        checkpoint_ns: checkpointNs,
        checkpoint_id: checkpoint.id,
      },
    };
  }

  async putWrites(
    config: RunnableConfig,
    writes: PendingWrite[],
    taskId: string,
  ): Promise<void> {
    const {
      thread_id: threadId,
      checkpoint_ns: checkpointNs = '',
      checkpoint_id: checkpointId,
    } = config.configurable ?? {};

    if (!threadId || !checkpointId) {
      Logger.error('Missing thread_id or checkpoint_id in putWrites', {
        threadId,
        checkpointId,
      });
      throw new Error(
        'Missing thread_id or checkpoint_id in config.configurable',
      );
    }

    // Extract Matrix configs (Matrix-specific)
    const configs = (
      config.configurable as IRunnableConfigWithRequiredFields['configurable']
    )?.configs;
    if (!configs) {
      Logger.error('Missing Matrix configs in putWrites', {
        threadId,
        checkpointId,
      });
      throw new Error('Missing Matrix configs in configurable');
    }

    const { matrix } = configs;

    // Map writes with WRITES_IDX_MAP
    const storedWrites: StoredWrite[] = await Promise.all(
      writes.map(async ([channel, value], originalIdx) => {
        const [type, serializedValue] = await this.serde.dumpsTyped(value);
        // Use WRITES_IDX_MAP for deterministic idx
        const idx = WRITES_IDX_MAP[channel] ?? originalIdx;
        return {
          thread_id: threadId,
          checkpoint_id: checkpointId,
          checkpoint_ns: checkpointNs,
          task_id: taskId,
          idx,
          channel,
          type,
          value: new TextDecoder().decode(serializedValue),
        };
      }),
    );

    await this.storeWrites(matrix.roomId, matrix.oracleDid, storedWrites);

    Logger.debug(`putWrites completed`, {
      threadId,
      checkpointId,
      taskId,
      writesCount: storedWrites.length,
    });
  }

  // Implement deleteThread with state nullification
  public async deleteThread(threadId: string): Promise<void> {
    Logger.info(`Deleting thread ${threadId}`);

    // We need to iterate through all possible checkpointNs values
    // For now, we'll assume empty string as the default namespace
    // In a production scenario, you'd need to track all namespaces used
    const checkpointNs = '';

    // Note: We need roomId and oracleDid, but deleteThread doesn't have them in signature
    // This is a limitation - we'll need to scan all rooms or accept roomId as parameter
    // For now, throw error suggesting to pass config with Matrix details

    throw new Error(
      `deleteThread not fully implemented - requires roomId and oracleDid. ` +
        `Thread ID: ${threadId}, namespace: ${checkpointNs}. ` +
        `Consider implementing a version that accepts full config.`,
    );
  }

  // Helper to delete thread with full context
  public async deleteThreadWithContext(
    roomId: string,
    oracleDid: string,
    threadId: string,
    checkpointNs: string = '',
  ): Promise<void> {
    Logger.info(`Deleting thread ${threadId} in room ${roomId}`, {
      oracleDid,
      checkpointNs,
    });

    try {
      // Get thread mapping
      const threadMap = await this.getThreadMap(roomId, oracleDid);
      const latestCheckpointId = threadMap[threadId];

      if (!latestCheckpointId) {
        Logger.debug(`Thread ${threadId} not found in thread map`);
        return;
      }

      // Walk checkpoint chain and nullify all checkpoints
      let currentId: string | undefined = latestCheckpointId;
      let deletedCount = 0;

      while (currentId) {
        // Get checkpoint to find parent
        const checkpoint = await this.getStoredCheckpoint(
          roomId,
          oracleDid,
          threadId,
          checkpointNs,
          currentId,
        );

        if (!checkpoint) break;

        // Nullify checkpoint
        const checkpointKey = this.getCheckpointKey(
          oracleDid,
          threadId,
          checkpointNs,
          currentId,
        );
        await this.stateManager.setState<null>({
          roomId,
          stateKey: checkpointKey,
          data: null,
        });

        // Nullify writes
        const writesKey = this.getWritesKey(
          oracleDid,
          threadId,
          checkpointNs,
          currentId,
        );
        await this.stateManager.setState<null>({
          roomId,
          stateKey: writesKey,
          data: null,
        });

        deletedCount++;
        currentId = checkpoint.parent_checkpoint_id;
      }

      // Remove from thread mapping
      delete threadMap[threadId];
      const threadMapKey = this.getThreadMapKey(oracleDid);
      await this.stateManager.setState({
        roomId,
        stateKey: threadMapKey,
        data: threadMap,
      });

      // Nullify latest pointer
      const latestKey = this.getLatestCheckpointKey(
        oracleDid,
        threadId,
        checkpointNs,
      );
      await this.stateManager.setState<null>({
        roomId,
        stateKey: latestKey,
        data: null,
      });

      // Purge all LRU entries for this thread
      const threadPattern = `${roomId}:${oracleDid}:${threadId}:${checkpointNs}`;
      this.checkpointCache.deletePattern(threadPattern);
      this.writesCache.deletePattern(threadPattern);
      this.latestCache.deletePattern(threadPattern);

      // Clear thread map cache
      const cacheKey = `thread_map:${roomId}:${oracleDid}`;
      this.indexCache.delete(cacheKey);

      Logger.info(`Deleted thread ${threadId}`, {
        roomId,
        deletedCheckpoints: deletedCount,
      });
    } catch (error) {
      Logger.error(`Failed to delete thread ${threadId}`, error);
      throw error;
    }
  }

  // Manual thread map rebuild for recovery scenarios (ONLY place that calls listStateEvents)
  public async rebuildThreadMap(
    roomId: string,
    oracleDid: string,
  ): Promise<void> {
    Logger.warn(`Manual thread map rebuild requested for room ${roomId}`, {
      oracleDid,
    });

    try {
      // Scan all events to rebuild thread map
      const stateEvents =
        await this.stateManager.listStateEvents<StoredCheckpoint>(roomId);

      // Build thread map from all checkpoints
      const threadMap: ThreadMap = {};
      let processedCount = 0;

      for (const event of stateEvents) {
        if (
          event &&
          'thread_id' in event &&
          'checkpoint_id' in event &&
          'checkpoint_ns' in event &&
          event.checkpoint_ns === '' // Only default namespace for now
        ) {
          const threadId = event.thread_id;
          const checkpointId = event.checkpoint_id;

          // Keep latest checkpoint for each thread
          if (!threadMap[threadId] || checkpointId > threadMap[threadId]) {
            threadMap[threadId] = checkpointId;
          }
          processedCount++;
        }
      }

      // Store rebuilt thread map
      const threadMapKey = this.getThreadMapKey(oracleDid);
      await this.stateManager.setState({
        roomId,
        stateKey: threadMapKey,
        data: threadMap,
      });

      // Update cache
      const cacheKey = `thread_map:${roomId}:${oracleDid}`;
      this.indexCache.set(cacheKey, threadMap);

      Logger.info(
        `Successfully rebuilt thread map: ${Object.keys(threadMap).length} threads, ${processedCount} checkpoints processed`,
        {
          roomId,
          oracleDid,
          threadCount: Object.keys(threadMap).length,
          processedCheckpoints: processedCount,
        },
      );
    } catch (error) {
      Logger.error(`Failed to rebuild thread map for room ${roomId}`, error);
      throw error;
    }
  }

  // Add end() no-op for API symmetry
  public async end(): Promise<void> {
    // No-op for compatibility with Postgres saver
    Logger.debug('end() called (no-op)');
  }

  // Get cache metrics (useful for debugging/monitoring)
  public getCacheMetrics(): CacheMetrics {
    return { ...this.metrics };
  }

  // Get filtering performance metrics
  public getFilteringMetrics(): {
    filteredEvents: number;
    duplicateEvents: number;
    indexRebuilds: number;
    avgEventsPerRebuild: number;
  } {
    const avgEventsPerRebuild =
      this.metrics.indexRebuilds > 0
        ? this.metrics.filteredEvents / this.metrics.indexRebuilds
        : 0;

    return {
      filteredEvents: this.metrics.filteredEvents,
      duplicateEvents: this.metrics.duplicateEvents,
      indexRebuilds: this.metrics.indexRebuilds,
      avgEventsPerRebuild: Math.round(avgEventsPerRebuild),
    };
  }
}

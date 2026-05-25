import { Logger } from '@ixo/logger';
import {
  EncryptedRoomEvent,
  type MatrixEvent,
  type MessageEvent,
  type MessageEventContent,
} from 'matrix-bot-sdk';
import * as sdk from 'matrix-js-sdk';
import {
  MatrixStateManager,
  matrixStateManager,
} from './matrix-state-manager/matrix-state-manager.js';
import { type IAction, type IMessageOptions } from './types/matrix.js';
import { Cache } from './utils/cache.js';
import {
  createSimpleMatrixClient,
  type ISimpleMatrixClientConfig,
  type SimpleMatrixClient,
} from './utils/create-simple-matrix-client.js';
import { formatMsg } from './utils/format-msg.js';
import { extractBackupKeyFromSSS } from './utils/ssss.js';

function getEntityRoomAliasFromDid(did: string) {
  return did.replace(/:/g, '-');
}

/**
 * MatrixManager - Thread-Safe Singleton for Matrix Operations
 *
 */
export class MatrixManager {
  private mxClient: SimpleMatrixClient | undefined;

  // Singleton instance management
  private static instance: MatrixManager | undefined;
  private static instanceLock = false;

  // Initialization state management
  private isInitialized = false;
  private initializationPromise: Promise<void> | null = null;
  private initializationLock = false;

  private homeserverName: string;
  private roomCache: Cache;
  private oracleName: string;

  private constructor(
    public stateManager: MatrixStateManager = matrixStateManager,
  ) {
    // Private constructor to prevent direct instantiation
    const url = new URL(process.env.MATRIX_BASE_URL ?? '');
    this.homeserverName = process.env.MATRIX_HOMESERVER_NAME ?? url.hostname;
    this.roomCache = new Cache();
    this.oracleName = process.env.ORACLE_NAME ?? 'Oracle';
  }

  /**
   * Get the singleton instance of MatrixManager
   * Thread-safe implementation with proper locking
   */
  public static getInstance(): MatrixManager {
    // Double-checked locking pattern for thread safety
    if (!MatrixManager.instance) {
      if (MatrixManager.instanceLock) {
        // Another thread is already creating the instance, wait for it
        while (MatrixManager.instanceLock && !MatrixManager.instance) {
          // Yield control to event loop
          // Wait for the other thread to finish initialization
        }
        if (MatrixManager.instance) {
          return MatrixManager.instance;
        }
      }

      // Acquire lock and create instance
      MatrixManager.instanceLock = true;
      try {
        // Double-check after acquiring lock
        if (!MatrixManager.instance) {
          MatrixManager.instance = new MatrixManager();
        }
      } finally {
        MatrixManager.instanceLock = false;
      }
    }
    return MatrixManager.instance;
  }

  /**
   * Initialize the Matrix client - MUCH simpler now with matrix-bot-sdk!
   */
  public async init(): Promise<void> {
    // If already initialized, return immediately
    if (this.isInitialized) {
      Logger.info('MatrixManager already initialized');
      return;
    }

    // If initialization is in progress, wait for it to complete
    if (this.initializationPromise) {
      Logger.info('MatrixManager initialization in progress, waiting...');
      return this.initializationPromise;
    }

    // If another thread is initializing, wait for it
    if (this.initializationLock) {
      while (this.initializationLock && !this.isInitialized) {
        await new Promise((resolve) => setTimeout(resolve, 10)); // Small delay
      }
      if (this.isInitialized) {
        return;
      }
    }

    // Acquire initialization lock
    this.initializationLock = true;

    // Create and store the initialization promise
    this.initializationPromise = this.performInitialization();

    try {
      await this.initializationPromise;
    } finally {
      this.initializationLock = false;
      this.initializationPromise = null;
    }
  }

  private async performInitialization(): Promise<void> {
    try {
      Logger.info(
        '🚀 Starting MatrixManager initialization with matrix-bot-sdk...',
      );

      // Try to extract backup key from SSSS for key backup support
      let recoveryKey: string | undefined;
      const recoveryPhrase = process.env.MATRIX_RECOVERY_PHRASE;
      if (recoveryPhrase && recoveryPhrase !== 'secret') {
        try {
          const backupKey = await extractBackupKeyFromSSS({
            baseUrl: process.env.MATRIX_BASE_URL!,
            accessToken: process.env.MATRIX_ORACLE_ADMIN_ACCESS_TOKEN!,
            userId: process.env.MATRIX_ORACLE_ADMIN_USER_ID!,
            recoveryPhrase,
          });
          if (backupKey) {
            recoveryKey = backupKey;
            Logger.info(
              '🔑 Backup key extracted from SSSS for key backup support',
            );
          }
        } catch (e) {
          Logger.warn(
            'Could not extract backup key from SSSS (will proceed without):',
            e,
          );
        }
      }

      const config: ISimpleMatrixClientConfig = {
        baseUrl: process.env.MATRIX_BASE_URL!,
        accessToken: process.env.MATRIX_ORACLE_ADMIN_ACCESS_TOKEN!,
        userId: process.env.MATRIX_ORACLE_ADMIN_USER_ID!,
        storagePath: process.env.MATRIX_STORE_PATH!,
        autoJoin: true,
        recoveryKey,
      };

      // Create client and start it
      this.mxClient = createSimpleMatrixClient(config);
      await this.mxClient.start();

      this.stateManager = MatrixStateManager.getInstance();

      // Mark as initialized only after everything succeeds
      this.isInitialized = true;
      Logger.info('✅ MatrixManager initialization completed');
    } catch (error) {
      Logger.error('❌ MatrixManager initialization failed:', error);

      // Cleanup partial initialization
      if (this.mxClient) {
        try {
          await this.mxClient.stop();
        } catch (cleanupError) {
          Logger.error('Error during simple client cleanup:', cleanupError);
        }
        this.mxClient = undefined;
      }

      this.isInitialized = false;
      throw error;
    }
  }

  /**
   * Get initialization status
   */
  public getInitializationStatus(): {
    isInitialized: boolean;
    isInitializing: boolean;
  } {
    return {
      isInitialized: this.isInitialized,
      isInitializing: this.initializationPromise !== null,
    };
  }

  /**
   * Destroy the MatrixManager instance for testing or restart
   */
  public async destroy(): Promise<void> {
    try {
      Logger.info('Destroying MatrixManager...');

      // Reset initialization state
      this.initializationPromise = null;
      this.isInitialized = false;

      await this.shutdown();

      this.mxClient = undefined;

      Logger.info('MatrixManager destroyed');
    } catch (error) {
      Logger.error('Error destroying MatrixManager:', error);
      throw error;
    }
  }

  public onRoomEvent<T>(
    roomId: string,
    eventType: string,
    callback: (event: MatrixEvent<T>) => void,
    debug?: boolean,
  ): () => void {
    if (!this.mxClient) {
      throw new Error('Simple client not initialized');
    }

    const fn = (rmId: string, event: MatrixEvent<T>) => {
      if (debug) {
        Logger.info('onRoomEvent', {
          roomId,
          eventType,
          event,
        });
      }
      if (rmId !== roomId) return;

      // Check if this is an encrypted event that failed to decrypt
      const content = event.content as Record<string, unknown> | undefined;
      if (event.type === 'm.room.encrypted' && !content?.body) {
        return;
      }

      if (event.type !== eventType) return;

      callback(event);
    };

    this.mxClient.mxClient.on('room.event', fn);

    return () => {
      Logger.info('Removing room event listener for roomId:', roomId);
      this.mxClient?.mxClient.removeListener('room.event', fn);
    };
  }

  /**
   * @deprecated Use getOracleRoomIdWithHomeServer for decoupled Matrix infrastructure support
   */
  public async getOracleRoomId({
    userDid,
    oracleEntityDid,
  }: {
    userDid: string;
    oracleEntityDid: string;
  }): Promise<{
    roomId: string | undefined;
    roomAlias: string;
    oracleRoomFullAlias: string;
  }> {
    return this.getOracleRoomIdWithHomeServer({
      userDid,
      oracleEntityDid,
      userHomeServer: this.homeserverName,
    });
  }

  /**
   * Get oracle room ID with explicit homeserver support for decoupled Matrix infrastructure.
   * @param userDid The user's DID
   * @param oracleEntityDid The oracle entity's DID
   * @param userHomeServer The user's homeserver (resolved from DID or provided)
   */
  public async getOracleRoomIdWithHomeServer({
    userDid,
    oracleEntityDid,
    userHomeServer,
  }: {
    userDid: string;
    oracleEntityDid: string;
    userHomeServer: string;
  }): Promise<{
    roomId: string | undefined;
    roomAlias: string;
    oracleRoomFullAlias: string;
  }> {
    if (!this.mxClient) {
      throw new Error('Simple client not initialized');
    }

    const oracleRoomAlias = `${getEntityRoomAliasFromDid(userDid)}_${getEntityRoomAliasFromDid(oracleEntityDid)}`;
    const oracleRoomFullAlias = `#${oracleRoomAlias}:${userHomeServer}`;

    // Check cache first
    const cachedRoomId = this.roomCache.get(oracleRoomFullAlias);
    if (cachedRoomId) {
      Logger.debug(
        '🔍 Found cached room id for oracle room alias:',
        oracleRoomFullAlias,
      );
      return {
        roomId: cachedRoomId,
        roomAlias: oracleRoomAlias,
        oracleRoomFullAlias,
      };
    }

    try {
      const roomId = await this.mxClient.resolveRoomAlias(oracleRoomFullAlias);
      Logger.debug(
        '🔍 Resolved room id for oracle room alias:',
        oracleRoomFullAlias,
      );
      this.roomCache.set(oracleRoomFullAlias, roomId);

      return {
        roomId,
        roomAlias: oracleRoomAlias,
        oracleRoomFullAlias,
      };
    } catch (error) {
      Logger.error(
        `Failed to resolve room alias ${oracleRoomFullAlias}:`,
        error,
      );
      return {
        roomId: undefined,
        roomAlias: oracleRoomAlias,
        oracleRoomFullAlias,
      };
    }
  }

  /**
   * Send a message using matrix-bot-sdk - MUCH simpler!
   */
  async sendMessage(options: IMessageOptions): Promise<string> {
    try {
      if (!this.mxClient) {
        throw new Error('Simple client not initialized');
      }

      // Use the simplified sendMessage API from matrix-bot-sdk
      const { content, htmlContent } = formatMsg({
        message: options.message,
        isOracleAdmin: Boolean(options.isOracleAdmin),
        oracleName: options.oracleName ?? this.oracleName,
        disablePrefix: options.disablePrefix,
      });

      return await this.mxClient.sendMessage({
        roomId: options.roomId,
        message: content,
        type: 'html',
        formattedBody: htmlContent,
        threadId: options.threadId,
        metadata: options.metadata,
      });
    } catch (error) {
      Logger.error('❌ Error sending message:', error);
      throw error;
    }
  }

  async editMessage(
    options: IMessageOptions & { messageId: string },
  ): Promise<string> {
    if (!this.mxClient) {
      throw new Error('Simple client not initialized');
    }

    // Use the simplified sendMessage API from matrix-bot-sdk
    const { content, htmlContent } = formatMsg({
      message: options.message,
      isOracleAdmin: Boolean(options.isOracleAdmin),
      oracleName: options.oracleName ?? this.oracleName,
      disablePrefix: options.disablePrefix,
    });

    const ev = {
      msgtype: 'm.text',
      body: content,
      format: 'org.matrix.custom.html',
      formatted_body: htmlContent,
      'm.new_content': {
        msgtype: 'm.text',
        body: content,
        format: 'org.matrix.custom.html',
        formatted_body: htmlContent,
        'm.mentions': {},
      },
      'm.mentions': {},
      'm.relates_to': {
        rel_type: 'm.replace',
        event_id: options.messageId,
      },
    };

    return await this.mxClient.mxClient.sendEvent(
      options.roomId,
      'm.room.message',
      ev,
    );
  }

  /**
   * Listen for room messages using matrix-bot-sdk
   */
  public onMessage(
    callback: (
      roomId: string,
      event: MessageEvent<MessageEventContent>,
    ) => void,
  ): () => void {
    if (!this.mxClient) {
      throw new Error('Simple client not initialized');
    }

    Logger.info('🎧 Setting up message listener with matrix-bot-sdk');
    return this.mxClient.onMessage(callback);
  }

  public listenToMatrixEvent<T extends sdk.EmittedEvents>(
    eventType: T,
    callback: sdk.ClientEventHandlerMap[T],
  ): (() => void) | undefined {
    if (!this.mxClient) {
      throw new Error('Simple client not initialized');
    }

    this.mxClient?.mxClient?.on(eventType, callback);

    return () => {
      this.mxClient?.mxClient?.removeListener(eventType, callback);
    };
  }

  /**
   * Send a state event using matrix-bot-sdk
   */
  public async sendMatrixEvent(
    roomId: string,
    eventType: string,
    content: object,
  ): Promise<string> {
    if (!this.mxClient) {
      throw new Error('Simple client not initialized');
    }

    return await this.mxClient.mxClient.sendEvent(roomId, eventType, content);
  }

  public async sendActionLog(
    roomId: string,
    action: IAction,
    threadId?: string,
  ): Promise<string> {
    return await this.sendMatrixEvent(roomId, 'ixo.action.log', {
      action,
      threadId,
    });
  }

  public async getEventById<T extends object | unknown = unknown>(
    roomId: string,
    eventId: string,
  ): Promise<MatrixEvent<T>> {
    return await this.mxClient?.mxClient.getEvent(roomId, eventId);
  }

  public async getLoginResponse(
    accessToken: string,
  ): Promise<{ user_id: string }> {
    const tempClient = sdk.createClient({
      baseUrl: process.env.MATRIX_BASE_URL ?? '',
      accessToken,
    });

    const loginResponse = await tempClient.whoami();
    if (!loginResponse.user_id || !loginResponse.device_id) {
      throw new sdk.MatrixError({
        error: 'Invalid access token: User ID or device ID not found',
      });
    }

    tempClient.stopClient();
    tempClient.removeAllListeners();
    tempClient.http.abort();

    return loginResponse;
  }

  /**
   * Subscribe to "this bot joined a room" events. Fires once per fresh join
   * (matrix-bot-sdk's `room.join` semantic — does NOT fire on already-joined
   * rooms during initial sync after restart).
   */
  public onBotJoinedRoom(callback: (roomId: string) => void): () => void {
    if (!this.mxClient) {
      throw new Error('Simple client not initialized');
    }
    const fn = (roomId: string): void => {
      try {
        callback(roomId);
      } catch (err) {
        Logger.warn(
          `[MatrixManager.onBotJoinedRoom] handler threw for ${roomId}: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    };
    // matrix-bot-sdk's MatrixClient emits 'room.join' with (roomId) when the
    // bot transitions to joined. Cast through unknown to bridge the type
    // mismatch between matrix-js-sdk and matrix-bot-sdk emitted-event types.
    (
      this.mxClient.mxClient as unknown as {
        on(eventType: string, listener: (roomId: string) => void): void;
        removeListener(
          eventType: string,
          listener: (roomId: string) => void,
        ): void;
      }
    ).on('room.join', fn);
    return () => {
      (
        this.mxClient?.mxClient as unknown as {
          removeListener(
            eventType: string,
            listener: (roomId: string) => void,
          ): void;
        }
      )?.removeListener('room.join', fn);
    };
  }

  public async getDisplayName(userId: string): Promise<string> {
    if (!this.mxClient) {
      throw new Error('Simple client not initialized');
    }
    const profile = await this.mxClient.mxClient.getUserProfile(userId);
    return profile.displayname;
  }

  /**
   * Returns the bot's Matrix user ID (from MATRIX_ORACLE_ADMIN_USER_ID env var).
   * Used to detect whether the bot has been @mentioned in a message.
   */
  public getBotMatrixUserId(): string {
    const userId = process.env.MATRIX_ORACLE_ADMIN_USER_ID;
    if (!userId) {
      throw new Error('MATRIX_ORACLE_ADMIN_USER_ID is not set');
    }
    return userId;
  }

  /**
   * Display name cache keyed by `${roomId}:${matrixUserId}`.
   * Refreshed lazily; falls back to the local-part of the matrix user id
   * when the profile request fails (e.g. federation hiccups).
   */
  private displayNameCache = new Map<
    string,
    { displayName: string; cachedAt: number }
  >();
  private static readonly DISPLAY_NAME_TTL_MS = 30 * 60 * 1000;

  public async getCachedDisplayName(
    matrixUserId: string,
    roomId?: string,
  ): Promise<string> {
    const cacheKey = `${roomId ?? '*'}:${matrixUserId}`;
    const cached = this.displayNameCache.get(cacheKey);
    const now = Date.now();
    if (cached && now - cached.cachedAt < MatrixManager.DISPLAY_NAME_TTL_MS) {
      return cached.displayName;
    }

    let displayName =
      matrixUserId.split(':')[0]?.replace(/^@/, '') ?? matrixUserId;
    try {
      const profile =
        await this.mxClient?.mxClient.getUserProfile(matrixUserId);
      if (profile?.displayname && typeof profile.displayname === 'string') {
        displayName = profile.displayname;
      }
    } catch (err) {
      Logger.warn(
        `[MatrixManager.getCachedDisplayName] Failed to fetch profile for ${matrixUserId}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }

    this.displayNameCache.set(cacheKey, { displayName, cachedAt: now });
    return displayName;
  }

  public invalidateDisplayName(matrixUserId: string, roomId?: string): void {
    if (roomId) {
      this.displayNameCache.delete(`${roomId}:${matrixUserId}`);
    } else {
      // Clear all entries for this user across rooms
      for (const key of this.displayNameCache.keys()) {
        if (key.endsWith(`:${matrixUserId}`)) {
          this.displayNameCache.delete(key);
        }
      }
    }
  }

  /**
   * Resolve a room's "shape" — DM (≤ 2 joined members) vs group.
   * Used to decide whether the agent should mention-gate replies.
   */
  public async getRoomInfo(roomId: string): Promise<{
    isDirect: boolean;
    memberCount: number;
    joinedMemberIds: string[];
  }> {
    if (!this.mxClient) {
      throw new Error('Simple client not initialized');
    }

    let isDirect = false;
    let joinedMemberIds: string[] = [];

    // 1. Try the m.room.create state event — explicit signal
    try {
      const createEvent = (await this.mxClient.mxClient.doRequest(
        'GET',
        `/_matrix/client/v3/rooms/${encodeURIComponent(roomId)}/state/m.room.create/`,
      )) as { is_direct?: boolean } | undefined;
      if (createEvent?.is_direct === true) {
        isDirect = true;
      }
    } catch {
      // Some rooms may not expose this (or 403). Fall through to member-count heuristic.
    }

    // 2. Fetch joined members regardless — needed for member count anyway
    try {
      const joined = (await this.mxClient.mxClient.doRequest(
        'GET',
        `/_matrix/client/v3/rooms/${encodeURIComponent(roomId)}/joined_members`,
      )) as { joined?: Record<string, unknown> } | undefined;
      joinedMemberIds = Object.keys(joined?.joined ?? {});
    } catch (err) {
      Logger.warn(
        `[MatrixManager.getRoomInfo] joined_members failed for ${roomId}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }

    const memberCount = joinedMemberIds.length;
    if (!isDirect && memberCount > 0 && memberCount <= 2) {
      isDirect = true;
    }

    return { isDirect, memberCount, joinedMemberIds };
  }

  /**
   * Fetch recent room messages, decrypting events transparently.
   * Used for cross-thread context injection at group session start.
   *
   * Returns messages in chronological order (oldest → newest).
   * Encrypted events that fail to decrypt are skipped.
   *
   * `paginationToken` in the result is the opaque `end` token from the Matrix
   * `/messages` response — pass it as `from` on the next call to page further back.
   */
  public async getRecentRoomMessages(
    roomId: string,
    options: { limit?: number; from?: string } = {},
  ): Promise<{
    messages: Array<{
      eventId: string;
      sender: string;
      body: string;
      timestamp: number;
      threadId?: string;
      msgtype?: string;
    }>;
    paginationToken?: string;
  }> {
    if (!this.mxClient) {
      throw new Error('Simple client not initialized');
    }
    const limit = Math.min(options.limit ?? 30, 200);
    const crypto = this.mxClient.mxClient.crypto;

    const qs: Record<string, string | number> = {
      dir: 'b',
      limit: Math.min(limit * 3, 200),
    };

    // `from` must be an opaque Matrix pagination token (e.g. the `end` field from
    // a previous /messages response), NOT an event ID. When no token is provided we
    // fall back to the stored sync token so Synapse can locate the timeline end.
    if (options.from) {
      qs.from = options.from;
    } else {
      const syncToken =
        await this.mxClient.mxClient.storageProvider.getSyncToken();

      Logger.info(
        `[MatrixManager.getRecentRoomMessages] syncToken: ${syncToken} for room ${roomId}`,
      );

      if (syncToken) {
        qs.from = syncToken;
      }
    }

    Logger.info(
      `[MatrixManager.getRecentRoomMessages] qs: ${JSON.stringify(qs)} for room ${roomId}`,
    );

    const response = (await this.mxClient.mxClient.doRequest(
      'GET',
      `/_matrix/client/v3/rooms/${encodeURIComponent(roomId)}/messages`,
      qs,
    )) as { chunk?: Array<Record<string, unknown>>; end?: string };

    const out: Array<{
      eventId: string;
      sender: string;
      body: string;
      timestamp: number;
      threadId?: string;
      msgtype?: string;
    }> = [];

    for (const raw of response.chunk ?? []) {
      if (out.length >= limit) break;

      const eventId = raw.event_id as string;
      const sender = raw.sender as string;
      const ts = (raw.origin_server_ts as number) ?? 0;
      const eventType = raw.type as string;
      let content: Record<string, unknown> | undefined;

      if (eventType === 'm.room.encrypted') {
        if (!crypto) continue;
        try {
          // Avoid a static import of EncryptedRoomEvent to keep this file
          // free of new top-level deps; use a structural cast instead.
          const decrypted = await crypto.decryptRoomEvent(
            new EncryptedRoomEvent(raw),
            roomId,
          );
          content = decrypted.content as Record<string, unknown>;
        } catch {
          continue;
        }
      } else if (eventType === 'm.room.message') {
        content = raw.content as Record<string, unknown>;
      } else {
        continue;
      }

      if (!content) continue;
      if ('INTERNAL' in content) continue; // skip oracle bookkeeping events

      const body = content.body;
      if (typeof body !== 'string' || body.length === 0) continue;

      const relates = (content['m.relates_to'] ?? {}) as {
        rel_type?: string;
        event_id?: string;
        ['m.in_reply_to']?: { event_id?: string };
      };
      const threadId =
        relates.rel_type === 'm.thread'
          ? relates.event_id
          : relates['m.in_reply_to']?.event_id;

      out.push({
        eventId,
        sender,
        body,
        timestamp: ts,
        threadId,
        msgtype: content.msgtype as string | undefined,
      });
    }

    return {
      messages: out.reverse(),
      paginationToken: response.end,
    };
  }

  /**
   * Join a room using matrix-bot-sdk
   */
  public async joinRoom(roomIdOrAlias: string): Promise<string> {
    if (!this.mxClient) {
      throw new Error('Simple client not initialized');
    }

    return await this.mxClient.joinRoom(roomIdOrAlias);
  }

  /**
   * Get the underlying SimpleMatrixClient for advanced operations
   */
  public getClient(): SimpleMatrixClient | undefined {
    return this.mxClient;
  }

  /**
   * Gracefully stop the Matrix client to avoid crypto corruption
   */
  public async shutdown(): Promise<void> {
    if (!this.mxClient) {
      return;
    }

    try {
      Logger.info(
        'MatrixManager graceful shutdown: stopping Matrix client sync...',
      );
      await this.mxClient.stop();
      Logger.info(
        'MatrixManager graceful shutdown: Matrix client sync stopped',
      );

      Logger.info(
        'MatrixManager graceful shutdown: waiting for pending sync operations...',
      );
      await new Promise((resolve) => setTimeout(resolve, 1500));

      const cryptoClient = (
        this.mxClient.mxClient as unknown as Record<string, unknown>
      )?.crypto as
        | { engine?: { machine?: { close?: () => void } } }
        | undefined;
      if (cryptoClient?.engine?.machine?.close) {
        Logger.info('MatrixManager graceful shutdown: closing crypto store...');
        cryptoClient.engine.machine.close();
        Logger.info('MatrixManager graceful shutdown: crypto store closed');
      }

      await new Promise((resolve) => setTimeout(resolve, 1000));
      this.isInitialized = false;
      Logger.info('MatrixManager graceful shutdown complete');
    } catch (error) {
      Logger.error('Error during MatrixManager graceful shutdown:', error);
      throw error;
    }
  }
}

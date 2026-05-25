import { Logger } from '@ixo/logger';
import {
  AutojoinRoomsMixin,
  LogService,
  MatrixClient,
  MessageEvent,
  type MessageEventContent,
  RustSdkCryptoStorageProvider,
  SimpleFsStorageProvider,
  UserID,
} from 'matrix-bot-sdk';
import * as path from 'node:path';

export interface ISimpleMatrixClientConfig {
  baseUrl: string;
  accessToken: string;
  userId: string;
  storagePath?: string;
  autoJoin?: boolean;
  recoveryKey?: string;
}

export interface IMessageOptions {
  roomId: string;
  message: string;
  threadId?: string;

  type?: 'text' | 'html';
  formattedBody?: string;
  /** Custom fields spread onto the Matrix event content (e.g. `{ 'ixo.task_id': '...' }`) */
  metadata?: Record<string, unknown>;
}

/**
 * Simple Matrix Client using matrix-bot-sdk with RustSdkCryptoStorageProvider
 * Following the official examples - much cleaner than matrix-js-sdk!
 */
export class SimpleMatrixClient {
  public mxClient: MatrixClient;

  // Cache the bot's display name and ID for usage later
  public userId: string;
  public displayName: string;
  public localpart: string;
  public homeServerName: string;

  private storage: SimpleFsStorageProvider;
  private cryptoStore: RustSdkCryptoStorageProvider;
  private config: ISimpleMatrixClientConfig;
  private isStarted = false;

  constructor(config: ISimpleMatrixClientConfig) {
    this.config = config;
    this.prepareStorage();
    this.prepareCryptoStorage();
    this.createClient();
    this.extraConfig(config.autoJoin ?? true);
  }

  public async prepareProfile(): Promise<void> {
    this.userId = await this.mxClient.getUserId();
    const userId = new UserID(this.userId);
    this.localpart = userId.localpart;
    this.homeServerName = userId.domain;

    try {
      const profile = await this.mxClient.getUserProfile(this.userId);
      if (profile?.displayname) {
        this.displayName = profile.displayname;
      }
    } catch (e) {
      // Non-fatal error - we'll just log it and move on
      LogService.warn('Matrix Client prepareProfile', e);
    }
  }

  private prepareStorage(): void {
    // Prepare the storage system for the bot
    const storagePath = this.config.storagePath || './matrix-storage';
    this.storage = new SimpleFsStorageProvider(
      path.join(storagePath, 'bot.json'),
    );
  }

  private prepareCryptoStorage(): void {
    // Prepare a crypto store using Rust SDK with SQLite backend
    // Using numeric value 0 for StoreType.Sqlite (const enum, not accessible with isolatedModules)
    const storagePath = this.config.storagePath || './matrix-storage';
    this.cryptoStore = new RustSdkCryptoStorageProvider(
      path.join(storagePath, 'encrypted-sqlite'),
      0, // StoreType.Sqlite from @ixo/matrix-sdk-crypto-nodejs
    );
  }

  private createClient(): void {
    if (!this.storage) throw new Error('Storage not prepared');
    const cryptoConfig = this.config.recoveryKey
      ? { recoveryKey: this.config.recoveryKey }
      : undefined;
    this.mxClient = new MatrixClient(
      this.config.baseUrl,
      this.config.accessToken,
      this.storage,
      this.cryptoStore,
      cryptoConfig,
    );
  }

  private extraConfig(autoJoin: boolean): void {
    // Setup the autojoin mixin (if enabled)
    if (autoJoin) {
      // Default to true unless explicitly disabled
      AutojoinRoomsMixin.setupOnClient(this.mxClient);
    }
  }

  /**
   * Start the matrix client - much simpler than matrix-js-sdk!
   */
  public async start(): Promise<void> {
    if (this.isStarted) {
      Logger.warn('Matrix client already started');
      return;
    }

    try {
      Logger.info('🚀 Starting matrix-bot-sdk client...');

      await this.prepareProfile();
      await this.mxClient.start();

      this.isStarted = true;
      Logger.info('✅ Matrix client started successfully!');
    } catch (error) {
      Logger.error('❌ Failed to start matrix client:', error);
      throw error;
    }
  }

  /**
   * Stop the matrix client
   */
  public async stop(): Promise<void> {
    if (!this.isStarted) return;

    try {
      this.mxClient.stop();
      this.isStarted = false;
      Logger.info('✅ Matrix client stopped');
    } catch (error) {
      Logger.error('❌ Failed to stop matrix client:', error);
      throw error;
    }
  }

  /**
   * Send a message to a room
   */
  public async sendMessage(options: IMessageOptions): Promise<string> {
    if (!this.isStarted) {
      throw new Error('Matrix client not started');
    }

    try {
      Logger.info(`📤 Sending message to room ${options.roomId}`);

      // Use matrix-bot-sdk's sendText method
      const eventId = await this.mxClient.sendMessage(options.roomId, {
        body: options.message,
        'm.mentions': {},
        msgtype: 'm.text',
        ...(options.threadId
          ? {
              'm.relates_to': {
                event_id: options.threadId,
                is_falling_back: true,
                'm.in_reply_to': {
                  event_id: options.threadId,
                },
                rel_type: 'm.thread',
              },
            }
          : {}),
        ...(options.type === 'html'
          ? {
              format: 'org.matrix.custom.html',
              formatted_body: options.formattedBody,
            }
          : {}),
        ...(options.metadata ?? {}),
      });

      Logger.info(`✅ Message sent successfully: ${eventId}`);
      return eventId;
    } catch (error) {
      Logger.error(`❌ Failed to send message to ${options.roomId}:`, error);
      throw error;
    }
  }

  /**
   * Send a state event to a room
   */
  public async sendStateEvent(
    roomId: string,
    eventType: string,
    content: Record<string, unknown>,
    stateKey = '',
  ): Promise<string> {
    if (!this.isStarted) {
      throw new Error('Matrix client not started');
    }

    try {
      Logger.info(`📤 Sending state event ${eventType} to room ${roomId}`);

      const eventId = await this.mxClient.sendStateEvent(
        roomId,
        eventType,
        stateKey,
        content,
      );

      Logger.info(`✅ State event sent successfully: ${eventId}`);
      return eventId;
    } catch (error) {
      Logger.error(`❌ Failed to send state event to ${roomId}:`, error);
      throw error;
    }
  }

  /**
   * Join a room
   */
  public async joinRoom(roomIdOrAlias: string): Promise<string> {
    if (!this.isStarted) {
      throw new Error('Matrix client not started');
    }

    try {
      Logger.info(`🚪 Joining room ${roomIdOrAlias}`);

      const roomId = await this.mxClient.joinRoom(roomIdOrAlias);

      Logger.info(`✅ Joined room successfully: ${roomId}`);
      return roomId;
    } catch (error) {
      Logger.error(`❌ Failed to join room ${roomIdOrAlias}:`, error);
      throw error;
    }
  }

  /**
   * Resolve room alias to room ID
   */
  public async resolveRoomAlias(alias: string): Promise<string> {
    if (!this.isStarted) {
      throw new Error('Matrix client not started');
    }

    try {
      Logger.info(`🔍 Resolving room alias ${alias}`);

      const resolved = await this.mxClient.resolveRoom(alias);

      Logger.info(`✅ Room alias resolved: ${resolved}`);
      return resolved;
    } catch (error) {
      Logger.error(`❌ Failed to resolve room alias ${alias}:`, error);
      throw error;
    }
  }

  /**
   * Listen for room messages - return a function to remove the listener
   */
  public onMessage(
    callback: (
      roomId: string,
      event: MessageEvent<MessageEventContent>,
    ) => void,
  ): () => void {
    const fn = (roomId: string, event: Record<string, unknown>) => {
      const message = new MessageEvent(event);
      if (!message) return;

      callback(roomId, message);
    };
    this.mxClient.on('room.message', fn);

    return () => {
      this.mxClient.removeListener('room.message', fn);
    };
  }

  /**
   * Remove message listener
   */
  public removeListener(
    event: string,
    callback: (...args: unknown[]) => void,
  ): void {
    this.mxClient.removeListener(event, callback);
  }
}

/**
 * Create and configure a SimpleMatrixClient
 */
export function createSimpleMatrixClient(
  config: ISimpleMatrixClientConfig,
): SimpleMatrixClient {
  return new SimpleMatrixClient(config);
}

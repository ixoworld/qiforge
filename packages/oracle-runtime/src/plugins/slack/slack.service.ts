import { ChatSession } from '@ixo/common';
import { Slack } from '@ixo/slack';
import { CACHE_MANAGER } from '@nestjs/cache-manager';
import {
  Inject,
  Injectable,
  Logger,
  type OnModuleDestroy,
  type OnModuleInit,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Cache } from 'cache-manager';
import { MessagesService } from '../../modules/messages/messages.service.js';
import { SessionsService } from '../../modules/sessions/sessions.service.js';

@Injectable()
export class SlackService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(SlackService.name);
  private slackInstance?: Slack;
  private readonly isConfigured: boolean;

  constructor(
    private readonly configService: ConfigService,
    private readonly messagesService: MessagesService,
    @Inject(CACHE_MANAGER) private readonly cacheManager: Cache,
    private readonly sessionsService: SessionsService,
  ) {
    const botToken = configService.get<string>('SLACK_BOT_OAUTH_TOKEN');
    const appToken = configService.get<string>('SLACK_APP_TOKEN');
    const useSocketMode = true;
    this.isConfigured = Boolean(botToken);

    if (!botToken) {
      this.logger.warn(
        'SLACK_BOT_OAUTH_TOKEN not provided — Slack integration will be disabled',
      );
      return;
    }

    if (useSocketMode && !appToken) {
      this.logger.error(
        'SLACK_APP_TOKEN is required when SLACK_USE_SOCKET_MODE=true',
      );
      throw new Error(
        'SLACK_APP_TOKEN is required when SLACK_USE_SOCKET_MODE=true',
      );
    }

    try {
      this.slackInstance = new Slack(botToken, appToken ?? '', {
        useSocketMode,
      });
    } catch (error) {
      this.logger.error('Failed to initialize Slack instance:', error);
      throw error;
    }
  }

  async onModuleInit(): Promise<void> {
    if (!this.slackInstance) {
      this.logger.warn('Slack not configured — skipping initialization');
      return;
    }

    try {
      const useSocketMode =
        this.configService.get('SLACK_USE_SOCKET_MODE') === 'true';
      const mode = useSocketMode ? 'Socket Mode' : 'HTTP Mode';
      this.logger.log(`Initializing Slack ${mode} connection...`);

      this.onMessageHandler();

      await this.slackInstance.start();
      this.logger.log(`Slack ${mode} connection initialized successfully`);
    } catch (error) {
      this.logger.error('Failed to initialize Slack:', error);
      this.logger.warn('Continuing without Slack integration');
    }
  }

  async onModuleDestroy(): Promise<void> {
    if (!this.slackInstance) return;

    try {
      this.logger.log('Shutting down Slack connection...');
      await this.slackInstance.stop();
      this.logger.log('Slack connection shut down successfully');
    } catch (error) {
      this.logger.error('Error shutting down Slack:', error);
    }
  }

  /** Connection status for health checks. */
  getStatus(): {
    isConnected: boolean;
    connectionStats: {
      isConnected: boolean;
      reconnectAttempts: number;
      maxReconnectAttempts: number;
      mode: 'socket' | 'http';
    };
    isConfigured: boolean;
  } {
    if (!this.isConfigured || !this.slackInstance) {
      return {
        isConnected: false,
        connectionStats: {
          isConnected: false,
          reconnectAttempts: 0,
          maxReconnectAttempts: 0,
          mode: 'http',
        },
        isConfigured: false,
      };
    }

    return {
      isConnected: this.slackInstance.isConnected(),
      connectionStats: this.slackInstance.getConnectionStats(),
      isConfigured: true,
    };
  }

  private async getCachedSessionPerThread(
    threadTs: string,
  ): Promise<ChatSession | undefined> {
    const cacheKey = `session:${threadTs}`;
    return this.cacheManager.get<ChatSession>(cacheKey);
  }

  private async getOrCreateSessionPerThread(
    threadTs: string,
    userDid: string,
  ): Promise<ChatSession> {
    const cachedSession = await this.getCachedSessionPerThread(threadTs);
    if (cachedSession) return cachedSession;

    const sessions = await this.sessionsService.listSessions({ did: userDid });
    const targetSession = sessions.sessions.find(
      (s) => s.slackThreadTs === threadTs,
    );
    if (targetSession) {
      void this.cacheManager.set(
        `session:${threadTs}`,
        targetSession,
        5 * 60 * 1000,
      );
      return targetSession;
    }

    const newSession = await this.sessionsService.createSession({
      did: userDid,
      slackThreadTs: threadTs,
    });
    void this.cacheManager.set(
      `session:${threadTs}`,
      newSession,
      5 * 60 * 1000,
    );
    return newSession;
  }

  private onMessageHandler(): void {
    if (!this.slackInstance?.app) return;
    this.slackInstance.app.message(async ({ message, say }) => {
      this.logger.debug('Message received', { message });
      if (
        message.type === 'message' &&
        message.subtype === undefined &&
        typeof message.text === 'string'
      ) {
        const userDid = 'did:ixo:ixo100jprv3ap66prgdvyuxhuynhp2muv0pclyx4l7';
        const threadTs = message.thread_ts ?? message.ts;

        const session = await this.getOrCreateSessionPerThread(
          threadTs,
          userDid,
        );
        const aiMessage = await this.messagesService.sendMessage({
          did: userDid,
          message: message.text,
          sessionId: session.sessionId,
        });

        void say({
          text: aiMessage?.message.content ?? '',
          thread_ts: threadTs,
        });
      }
    });
    this.logger.log('Slack message handler registered');
  }
}

import { CacheModule } from '@nestjs/cache-manager';
import {
  Logger,
  type MiddlewareConsumer,
  Module,
  type NestModule,
  RequestMethod,
} from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { APP_GUARD } from '@nestjs/core';
import { ScheduleModule } from '@nestjs/schedule';
import { ThrottlerGuard, ThrottlerModule } from '@nestjs/throttler';
import { AppController } from './app.controller';
import { AppService } from './app.service';
import { BlobStoreModule } from './blob-store/blob-store.module';
import { CallsModule } from './calls/calls.module';
import { ChannelMemoryModule } from './channel-memory/channel-memory.module';
import { type ENV, EnvSchema, getConfig, isRedisEnabled } from './config';
import { MessagesModule } from './messages/messages.module';
import { AuthHeaderMiddleware } from './middleware/auth-header.middleware';
import { SubscriptionMiddleware } from './middleware/subscription.middleware';
import { SessionsModule } from './sessions/sessions.module';
import { SlackModule } from './slack/slack.module';
import { ClaimProcessingService } from './claim-processing/claim-processing.service';
import { UcanModule } from './ucan/ucan.module';
import { normalizeDid } from './utils/header.utils';
import { RedisService } from './utils/redis.service';
import { TasksModule } from './tasks/tasks.module';
import { UserPreferencesModule } from './user-preferences/user-preferences.module';
import { WsModule } from './ws/ws.module';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      validate: (config) => {
        const result = EnvSchema.safeParse(config);
        if (!result.success) {
          // Log detailed errors
          Logger.error('Environment variable validation failed:', result.error);
          throw result.error;
        }
        const ORACLE_DID = normalizeDid(
          result.data.MATRIX_ORACLE_ADMIN_USER_ID,
        );
        return {
          ...result.data,
          ORACLE_DID,
        };
      },
    }),
    CacheModule.register({
      isGlobal: true,
    }),
    ThrottlerModule.forRoot([
      {
        ttl: 60000, // Time-to-live in milliseconds (e.g., 60 seconds)
        limit: 10, // Max requests per TTL period
      },
    ]),
    WsModule,
    // ChromaDbModule.forRoot(),
    ChannelMemoryModule,
    SessionsModule,
    MessagesModule,
    UcanModule,
    BlobStoreModule,
    // TasksModule requires Redis for BullMQ job queues
    ...(isRedisEnabled() ? [TasksModule] : []),
    // KnowledgeModule,
    ScheduleModule.forRoot(),
    SlackModule,
    CallsModule,
    UserPreferencesModule,
  ],
  controllers: [AppController],
  providers: [
    AppService,
    {
      provide: RedisService,
      useFactory: (configService: ConfigService<ENV>) => {
        const config = getConfig(configService);
        if (!isRedisEnabled()) {
          Logger.log('RedisService disabled (REDIS_URL not configured)');
          return null;
        }
        if (config.get('DISABLE_CREDITS')) {
          Logger.log('RedisService disabled (DISABLE_CREDITS=true)');
          return null;
        }
        return new RedisService(configService);
      },
      inject: [ConfigService],
    },
    {
      provide: ClaimProcessingService,
      useFactory: (configService: ConfigService<ENV>) => {
        const config = getConfig(configService);
        if (!isRedisEnabled()) {
          Logger.log(
            'ClaimProcessingService disabled (REDIS_URL not configured)',
          );
          return null;
        }
        if (config.get('DISABLE_CREDITS')) {
          Logger.log('ClaimProcessingService disabled (DISABLE_CREDITS=true)');
          return null;
        }
        return new ClaimProcessingService(configService);
      },
      inject: [ConfigService],
    },
    {
      provide: APP_GUARD, // Apply ThrottlerGuard globally
      useClass: ThrottlerGuard,
    },
  ],
  exports: [RedisService],
})
export class AppModule implements NestModule {
  constructor(private readonly configService: ConfigService<ENV>) {}
  configure(consumer: MiddlewareConsumer) {
    const disableCredits = this.configService.get('DISABLE_CREDITS', false);
    const skipSubscription = disableCredits || !isRedisEnabled();

    if (skipSubscription) {
      const reason = !isRedisEnabled()
        ? 'REDIS_URL not configured'
        : 'DISABLE_CREDITS=true';
      Logger.log(`Subscription middleware disabled (${reason})`);
      consumer
        .apply(AuthHeaderMiddleware)
        .exclude(
          { path: '/', method: RequestMethod.ALL },
          { path: '/health', method: RequestMethod.ALL },
          { path: '/docs', method: RequestMethod.ALL },
          { path: '/docs/(.*)', method: RequestMethod.ALL },
        )
        .forRoutes('*');
    } else {
      consumer
        .apply(AuthHeaderMiddleware, SubscriptionMiddleware)
        .exclude(
          { path: '/', method: RequestMethod.ALL },
          { path: '/health', method: RequestMethod.ALL },
          { path: '/docs', method: RequestMethod.ALL },
          { path: '/docs/(.*)', method: RequestMethod.ALL },
        )
        .forRoutes('*');
    }
  }
}

import { getSubscriptionUrlByNetwork } from '@ixo/common';
import { MatrixManager } from '@ixo/matrix';
import {
  loadEncryptionKey,
  setupClaimSigningMnemonics,
} from '@ixo/oracles-chain-client';
import { CACHE_MANAGER } from '@nestjs/cache-manager';
import { type INestApplication, Logger, ValidationPipe } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { NestFactory } from '@nestjs/core';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import type { Cache } from 'cache-manager';
import helmet from 'helmet';
import { AppModule } from './app.module';
import { type ENV, isRedisEnabled } from './config';
import { UcanService } from './ucan/ucan.service';
import { EditorMatrixClient } from './graph/agents/editor/editor-mx';
import { SecretsService } from './secrets/secrets.service';
import { UserMatrixSqliteSyncService } from './user-matrix-sqlite-sync-service/user-matrix-sqlite-sync-service.service';
import { UserPreferencesService } from './user-preferences/user-preferences.service';

async function bootstrap(): Promise<void> {
  // await migrate();

  const app = await NestFactory.create(AppModule);
  const configService = app.get(ConfigService<ENV>);
  const port = configService.get<number>('PORT', 3000); // Default to 3000 if PORT not set

  // Security Headers
  app.use(helmet());

  // CORS
  app.enableCors({
    origin: process.env.CORS_ORIGIN || '*', // Configure as needed
    credentials: true,
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'OPTIONS'],
    allowedHeaders: [
      'Content-Type',
      'Authorization',
      'x-matrix-access-token',
      'x-matrix-homeserver',
      'x-did',
      'x-request-id',
      'x-timezone',
      'x-ucan-delegation',
    ],
    exposedHeaders: ['X-Request-Id'],
  });

  // Global Validation Pipe
  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true, // Strip properties that do not have any decorators
      transform: true, // Automatically transform payloads to DTO instances
    }),
  );

  // Swagger API Documentation
  const config = new DocumentBuilder()
    .setTitle('API Boilerplate')
    .setDescription('The API description for the boilerplate')
    // set json docs link
    .setExternalDoc('OpenAPI JSON', '/docs/json')
    .setVersion('1.0')
    // Define the Matrix access token header as an API key security scheme
    .addApiKey(
      {
        type: 'apiKey',
        in: 'header',
        name: 'x-matrix-access-token',
        description: "User's Matrix access token (Required for most endpoints)",
      },
      'matrix-token',
    )
    .addApiKey(
      {
        type: 'apiKey',
        in: 'header',
        name: 'x-matrix-homeserver',
        description: "User's Matrix homeserver domain (e.g. devmx.ixo.earth)",
      },
      'matrix-homeserver',
    )
    .addSecurityRequirements('matrix-token')
    .addSecurityRequirements('matrix-homeserver')
    // Remove the duplicate global parameters
    .build();
  const document = SwaggerModule.createDocument(app, config);

  // Serve Swagger JSON at the specified URL
  app.use('/docs/json', (req, res) => {
    res.json(document);
  });

  SwaggerModule.setup('docs', app, document, {
    // explorer: true,
    // customSiteTitle: 'API Documentation',
    swaggerUrl: '/docs/json',
  });

  const matrixManager = MatrixManager.getInstance();

  registerGracefulShutdown({ app, matrixManager });

  // SecretsService is a manual singleton (not @Injectable) because it's accessed from
  // LangGraph agent code outside NestJS DI. Pass the cache manager here at bootstrap.
  const cache = app.get<Cache>(CACHE_MANAGER);
  SecretsService.getInstance().setCacheManager(cache);
  UserPreferencesService.getInstance().setCacheManager(cache);

  // Fire Matrix init in background (don't await — let server start for health checks).
  // MessagesService.onModuleInit defers its listener until this completes.
  Logger.log('Initializing MatrixManager (background)...');
  try {
    await matrixManager.init();
    Logger.log('MatrixManager initialized successfully');
    Logger.log(`Oracle: ${matrixManager.getClient()?.userId}`);

    // Initialize non-critical services after Matrix is ready
    const editorMatrixClient = EditorMatrixClient.getInstance();
    editorMatrixClient.init().catch((error) => {
      Logger.error('Failed to initialize EditorMatrixClient:', error);
      Logger.warn('Editor functionality may be limited until sync completes');
    });
    Logger.log('EditorMatrixClient initialization started in background...');

    const matrixAccountRoomId = configService.get('MATRIX_ACCOUNT_ROOM_ID');
    // still run setupClaimSigningMnemonics even if DISABLE_CREDITS as need it for ucan signing
    Logger.log('Setting up claim signing mnemonics...');
    Logger.log(`Matrix account room id: ${matrixAccountRoomId}`);
    const signingMnemonic = await setupClaimSigningMnemonics({
      matrixRoomId: matrixAccountRoomId,
      matrixAccessToken: configService.getOrThrow(
        'MATRIX_ORACLE_ADMIN_ACCESS_TOKEN',
      ),
      walletMnemonic: configService.getOrThrow('SECP_MNEMONIC'),
      pin: configService.getOrThrow('MATRIX_VALUE_PIN'),
      signerDid: configService.getOrThrow('ORACLE_DID'),
      network: configService.getOrThrow('NETWORK'),
    });
    Logger.log('Claim signing mnemonics setup complete');

    if (signingMnemonic) {
      const ucanService = app.get(UcanService);
      ucanService.setSigningMnemonic(
        signingMnemonic,
        configService.getOrThrow('ORACLE_DID'),
      );
    }

    // Load P-256 encryption key for user secrets
    if (matrixAccountRoomId) {
      Logger.log('Loading P-256 encryption key...');
      const encryptionKeyResult = await loadEncryptionKey({
        matrixRoomId: matrixAccountRoomId,
        matrixAccessToken: configService.getOrThrow(
          'MATRIX_ORACLE_ADMIN_ACCESS_TOKEN',
        ),
        pin: configService.getOrThrow('MATRIX_VALUE_PIN'),
        signerDid: configService.getOrThrow('ORACLE_DID'),
      });
      if (encryptionKeyResult) {
        SecretsService.getInstance().setEncryptionKey(
          encryptionKeyResult.privateJwk,
        );
        Logger.log('P-256 encryption key loaded successfully');
      } else {
        Logger.warn(
          'No P-256 encryption key found. User secrets will be unavailable. ' +
            'Run "oracles-cli setup-encryption-key" to provision one.',
        );
      }
    }
  } catch (error) {
    Logger.error('Failed to initialize MatrixManager:', error);
  }

  // Server starts immediately — health checks pass while Matrix syncs in background
  await app.listen(port, '0.0.0.0');
  Logger.log(`Application is running on: ${await app.getUrl()}`);
  Logger.log(`Swagger UI available at: ${await app.getUrl()}/docs`);
  Logger.log(
    `subscription: ${configService.get('SUBSCRIPTION_URL') ?? getSubscriptionUrlByNetwork(configService.getOrThrow('NETWORK'))}`,
  );
  Logger.log(
    `Credits disabled: ${configService.get('DISABLE_CREDITS')}. type: ${typeof configService.get('DISABLE_CREDITS')}`,
  );

  if (!isRedisEnabled()) {
    Logger.warn('--- Redis is NOT configured (REDIS_URL not set) ---');
    Logger.warn('The following features are disabled:');
    Logger.warn('  • TasksModule (BullMQ job queues / scheduled tasks)');
    Logger.warn('  • TokenLimiter (credit/token tracking)');
    Logger.warn('  • ClaimProcessingService (on-chain credit claims)');
    Logger.warn('  • RedisService (direct Redis client)');
    Logger.warn('Set REDIS_URL to enable these features.');
  }
}

function registerGracefulShutdown({
  app,
  matrixManager,
}: {
  app: INestApplication;
  matrixManager: MatrixManager;
}): void {
  const context = 'Bootstrap';

  const gracefulShutdown = async (signal: NodeJS.Signals) => {
    Logger.log(`${signal} received, starting graceful shutdown...`, context);

    try {
      // Step 1: Upload checkpoints to Matrix
      try {
        const userMatrixSqliteSyncService = app.get(
          UserMatrixSqliteSyncService,
        );
        Logger.log(
          'Uploading checkpoint to Matrix storage task started',
          context,
        );
        await userMatrixSqliteSyncService.uploadCheckpointToMatrixStorageTask();
        Logger.log(
          'Uploading checkpoint to Matrix storage task complete',
          context,
        );
      } catch (error) {
        Logger.warn(
          'Failed to upload checkpoint during shutdown (continuing anyway)',
          error instanceof Error ? error.message : String(error),
          context,
        );
      }

      // Step 2: Close Nest application
      try {
        Logger.log('Stopping Nest application...', context);
        await app.close();
        Logger.log('Nest application stopped', context);
      } catch (error) {
        Logger.error(
          'Error stopping Nest application',
          error instanceof Error ? error.message : String(error),
          context,
        );
      }

      // Step 3: Shutdown MatrixManager
      try {
        Logger.log('Stopping MatrixManager client...', context);
        await matrixManager.shutdown();
        Logger.log('MatrixManager client stopped', context);
      } catch (error) {
        Logger.error(
          'Error stopping MatrixManager',
          error instanceof Error ? error.message : String(error),
          context,
        );
      }

      // Step 4: Destroy EditorMatrixClient
      try {
        Logger.log('Stopping EditorMatrixClient...', context);
        await EditorMatrixClient.destroy();
        Logger.log('EditorMatrixClient stopped', context);
      } catch (error) {
        Logger.error(
          'Error stopping EditorMatrixClient',
          error instanceof Error ? error.message : String(error),
          context,
        );
      }

      Logger.log('Graceful shutdown complete', context);
      process.exit(0);
    } catch (error) {
      Logger.error(
        'Error during graceful shutdown',
        error instanceof Error ? error.stack : String(error),
        context,
      );
      process.exit(1);
    }
  };

  ['SIGTERM', 'SIGINT'].forEach((signal) => {
    process.once(signal, () => void gracefulShutdown(signal as NodeJS.Signals));
  });
}

// Handle unhandled promise rejections
process.on(
  'unhandledRejection',
  (reason: unknown, promise: Promise<unknown>) => {
    const context = 'UnhandledRejection';
    Logger.error(
      `Unhandled Promise Rejection: ${reason instanceof Error ? reason.message : String(reason)}`,
      reason instanceof Error ? reason.stack : String(reason),
      context,
    );
    // Log the promise for debugging (but don't log the full promise object as it may be circular)
    Logger.error(`Promise: ${String(promise)}`, context);
    // Don't exit - let the server continue running, but log the error
  },
);

// Handle uncaught exceptions
process.on('uncaughtException', (error: Error) => {
  const context = 'UncaughtException';
  Logger.error(`Uncaught Exception: ${error.message}`, error.stack, context);
  // For uncaught exceptions, we should exit gracefully
  // But give it a moment to log and clean up
  setTimeout(() => {
    Logger.error('Exiting due to uncaught exception', context);
    process.exit(1);
  }, 1000);
});

// Wrap bootstrap in try-catch to handle initialization errors
bootstrap().catch((error) => {
  Logger.error(
    'Failed to start application',
    error instanceof Error ? error.stack : String(error),
    'Bootstrap',
  );
  process.exit(1);
});

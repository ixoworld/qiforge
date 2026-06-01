import {
  type DynamicModule,
  Logger,
  Module,
  type Provider,
} from '@nestjs/common';
import type { Redis } from 'ioredis';
import {
  FILE_PROCESSING_CREDIT_SINK,
  type FileProcessingCreditSink,
  type FileProcessingUsage,
} from '../../modules/messages/file-processing-credit-sink.port.js';
import { TokenLimiter, type CreditsNetwork } from './token-limiter.js';

export interface FileProcessingSinkModuleOptions {
  redis: Redis;
  network: CreditsNetwork;
  disableCredits?: boolean;
}

const SINK_LOGGER = new Logger('FileProcessingCreditSink');

/**
 * Wires `FILE_PROCESSING_CREDIT_SINK` for `FileProcessingService`. The
 * adapter delegates to a fresh `TokenLimiter` instance — TokenLimiter is
 * stateless (state lives in Redis), so multiple instances pointing at the
 * same Redis are equivalent.
 */
@Module({})
export class FileProcessingSinkModule {
  static register(opts: FileProcessingSinkModuleOptions): DynamicModule {
    const limiter = new TokenLimiter({
      redis: opts.redis,
      network: opts.network,
      disableCredits: opts.disableCredits ?? false,
      logger: {
        log: (msg) => SINK_LOGGER.log(msg),
        warn: (msg) => SINK_LOGGER.warn(msg),
        error: (msg) => SINK_LOGGER.error(msg),
      },
    });

    const sink: FileProcessingCreditSink = {
      async deductForFileProcessing(
        userDid: string,
        usage: FileProcessingUsage,
      ): Promise<void> {
        const credits =
          usage.cost > 0
            ? limiter.usdCostToCredits(usage.cost)
            : limiter.llmTokenToCredits(
                usage.promptTokens + usage.completionTokens,
              );
        if (credits <= 0) return;
        await limiter.limit(userDid, credits);
        SINK_LOGGER.log(
          `Deducted ${credits} credits for file processing (did=${userDid}, cost=$${usage.cost})`,
        );
      },
    };

    const provider: Provider = {
      provide: FILE_PROCESSING_CREDIT_SINK,
      useValue: sink,
    };

    return {
      module: FileProcessingSinkModule,
      providers: [provider],
      exports: [provider],
      global: true,
    };
  }
}

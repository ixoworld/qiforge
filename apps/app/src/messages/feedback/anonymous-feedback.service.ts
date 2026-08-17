import {
  HttpException,
  HttpStatus,
  Inject,
  Injectable,
  Logger,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { getModelForRole } from '@ixo/oracle-runtime';
import type { ENV } from 'src/types';
import {
  createAnonymousFeedbackFingerprint,
  normalizeFeedbackText,
} from '../anonymous-feedback.utils';
import type {
  AnonymousMessageFeedbackContextDto,
  AnonymousMessageFeedbackResponse,
} from '../dto/message-feedback.dto';
import { FEEDBACK_SINK, type FeedbackSink } from './feedback-sink';

const RATE_LIMIT_WINDOW_MS = 60_000;
const RATE_LIMIT_ATTEMPTS = 3;

@Injectable()
export class AnonymousFeedbackService {
  private readonly logger = new Logger(AnonymousFeedbackService.name);
  private readonly attemptsByTracker = new Map<string, number[]>();

  constructor(
    private readonly config: ConfigService<ENV>,
    @Inject(FEEDBACK_SINK) private readonly sink: FeedbackSink,
  ) {}

  isEnabled(): boolean {
    return Boolean(
      this.sink.isConfigured() && this.config.get('FEEDBACK_HMAC_SECRET'),
    );
  }

  async submit(params: {
    did: string;
    clientIp?: string;
    sessionId: string;
    messageId: string;
    submissionId: string;
    feedback: string;
    context: AnonymousMessageFeedbackContextDto;
  }): Promise<AnonymousMessageFeedbackResponse> {
    if (!this.isEnabled()) {
      throw new ServiceUnavailableException(
        'Anonymous feedback is not configured for this Agent',
      );
    }

    const secret = this.config.getOrThrow('FEEDBACK_HMAC_SECRET');
    const did = params.did.trim();
    this.assertWithinRateLimit(secret, did, params.clientIp);
    const feedback = normalizeFeedbackText(params.feedback);
    const submittedAt = new Date().toISOString();

    try {
      await this.sink.submit({
        submissionId: params.submissionId,
        feedback,
        submittedAt,
        userPseudonym: createAnonymousFeedbackFingerprint(secret, 'user', did),
        sessionFingerprint: createAnonymousFeedbackFingerprint(
          secret,
          'session',
          did,
          params.sessionId,
        ),
        messageFingerprint: createAnonymousFeedbackFingerprint(
          secret,
          'message',
          did,
          params.sessionId,
          params.messageId,
        ),
        agent: {
          did: this.config.getOrThrow('ORACLE_ENTITY_DID'),
          name: this.config.getOrThrow('ORACLE_NAME'),
          model: getModelForRole('main'),
          provider: this.config.get('LLM_PROVIDER', 'openrouter'),
          runtimeBuildVersion: this.config.get(
            'QIFORGE_BUILD_VERSION',
            'unknown',
          ),
        },
        context: params.context,
      });
    } catch (error) {
      this.logger.warn(
        `Anonymous feedback delivery failed: ${error instanceof Error ? error.name : 'unknown error'}`,
      );
      throw new ServiceUnavailableException(
        'Anonymous feedback could not be submitted',
      );
    }

    return {
      submissionId: params.submissionId,
      status: 'submitted',
      submittedAt,
    };
  }

  private assertWithinRateLimit(
    secret: string,
    did: string,
    clientIp?: string,
  ): void {
    const cutoff = Date.now() - RATE_LIMIT_WINDOW_MS;
    const trackers = [
      createAnonymousFeedbackFingerprint(secret, 'rate-limit', 'did', did),
      createAnonymousFeedbackFingerprint(
        secret,
        'rate-limit',
        'ip',
        clientIp ?? 'unknown',
      ),
    ];
    const activeAttempts = trackers.map((tracker) => ({
      tracker,
      attempts: (this.attemptsByTracker.get(tracker) ?? []).filter(
        (timestamp) => timestamp > cutoff,
      ),
    }));

    if (
      activeAttempts.some(
        ({ attempts }) => attempts.length >= RATE_LIMIT_ATTEMPTS,
      )
    ) {
      throw new HttpException(
        'Too many feedback attempts. Please try again later.',
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }

    const attemptedAt = Date.now();
    activeAttempts.forEach(({ tracker, attempts }) => {
      attempts.push(attemptedAt);
      this.attemptsByTracker.set(tracker, attempts);
    });
  }
}

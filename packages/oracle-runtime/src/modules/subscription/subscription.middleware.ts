import {
  getUserSubscription,
  getSubscriptionUrlByNetwork,
  type GetMySubscriptionsResponseDto,
} from '@ixo/common';
import { Cache, CACHE_MANAGER } from '@nestjs/cache-manager';
import {
  HttpException,
  HttpStatus,
  Inject,
  Injectable,
  Logger,
  Optional,
  type NestMiddleware,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { minutes } from '@nestjs/throttler';
import { type NextFunction, type Request, type Response } from 'express';

/**
 * Optional UCAN service port. Mirrors the subset of `UcanService` the
 * middleware actually uses. Wiring lives in `RuntimeAppModule` — defined
 * here as a port so this module stays decoupled from the UCAN module.
 */
export interface SubscriptionUcanPort {
  hasSigningKey(): boolean;
  createServiceInvocation(
    serviceUrl: string,
    userDid: string,
    capability: string,
  ): Promise<string | null | undefined>;
}

export const SUBSCRIPTION_UCAN_PORT = Symbol('SUBSCRIPTION_UCAN_PORT');

/**
 * Optional credit/token-limiter sink. Subscription syncs the per-DID
 * subscription payload + balance into Redis for the credits plugin to
 * read on the LLM hot path. The sink is provided by the credits plugin
 * when installed. When absent, the middleware still enforces the 402
 * gate purely from the API response — no Redis dependency.
 */
export interface SubscriptionCreditSink {
  setSubscriptionPayload(
    userDid: string,
    payload: GetMySubscriptionsResponseDto,
  ): Promise<void>;
  overrideUserBalance(userDid: string, balance: number): Promise<void>;
}

export const SUBSCRIPTION_CREDIT_SINK = Symbol('SUBSCRIPTION_CREDIT_SINK');

/**
 * Shape of `req.authData` we read from (set upstream by `AuthHeaderMiddleware`).
 * Declared as a local interface — declaration-merging into Express.Request is
 * owned by the auth module so this file stays compatible with whatever extra
 * fields that module exposes.
 */
interface AuthDataShape {
  did: string;
  homeServer: string;
  ucanDelegation: {
    issuer: string;
    audience: string;
    capabilities: unknown[];
    expiration?: number;
  };
}

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace -- Required for declaration merging
  namespace Express {
    interface Request {
      subscriptionData?: GetMySubscriptionsResponseDto;
    }
  }
}

const THREE_MINUTES = minutes(3);

@Injectable()
export class SubscriptionMiddleware implements NestMiddleware {
  private readonly logger = new Logger(SubscriptionMiddleware.name);

  constructor(
    private readonly configService: ConfigService,
    @Inject(CACHE_MANAGER) private cacheManager: Cache,
    @Optional()
    @Inject(SUBSCRIPTION_UCAN_PORT)
    private readonly ucanService?: SubscriptionUcanPort,
    @Optional()
    @Inject(SUBSCRIPTION_CREDIT_SINK)
    private readonly creditSink?: SubscriptionCreditSink,
  ) {}

  private checkCanContinue(
    subscription: GetMySubscriptionsResponseDto,
  ): boolean {
    const disableCredits = this.configService.get<boolean>(
      'DISABLE_CREDITS',
      false,
    );
    if (disableCredits) {
      this.logger.debug('Subscription check skipped (DISABLE_CREDITS=true)');
      return true;
    }
    if (subscription.status !== 'active' && subscription.status !== 'trial') {
      throw new HttpException(
        'User has inactive subscription, please subscribe to continue',
        HttpStatus.PAYMENT_REQUIRED,
      );
    }

    if (subscription.totalCredits <= 10) {
      throw new HttpException(
        'User has less than 10 credits, please top up to continue',
        HttpStatus.PAYMENT_REQUIRED,
      );
    }

    return true;
  }

  async use(req: Request, res: Response, next: NextFunction): Promise<void> {
    this.logger.debug(
      `SubscriptionMiddleware processing request for: ${req.originalUrl}`,
    );

    try {
      // Check if authData is available (set upstream by AuthHeaderMiddleware)
      const authData = (req as Request & { authData?: AuthDataShape })
        .authData;
      if (!authData) {
        this.logger.warn('No auth data available, skipping subscription check');
        req.subscriptionData = undefined;
        return next();
      }

      const { did, ucanDelegation } = authData;

      if (!ucanDelegation) {
        throw new HttpException(
          'Missing UCAN delegation; cannot verify subscription',
          HttpStatus.UNAUTHORIZED,
        );
      }

      const cachedSubscription =
        await this.cacheManager.get<GetMySubscriptionsResponseDto>(
          `subscription_${did}`,
        );

      if (cachedSubscription) {
        this.logger.debug(`Subscription found in cache for user: ${did}`);
        req.subscriptionData = cachedSubscription;
        this.checkCanContinue(cachedSubscription);
        // Credit sink was already synced on the original cache miss; the
        // subscription cache TTL is the source of truth for "this user's
        // Redis state is fresh enough." Re-syncing on every cached request
        // adds two Redis writes for no gain.
        next();
        return;
      }

      const network: 'mainnet' | 'testnet' | 'devnet' =
        this.configService.get<'mainnet' | 'testnet' | 'devnet'>('NETWORK') ??
        'devnet';

      const subscriptionUrl =
        this.configService.get<string>('SUBSCRIPTION_URL') ??
        getSubscriptionUrlByNetwork(network);

      if (!this.ucanService?.hasSigningKey()) {
        throw new HttpException(
          'UCAN signing key not configured; subscription check unavailable',
          HttpStatus.UNAUTHORIZED,
        );
      }

      const invocation = await this.ucanService.createServiceInvocation(
        subscriptionUrl,
        did,
        'ixo:subscriptions',
      );
      if (!invocation) {
        throw new HttpException(
          'Failed to mint UCAN invocation for subscription check',
          HttpStatus.UNAUTHORIZED,
        );
      }

      this.logger.debug(
        `[UCAN] Using UCAN invocation for subscription check: ${did}`,
      );
      const subscription = await getUserSubscription({
        bearerToken: invocation,
        network,
        subscriptionUrl,
        authType: 'ucan',
      });

      if (!subscription) {
        this.logger.warn(
          `No subscription found for user: ${did}. This could mean: 1) API returned non-OK status, 2) API returned null/undefined data, 3) API call failed with error`,
        );
        req.subscriptionData = undefined;

        throw new HttpException(
          'No subscription found, please subscribe to continue',
          HttpStatus.PAYMENT_REQUIRED,
        );
      }

      req.subscriptionData = subscription;

      this.logger.debug(
        `Subscription validated for user: ${did}, status: ${subscription.status}`,
      );

      this.checkCanContinue(subscription);
      await this.syncCreditSink(did, subscription);
      await this.cacheManager.set(
        `subscription_${did}`,
        subscription,
        THREE_MINUTES,
      );
      next();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const errorStack = error instanceof Error ? error.stack : undefined;

      // Re-throw HttpExceptions (the 402 gates) unchanged so the original
      // status + message reach the client.
      if (error instanceof HttpException) {
        this.logger.error(
          `Subscription validation failed: ${message}`,
          errorStack,
        );
        throw error;
      }

      this.logger.error(`Subscription check failed: ${message}`, errorStack);
      req.subscriptionData = undefined;

      throw new HttpException(
        'Subscription validation failed',
        HttpStatus.PAYMENT_REQUIRED,
      );
    }
  }

  private async syncCreditSink(
    userDid: string,
    subscription: GetMySubscriptionsResponseDto,
  ): Promise<void> {
    if (!this.creditSink) {
      return;
    }
    await this.creditSink.setSubscriptionPayload(userDid, subscription);
    await this.creditSink.overrideUserBalance(
      userDid,
      subscription.totalCredits,
    );
  }
}

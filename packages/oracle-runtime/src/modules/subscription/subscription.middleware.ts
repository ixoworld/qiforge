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
import { ByoLlmService } from '../byo-llm/byo-llm.service.js';
import { UcanService } from '../ucan/ucan.service.js';

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
  overrideUserBalance(userDid: string, balance: number): Promise<string>;
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
    // UCAN is core runtime (global `UcanModule` exports `UcanService`).
    // Direct DI — no port indirection.
    private readonly ucanService: UcanService,
    // Credit sink IS plugin-supplied (credits plugin's getNestModules) so
    // it stays as an optional port. Absent → middleware enforces the 402
    // gate purely from the subscription API, no Redis mirror.
    @Optional()
    @Inject(SUBSCRIPTION_CREDIT_SINK)
    private readonly creditSink?: SubscriptionCreditSink,
    // Optional so unit tests (and forks without the global module) construct
    // fine; the runtime app always provides it via the global ByoLlmModule.
    @Optional()
    private readonly byoLlm?: ByoLlmService,
  ) {}

  private async checkCanContinue(
    subscription: GetMySubscriptionsResponseDto,
    did: string,
  ): Promise<boolean> {
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
      // A user on their own credential pays their provider directly — the
      // low-credit floor would lock them out before their key is ever used.
      // The subscription-active check above still applies to them. Rides the
      // 60s credential cache and only runs when the floor would fail, so the
      // common path pays nothing; no-ops to false when BYO_LLM_ENABLED is off.
      if (this.byoLlm && (await this.byoLlm.hasCredentials(did))) {
        this.logger.debug(
          `Credit floor bypassed for ${did} (BYO credential connected)`,
        );
        return true;
      }
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

    // The BYO connect surface must stay reachable for users with no credit
    // balance — connecting their own credential is exactly how such a user
    // becomes able to chat again. `AuthHeaderMiddleware` still runs on these
    // routes, and they never trigger platform-paid inference. `req.path` is
    // preferred (no query string); `originalUrl` covers callers that only
    // populate the raw URL.
    const requestPath = (req.path ?? req.originalUrl ?? '').split('?')[0] ?? '';
    if (requestPath.startsWith('/byo-llm')) {
      next();
      return;
    }

    if (!this.creditSink) {
      this.logger.warn(
        'No SubscriptionCreditSink configured; credits plugin is not active. Enforcing 402 policy directly based on subscription API only.',
      );
    }

    try {
      // Check if authData is available (set upstream by AuthHeaderMiddleware)
      const authData = (req as Request & { authData?: AuthDataShape }).authData;
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
        await this.checkCanContinue(cachedSubscription, did);
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

      if (!this.ucanService.hasSigningKey()) {
        throw new HttpException(
          'UCAN signing key not configured; subscription check unavailable',
          HttpStatus.UNAUTHORIZED,
        );
      }

      // `subscriptions/read` — the exact ability the user's delegation grants.
      // Claiming `'*'` here would be unsatisfiable: ucanto only resolves a
      // `'*'` claim against a `'*'` grant, so the read-scoped delegation the
      // portal issues would be reported as an unknown capability.
      const invocation = await this.ucanService.createServiceInvocation(
        subscriptionUrl,
        did,
        'ixo:subscriptions',
        { can: 'subscriptions/read' },
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

      await this.checkCanContinue(subscription, did);
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

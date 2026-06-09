import { Cache, CACHE_MANAGER } from '@nestjs/cache-manager';
import {
  HttpException,
  HttpStatus,
  Inject,
  Injectable,
  Logger,
  type NestMiddleware,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { minutes } from '@nestjs/throttler';
import { type NextFunction, type Request, type Response } from 'express';
import * as crypto from 'node:crypto';
import { UcanService } from '../ucan/ucan.service.js';
import { validateUcanDelegation } from './validate-ucan-delegation.js';
import {
  DEFAULT_UCAN_AUTH_MAX_TTL_SECONDS,
  validateUcanInvocation,
} from './validate-ucan-invocation.js';

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace -- Required for declaration merging
  namespace Express {
    interface Request {
      authData: {
        did: string;
        ucanDelegation: {
          /**
           * Raw base64-encoded delegation header as sent by the client.
           * Plugin code reads this from `runCtx.user.ucanDelegation.raw`
           * to mint downstream service invocations. Empty string when the
           * request authenticated via an invocation but carried no (or an
           * unbound) delegation — plugins branch on `raw.length === 0`.
           */
          raw: string;
          issuer: string;
          audience: string;
          capabilities: unknown[];
          expiration?: number;
        };
      };
    }
  }
}

const THREE_MINUTES = minutes(3);

interface CachedDelegationAuth {
  userDid: string;
  delegation: {
    issuer: string;
    audience: string;
    capabilities: unknown[];
    expiration?: number;
  };
}

interface CachedInvocationAuth {
  userDid: string;
  expiration: number;
}

/**
 * Authenticates every request. Primary auth is a user-signed UCAN *invocation*
 * (JWT-style bearer, `Authorization: Bearer <inv>` + `X-Auth-Type: ucan`); a
 * bare `x-ucan-delegation` is accepted only as a migration fallback. The
 * delegation, when present, is cached for downstream service invocations — but
 * only when it was issued by the authenticated user (delegations are public, so
 * we never act on someone else's just because a client presented it).
 */
@Injectable()
export class AuthHeaderMiddleware implements NestMiddleware {
  private readonly logger = new Logger(AuthHeaderMiddleware.name);

  constructor(
    @Inject(CACHE_MANAGER) private cacheManager: Cache,
    private readonly configService: ConfigService,
    private readonly ucanService: UcanService,
  ) {}

  private hashToken(token: string): string {
    return crypto.createHash('sha256').update(token, 'utf8').digest('hex');
  }

  /** Pull the bearer invocation out of the request, if present and well-formed. */
  private extractInvocation(req: Request): string | undefined {
    if (req.headers['x-auth-type'] !== 'ucan') return undefined;
    const auth = req.headers['authorization'];
    if (typeof auth !== 'string' || !auth.startsWith('Bearer ')) return undefined;
    const token = auth.slice('Bearer '.length).trim();
    return token.length > 0 ? token : undefined;
  }

  /**
   * Validate a user auth invocation. Caches the result by token hash with TTL =
   * the invocation's own expiry, so the same token (reused by the client until
   * it expires, JWT-style) doesn't re-hit Blocksync on every request.
   */
  private async validateInvocation(
    invocation: string,
  ): Promise<CachedInvocationAuth | null> {
    const oracleDid = this.configService.get<string>('ORACLE_DID');
    if (!oracleDid) {
      this.logger.warn(
        '[UCAN] ORACLE_DID not configured, cannot validate invocation',
      );
      return null;
    }

    const cacheKey = `ucan_inv_${this.hashToken(invocation)}`;
    const cached = await this.cacheManager.get<CachedInvocationAuth>(cacheKey);
    if (cached && cached.expiration * 1000 > Date.now()) {
      return cached;
    }

    const blocksyncUri = this.configService.getOrThrow<string>(
      'BLOCKSYNC_GRAPHQL_URL',
    );
    const maxTtlSeconds =
      Number(this.configService.get('UCAN_AUTH_MAX_TTL_SECONDS')) ||
      DEFAULT_UCAN_AUTH_MAX_TTL_SECONDS;

    const outcome = await validateUcanInvocation(invocation, {
      oracleDid,
      blocksyncUri,
      maxTtlSeconds,
    });
    if (!outcome.ok) {
      this.logger.warn(`[UCAN] Invocation validation failed: ${outcome.error}`);
      return null;
    }

    const result: CachedInvocationAuth = {
      userDid: outcome.result.userDid,
      expiration: outcome.result.expiration,
    };
    // TTL = the token's own remaining lifetime, so we never serve a cached
    // result past the point the token itself would have expired.
    const ttl = result.expiration * 1000 - Date.now();
    if (ttl > 0) {
      await this.cacheManager.set(cacheKey, result, ttl);
    }
    this.logger.debug(`[UCAN] Invocation auth for DID: ${result.userDid}`);
    return result;
  }

  /**
   * Validate a delegation header (cached by hash). Returns the validated
   * invoker + delegation metadata, or null on failure.
   */
  private async validateDelegation(
    ucanHeader: string,
  ): Promise<CachedDelegationAuth | null> {
    const oracleDid = this.configService.get<string>('ORACLE_DID');
    if (!oracleDid) {
      this.logger.warn(
        '[UCAN] ORACLE_DID not configured, skipping delegation validation',
      );
      return null;
    }

    const cacheKey = `ucan_auth_${this.hashToken(ucanHeader)}`;
    const cached = await this.cacheManager.get<CachedDelegationAuth>(cacheKey);
    if (cached) return cached;

    const blocksyncUri = this.configService.getOrThrow<string>(
      'BLOCKSYNC_GRAPHQL_URL',
    );

    const outcome = await validateUcanDelegation(ucanHeader, {
      oracleDid,
      blocksyncUri,
    });
    if (!outcome.ok) {
      this.logger.warn(`[UCAN] Delegation validation failed: ${outcome.error}`);
      return null;
    }

    const result: CachedDelegationAuth = outcome.result;
    const ttl = result.delegation.expiration
      ? Math.max(0, result.delegation.expiration * 1000 - Date.now())
      : THREE_MINUTES;
    await this.cacheManager.set(cacheKey, result, ttl);
    return result;
  }

  async use(req: Request, _res: Response, next: NextFunction): Promise<void> {
    this.logger.debug(
      `AuthHeaderMiddleware processing request for: ${req.originalUrl}`,
    );
    try {
      const invocation = this.extractInvocation(req);
      const delegationHeader = req.headers['x-ucan-delegation'] as
        | string
        | undefined;

      // Validate the delegation once (if sent). Reused below for downstream
      // authorization and, for pre-invocation clients, as the auth fallback.
      const delegationResult = delegationHeader
        ? await this.validateDelegation(delegationHeader)
        : null;

      // Authenticated identity: a user-signed invocation is the primary auth.
      // A bare delegation is accepted only as a migration fallback.
      let authedDid: string | null = null;
      if (invocation) {
        const inv = await this.validateInvocation(invocation);
        if (!inv) {
          throw new HttpException(
            'Invalid UCAN invocation',
            HttpStatus.UNAUTHORIZED,
          );
        }
        authedDid = inv.userDid;
      } else if (delegationResult) {
        authedDid = delegationResult.userDid;
        this.logger.debug(
          '[UCAN] Authenticated via delegation fallback (no invocation)',
        );
      }

      if (!authedDid) {
        throw new HttpException(
          'Missing UCAN authentication: provide Authorization: Bearer <invocation> with X-Auth-Type: ucan, or an x-ucan-delegation header',
          HttpStatus.UNAUTHORIZED,
        );
      }

      // Downstream authorization: a delegation is public/shareable, so only
      // trust it when it was issued BY the authenticated user. Otherwise a
      // client could pair their own invocation with someone else's delegation
      // and make the oracle act on that person's behalf downstream.
      if (delegationResult && delegationResult.userDid === authedDid) {
        req.authData = {
          did: authedDid,
          ucanDelegation: {
            ...delegationResult.delegation,
            raw: delegationHeader as string,
          },
        };
        await this.ucanService.cacheDelegation(
          authedDid,
          delegationHeader as string,
          delegationResult.delegation.expiration,
        );
      } else {
        if (delegationResult && delegationResult.userDid !== authedDid) {
          this.logger.warn(
            `[UCAN] Ignoring delegation for downstream: issuer ${delegationResult.userDid} != authenticated ${authedDid}`,
          );
        }
        req.authData = {
          did: authedDid,
          ucanDelegation: { raw: '', issuer: '', audience: '', capabilities: [] },
        };
      }

      next();
    } catch (error) {
      if (error instanceof HttpException) {
        next(error);
      } else {
        const message = error instanceof Error ? error.message : String(error);
        const errorStack = error instanceof Error ? error.stack : undefined;
        this.logger.error(
          `Auth header validation failed: ${message}`,
          errorStack,
        );
        next(new HttpException(message, HttpStatus.UNAUTHORIZED));
      }
    }
  }
}

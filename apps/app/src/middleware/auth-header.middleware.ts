import { verifyMatrixOpenIdToken } from '@ixo/common';
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
import { ENV } from 'src/config';
import { UcanService } from 'src/ucan/ucan.service';
import { getAuthHeaders, normalizeDid } from '../utils/header.utils';

/** Cache key for the encrypted user openId token, keyed by DID. */
export const OPENID_CACHE_PREFIX = 'openid:';

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace -- Required for declaration merging
  namespace Express {
    interface Request {
      authData: {
        did: string;
        userOpenIdToken: string;
        homeServer: string;
        ucanDelegation?: {
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

interface CachedUser {
  did: string;
  homeServer: string;
}

interface CachedUcanAuth {
  userDid: string;
  homeServer: string;
  delegation: {
    issuer: string;
    audience: string;
    capabilities: unknown[];
    expiration?: number;
  };
}

@Injectable()
export class AuthHeaderMiddleware implements NestMiddleware {
  private readonly logger = new Logger(AuthHeaderMiddleware.name);

  constructor(
    @Inject(CACHE_MANAGER) private cacheManager: Cache,
    private readonly configService: ConfigService<ENV>,
    private readonly ucanService: UcanService,
  ) {}

  private resolveHomeServer(matrixHomeServer?: string): string {
    this.logger.debug(
      `[resolveHomeServer]: matrixHomeServer: ${matrixHomeServer} -> ${this.configService.getOrThrow('MATRIX_BASE_URL')}`,
    );
    if (matrixHomeServer?.trim()) {
      const url = matrixHomeServer.startsWith('http')
        ? matrixHomeServer
        : `https://${matrixHomeServer}`;
      return url;
    }

    return this.configService.getOrThrow('MATRIX_BASE_URL');
  }

  private cropHomeServer(url: string): string {
    return url.replace(/^https?:\/\//, '').split('/')[0];
  }

  private async validateToken(
    matrixToken: string,
    matrixHomeServer?: string,
  ): Promise<{
    isValid: boolean;
    userDid: string;
    homeServer: string;
  }> {
    try {
      const isOpenIdToken = !matrixToken.startsWith('syt_');
      if (!isOpenIdToken) {
        throw new HttpException(
          'Invalid token Please use a user open id token',
          HttpStatus.UNAUTHORIZED,
        );
      }

      const homeServerUrl = this.resolveHomeServer(matrixHomeServer);
      this.logger.debug(`Validating OpenID token against ${homeServerUrl}`);

      const { isValid, userId } = await verifyMatrixOpenIdToken(
        matrixToken,
        homeServerUrl,
      );
      if (!userId) {
        return { isValid: false, userDid: '', homeServer: '' };
      }
      return {
        isValid,
        userDid: normalizeDid(userId),
        homeServer: this.cropHomeServer(homeServerUrl),
      };
    } catch (error) {
      const errorMessage =
        error instanceof Error ? error.message : String(error);
      const errorStack = error instanceof Error ? error.stack : undefined;
      this.logger.error(`Error validating token: ${errorMessage}`, errorStack);
      return { isValid: false, userDid: '', homeServer: '' };
    }
  }

  private hashToken(token: string): string {
    return crypto.createHash('sha256').update(token, 'utf8').digest('hex');
  }

  private async validateUcanDelegation(ucanHeader: string): Promise<{
    userDid: string;
    delegation: {
      issuer: string;
      audience: string;
      capabilities: unknown[];
      expiration?: number;
    };
  } | null> {
    const oracleDid = this.configService.get('ORACLE_DID');
    if (!oracleDid) {
      this.logger.warn(
        '[UCAN] ORACLE_DID not configured, skipping delegation validation',
      );
      return null;
    }

    const { createUCANValidator, createIxoDIDResolver } =
      await import('@ixo/ucan');
    const blocksyncUri = this.configService.get('BLOCKSYNC_GRAPHQL_URL');

    const validator = await createUCANValidator({
      serverDid: oracleDid,
      rootIssuers: [],
      didResolver: createIxoDIDResolver({
        indexerUrl: blocksyncUri,
      }),
    });

    const result = await validator.validateDelegation(ucanHeader);

    if (!result.ok) {
      this.logger.warn(
        `[UCAN] Delegation validation failed: [${result.error?.code}] ${result.error?.message}`,
      );
      return null;
    }

    this.logger.log(
      `[UCAN] Delegation validated: iss=${result.invoker} aud=${oracleDid} exp=${result.expiration ? new Date(result.expiration * 1000).toISOString() : 'none'}`,
    );

    return {
      userDid: result.invoker!,
      delegation: {
        issuer: result.invoker!,
        audience: oracleDid,
        capabilities: result.capability ? [result.capability] : [],
        expiration: result.expiration,
      },
    };
  }

  async use(req: Request, _res: Response, next: NextFunction): Promise<void> {
    this.logger.debug(
      `AuthHeaderMiddleware processing request for: ${req.originalUrl}`,
    );
    try {
      // 1. Try UCAN delegation first
      const ucanHeader = req.headers['x-ucan-delegation'] as string | undefined;
      if (ucanHeader) {
        try {
          const ucanHash = this.hashToken(ucanHeader);
          const cachedUcan = await this.cacheManager.get<CachedUcanAuth>(
            `ucan_auth_${ucanHash}`,
          );

          if (cachedUcan) {
            req.authData = {
              did: cachedUcan.userDid,
              userOpenIdToken: '',
              homeServer: '',
              ucanDelegation: cachedUcan.delegation,
            };

            // Re-cache raw delegation for downstream invocations
            await this.ucanService.cacheDelegation(
              cachedUcan.userDid,
              ucanHeader,
              cachedUcan.delegation.expiration,
            );

            this.logger.debug(
              `[UCAN] Auth from cache for DID: ${cachedUcan.userDid}`,
            );
            next();
            return;
          }

          const ucanResult = await this.validateUcanDelegation(ucanHeader);
          if (ucanResult) {
            req.authData = {
              did: ucanResult.userDid,
              userOpenIdToken: '',
              homeServer: '',
              ucanDelegation: ucanResult.delegation,
            };

            // Cache auth result
            const ttl = ucanResult.delegation.expiration
              ? Math.max(
                  0,
                  ucanResult.delegation.expiration * 1000 - Date.now(),
                )
              : THREE_MINUTES;
            await this.cacheManager.set(
              `ucan_auth_${ucanHash}`,
              {
                userDid: ucanResult.userDid,
                homeServer: '',
                delegation: ucanResult.delegation,
              } satisfies CachedUcanAuth,
              ttl,
            );

            // Cache raw delegation for downstream service invocations
            await this.ucanService.cacheDelegation(
              ucanResult.userDid,
              ucanHeader,
              ucanResult.delegation.expiration,
            );

            this.logger.debug(
              `[UCAN] Auth completed for DID: ${ucanResult.userDid}`,
            );
            next();
            return;
          }
        } catch (err) {
          this.logger.warn(
            `[UCAN] Failed to validate delegation: ${err instanceof Error ? err.message : String(err)}`,
          );
        }
      }

      // 2. Fall back to Matrix OpenID token
      const { matrixAccessToken, matrixHomeServer } = await getAuthHeaders(
        req.headers,
      );

      const tokenHash = this.hashToken(matrixAccessToken);
      const cachedUser = await this.cacheManager.get<CachedUser>(
        `user_${tokenHash}`,
      );

      if (cachedUser?.did) {
        req.authData = {
          did: cachedUser.did,
          userOpenIdToken: matrixAccessToken,
          homeServer: cachedUser.homeServer,
        };
        this.logger.debug(
          `[OpenID] Auth from cache for DID: ${cachedUser.did}`,
        );
        next();
        return;
      }

      const { isValid, userDid, homeServer } = await this.validateToken(
        matrixAccessToken,
        matrixHomeServer,
      );
      if (!isValid) {
        throw new HttpException('Invalid token', HttpStatus.UNAUTHORIZED);
      }

      req.authData = {
        did: userDid,
        userOpenIdToken: matrixAccessToken,
        homeServer,
      };
      await this.cacheManager.set(
        `user_${tokenHash}`,
        { did: userDid, homeServer } satisfies CachedUser,
        THREE_MINUTES,
      );
      this.logger.debug(`[OpenID] Auth completed for DID: ${userDid}`);

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
        next(new HttpException(message, 401));
      }
    }
  }
}

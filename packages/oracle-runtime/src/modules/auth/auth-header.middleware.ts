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

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace -- Required for declaration merging
  namespace Express {
    interface Request {
      authData: {
        did: string;
        ucanDelegation: {
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

interface CachedUcanAuth {
  userDid: string;
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
    private readonly configService: ConfigService,
    private readonly ucanService: UcanService,
  ) {}

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
    const oracleDid = this.configService.get<string>('ORACLE_DID');
    if (!oracleDid) {
      this.logger.warn(
        '[UCAN] ORACLE_DID not configured, skipping delegation validation',
      );
      return null;
    }

    const { createUCANValidator, createIxoDIDResolver } = await import(
      '@ixo/ucan'
    );
    const blocksyncUri = this.configService.getOrThrow<string>(
      'BLOCKSYNC_GRAPHQL_URL',
    );

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
      const ucanHeader = req.headers['x-ucan-delegation'] as string | undefined;
      if (!ucanHeader) {
        throw new HttpException(
          'Missing x-ucan-delegation header',
          HttpStatus.UNAUTHORIZED,
        );
      }

      const ucanHash = this.hashToken(ucanHeader);
      const cachedUcan = await this.cacheManager.get<CachedUcanAuth>(
        `ucan_auth_${ucanHash}`,
      );

      if (cachedUcan) {
        req.authData = {
          did: cachedUcan.userDid,
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
      if (!ucanResult) {
        throw new HttpException(
          'Invalid UCAN delegation',
          HttpStatus.UNAUTHORIZED,
        );
      }

      req.authData = {
        did: ucanResult.userDid,
        ucanDelegation: ucanResult.delegation,
      };

      // Cache auth result
      const ttl = ucanResult.delegation.expiration
        ? Math.max(0, ucanResult.delegation.expiration * 1000 - Date.now())
        : THREE_MINUTES;
      await this.cacheManager.set(
        `ucan_auth_${ucanHash}`,
        {
          userDid: ucanResult.userDid,
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

      this.logger.debug(`[UCAN] Auth completed for DID: ${ucanResult.userDid}`);
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

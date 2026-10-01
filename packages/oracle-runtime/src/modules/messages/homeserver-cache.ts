import { getMatrixHomeServerCroppedForDid } from '@ixo/oracles-chain-client';
import { Injectable } from '@nestjs/common';
import { sweepExpired } from '../../utils/expiring-map.js';

const TTL_MS = 60 * 60 * 1000;

interface CacheEntry {
  homeServer: string;
  expiresAt: number;
}

/**
 * Per-DID Matrix home-server cache. `getMatrixHomeServerCroppedForDid` does a
 * chain-side lookup; the result is stable per user for the lifetime of their
 * Matrix account, so a 1h TTL is conservative. Saves 50-200ms per request
 * after the first warm-up.
 */
@Injectable()
export class HomeServerCache {
  private readonly cache = new Map<string, CacheEntry>();

  async get(userDid: string): Promise<string> {
    const cached = this.cache.get(userDid);
    if (cached && cached.expiresAt > Date.now()) {
      return cached.homeServer;
    }
    const homeServer = await getMatrixHomeServerCroppedForDid(userDid);
    sweepExpired(this.cache);
    this.cache.set(userDid, { homeServer, expiresAt: Date.now() + TTL_MS });
    return homeServer;
  }
}

import { Cache, CACHE_MANAGER } from '@nestjs/cache-manager';
import { Inject, Injectable, Logger } from '@nestjs/common';
import { randomBytes } from 'node:crypto';

/**
 * BlobStore — short-TTL keyed value store for content that the LLM should
 * never have to relay verbatim.
 *
 * Use case: tools that produce long, opaque, error-prone strings (UCAN
 * invocation/delegation CARs, JWTs, signed envelopes, etc.). The producing
 * tool stores the value here and returns a short hex blobId. A consuming
 * tool (e.g. `sandbox_write_blob`) takes the blobId, looks the value up
 * server-side, and forwards it to its destination — the value never enters
 * the LLM's context.
 *
 * Backed by `@nestjs/cache-manager`'s global Cache (in-memory by default;
 * swap to Redis by changing the CacheModule factory if/when needed).
 *
 * Ownership: blobs are namespaced by issuing user DID. A blob produced for
 * user A cannot be retrieved with user B's DID — the lookup just misses,
 * same as it would for a non-existent ID.
 */
@Injectable()
export class BlobStoreService {
  private readonly logger = new Logger(BlobStoreService.name);

  /** Default TTL when none specified. 1 hour is a sensible cap for anything
   * routed through here — most callers will pass a tighter value (e.g. an
   * invocation's own expiration, ~60s). */
  static readonly DEFAULT_TTL_SECONDS = 60 * 60;

  /** Hard ceiling enforced regardless of caller request. Protects the cache
   * from being held hostage by a buggy producer. */
  static readonly MAX_TTL_SECONDS = 24 * 60 * 60;

  /** Hex-character ID, prefixed so callers can validate format before
   * paying for a cache lookup. 16 hex chars = 64 bits of entropy — enough
   * to be unguessable for short-lived blobs. */
  static readonly ID_PREFIX = 'blob_';
  static readonly ID_PATTERN = /^blob_[0-9a-f]{16}$/;

  constructor(@Inject(CACHE_MANAGER) private readonly cacheManager: Cache) {}

  private cacheKey(userDid: string, blobId: string): string {
    return `blob:${userDid}:${blobId}`;
  }

  /**
   * Validate that a string is a well-formed blob ID. Use this in tool
   * input schemas / handlers to reject malformed IDs early — the cache
   * lookup would miss anyway, but failing fast gives a clearer error.
   */
  isValidBlobId(value: unknown): value is string {
    return typeof value === 'string' && BlobStoreService.ID_PATTERN.test(value);
  }

  /**
   * Store a value and return a fresh blobId. The TTL is clamped to
   * `MAX_TTL_SECONDS`. Callers should pass `userDid` from a trusted source
   * (auth middleware / agent state), NOT from LLM-supplied arguments.
   */
  async put(params: {
    userDid: string;
    name: string;
    value: string;
    ttlSeconds?: number;
  }): Promise<string> {
    if (!params.userDid) {
      throw new Error('BlobStore.put: userDid is required');
    }
    if (typeof params.value !== 'string' || params.value.length === 0) {
      throw new Error('BlobStore.put: value must be a non-empty string');
    }

    const ttlSeconds = Math.min(
      Math.max(1, params.ttlSeconds ?? BlobStoreService.DEFAULT_TTL_SECONDS),
      BlobStoreService.MAX_TTL_SECONDS,
    );

    const blobId = `${BlobStoreService.ID_PREFIX}${randomBytes(8).toString('hex')}`;
    const key = this.cacheKey(params.userDid, blobId);

    await this.cacheManager.set(
      key,
      { name: params.name, value: params.value },
      ttlSeconds * 1000,
    );

    this.logger.debug(
      `[blob-store] put ${blobId} (name=${params.name}, ttl=${ttlSeconds}s, valueLen=${params.value.length}, user=${params.userDid})`,
    );

    return blobId;
  }

  /**
   * Retrieve a blob by id, scoped to the requesting user. Returns null if
   * the blob doesn't exist, has expired, or belongs to a different user.
   */
  async get(params: {
    userDid: string;
    blobId: string;
  }): Promise<{ name: string; value: string } | null> {
    if (!params.userDid) return null;
    if (!this.isValidBlobId(params.blobId)) return null;

    const key = this.cacheKey(params.userDid, params.blobId);
    const cached = await this.cacheManager.get<{ name: string; value: string }>(
      key,
    );

    if (!cached) {
      this.logger.debug(
        `[blob-store] miss ${params.blobId} (user=${params.userDid})`,
      );
      return null;
    }

    this.logger.debug(
      `[blob-store] hit ${params.blobId} (name=${cached.name}, user=${params.userDid})`,
    );
    return cached;
  }
}

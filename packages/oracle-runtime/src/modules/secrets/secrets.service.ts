import { decryptJWE, encryptJWE, type JWK } from '@ixo/oracles-chain-client';
import { MatrixManager } from '@ixo/matrix';
import { Logger } from '@nestjs/common';
import type { Cache } from 'cache-manager';

/**
 * The key id recorded on secret-index entries written by this runtime. Matches
 * the id under which the oracle's P-256 encryption key is published
 * (`ixo.room.encryption_key.index` / `p256_encryption`), so portal-written and
 * runtime-written secrets carry the same shape.
 */
const RUNTIME_PUBLIC_KEY_ID = 'p256_encryption';

export interface SecretIndexEntry {
  name: string;
  eventId: string;
  publicKeyId: string;
}

interface CachedSecret {
  value: string;
  eventId: string;
}

const TWENTY_FOUR_HOURS = 24 * 60 * 60 * 1000;

export class SecretsService {
  private static instance: SecretsService;

  private cacheManager: Cache | null = null;

  // TODO: Key rotation — change to Map<string, JWK> keyed by publicKeyId to support multiple keys
  private encryptionKey: JWK | null = null;

  private constructor() {}

  setEncryptionKey(key: JWK): void {
    this.encryptionKey = key;
  }

  setCacheManager(cache: Cache): void {
    this.cacheManager = cache;
  }

  static getInstance(): SecretsService {
    if (!SecretsService.instance) {
      SecretsService.instance = new SecretsService();
    }
    return SecretsService.instance;
  }

  /**
   * Get the secret index from room state events.
   * Cheap operation — one API call per invocation.
   */
  async getSecretIndex(roomId: string): Promise<SecretIndexEntry[]> {
    try {
      const client = MatrixManager.getInstance().getClient();
      if (!client) {
        Logger.warn('[SecretsService] Matrix client not available');
        return [];
      }

      // Fetch all room state and filter for secret index events.
      // Matrix CS API has no endpoint to fetch all state events of a single type,
      // so getRoomState (all state) + client-side filter is the only option.
      const roomState = await client.mxClient.getRoomState(roomId);

      const index: SecretIndexEntry[] = [];
      for (const event of roomState) {
        if (event.type !== 'ixo.room.secret.index') continue;
        // Filter out deleted entries (empty content)
        if (!event.content || Object.keys(event.content).length === 0) continue;
        if (!event.content.eventId) continue;

        index.push({
          name: event.state_key,
          eventId: event.content.eventId,
          publicKeyId: event.content.publicKeyId,
        });
      }

      Logger.log(
        `[SecretsService] Found ${index.length} secret(s) in room ${roomId}: ${index.map((e) => e.name).join(', ')}`,
      );
      return index;
    } catch (error) {
      Logger.error(
        `[SecretsService] Failed to get secret index for room ${roomId}:`,
        error,
      );
      return [];
    }
  }

  private cacheKey(roomId: string, name: string): string {
    return `secret:${roomId}:${name}`;
  }

  /**
   * Load secret values from timeline events, using cache where possible.
   * Only fetches timeline events for secrets whose eventId has changed.
   * Stale entries (deleted secrets) expire naturally via the 24h TTL.
   */
  async loadSecretValues(
    roomId: string,
    index: SecretIndexEntry[],
  ): Promise<Record<string, string>> {
    const result: Record<string, string> = {};
    const toFetch: SecretIndexEntry[] = [];

    for (const entry of index) {
      const cached = await this.cacheManager?.get<CachedSecret>(
        this.cacheKey(roomId, entry.name),
      );
      if (cached && cached.eventId === entry.eventId) {
        // Cache hit — same eventId means value hasn't changed
        result[entry.name] = cached.value;
      } else {
        // Cache miss or eventId changed (secret was updated)
        toFetch.push(entry);
      }
    }

    if (toFetch.length > 0) {
      Logger.log(
        `[SecretsService] Fetching ${toFetch.length} secret value(s) for room ${roomId}`,
      );
    }

    for (const entry of toFetch) {
      try {
        const event = await MatrixManager.getInstance().getEventById(
          roomId,
          entry.eventId,
        );
        let value =
          (event as unknown as Record<string, Record<string, string>>)?.content
            ?.value ?? '';

        if (!this.encryptionKey) {
          Logger.error(
            `[SecretsService] Secret "${entry.name}" is encrypted but no encryption key loaded — skipping`,
          );
          continue;
        }
        // TODO: Key rotation — select correct key via entry.publicKeyId
        value = await decryptJWE(value, this.encryptionKey);

        Logger.log(
          `[SecretsService] Decrypted secret "${entry.name}" (${value.length} chars)`,
        );
        result[entry.name] = value;
        await this.cacheManager?.set(
          this.cacheKey(roomId, entry.name),
          { value, eventId: entry.eventId } satisfies CachedSecret,
          TWENTY_FOUR_HOURS,
        );
      } catch (error) {
        Logger.error(
          `[SecretsService] Failed to fetch/decrypt secret "${entry.name}" (event ${entry.eventId}):`,
          error,
        );
      }
    }

    return result;
  }

  /**
   * Write (or overwrite) a room secret from the runtime side, using the same
   * event shape the portal writes: the JWE value in an `ixo.room.secret`
   * timeline event, referenced by an `ixo.room.secret.index` state event keyed
   * by the secret name. Encrypts to the oracle's own published P-256 key so
   * the read path (`loadSecretValues`) decrypts it identically to a
   * portal-written secret. The cache is primed with the plaintext immediately
   * — the very next read hits it without a Matrix round-trip.
   *
   * Used by server-originated credentials (e.g. OAuth token write-back);
   * user-typed secrets keep flowing through the portal's client-side
   * encryption path and never transit this method.
   */
  async putSecret(roomId: string, name: string, value: string): Promise<void> {
    if (!this.encryptionKey) {
      throw new Error(
        `[SecretsService] Cannot write secret "${name}" — no encryption key loaded`,
      );
    }
    const manager = MatrixManager.getInstance();
    const client = manager.getClient();
    if (!client) {
      throw new Error('[SecretsService] Matrix client not available');
    }

    const previous = (await this.getSecretIndex(roomId)).find(
      (entry) => entry.name === name,
    );

    const jwe = await encryptJWE(value, this.encryptionKey);
    const eventId = await manager.sendMatrixEvent(roomId, 'ixo.room.secret', {
      value: jwe,
    });
    await client.sendStateEvent(
      roomId,
      'ixo.room.secret.index',
      { eventId, publicKeyId: RUNTIME_PUBLIC_KEY_ID },
      name,
    );

    // Same hygiene as the portal's update path: once the index points at the
    // new event, the superseded ciphertext is redacted best-effort so stale
    // encrypted values don't accumulate in the timeline.
    if (previous && previous.eventId !== eventId) {
      try {
        await client.mxClient.redactEvent(roomId, previous.eventId);
      } catch (error) {
        Logger.warn(
          `[SecretsService] Could not redact superseded secret event ${previous.eventId} in ${roomId}: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }

    await this.cacheManager?.set(
      this.cacheKey(roomId, name),
      { value, eventId } satisfies CachedSecret,
      TWENTY_FOUR_HOURS,
    );
    Logger.log(
      `[SecretsService] Wrote secret "${name}" to room ${roomId} (event ${eventId})`,
    );
  }

  /**
   * Delete a room secret: clears the index entry (empty state content is the
   * "deleted" marker `getSecretIndex` filters on), best-effort redacts the
   * timeline event carrying the value, and drops the cache entry.
   */
  async deleteSecret(roomId: string, name: string): Promise<void> {
    const manager = MatrixManager.getInstance();
    const client = manager.getClient();
    if (!client) {
      throw new Error('[SecretsService] Matrix client not available');
    }

    const index = await this.getSecretIndex(roomId);
    const entry = index.find((e) => e.name === name);

    await client.sendStateEvent(roomId, 'ixo.room.secret.index', {}, name);

    if (entry) {
      try {
        await client.mxClient.redactEvent(roomId, entry.eventId);
      } catch (error) {
        Logger.warn(
          `[SecretsService] Could not redact secret event ${entry.eventId} in ${roomId}: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }

    await this.cacheManager?.del(this.cacheKey(roomId, name));
    Logger.log(`[SecretsService] Deleted secret "${name}" from room ${roomId}`);
  }
}

import { decryptJWE, type JWK } from '@ixo/oracles-chain-client';
import { MatrixManager } from '@ixo/matrix';
import { Logger } from '@nestjs/common';
import type { Cache } from 'cache-manager';

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
}

/**
 * Adapts `WorkersSecretsService` (per-room JWE secrets over the Matrix
 * gateway) to the core's `SecretsAdapter` shape — the same mapping the Node
 * runtime's `ambient-factory` performs over its `SecretsService`:
 * `getIndex` lists names (plugins never see event ids), `getValues` decrypts
 * only the requested names. Degrades exactly like Node when the oracle has no
 * P-256 key seated: the index still lists, values come back empty.
 */
import type { SecretsAdapter } from '../core/runtime-context';
import type { SecretIndex } from '../plugin-api/types';
import type { WorkersSecretsService } from '../secrets/secrets-service';

export function createSecretsAdapter(
  service: WorkersSecretsService,
): SecretsAdapter {
  return {
    async getIndex(roomId: string): Promise<SecretIndex> {
      const entries = await service.getIndex(roomId);
      const index: Record<string, { key: string }> = {};
      for (const entry of entries) {
        index[entry.name] = { key: entry.name };
      }
      return index satisfies SecretIndex;
    },
    async getValues(
      roomId: string,
      keys: string[],
    ): Promise<Record<string, string>> {
      return service.getValues(roomId, keys);
    },
  };
}

/**
 * Adapts `WorkersSecretsService` (per-room JWE secrets over the Matrix
 * gateway) to the core's `SecretsAdapter` shape — the same mapping the Node
 * runtime's `ambient-factory` performs over its `SecretsService`:
 * `getIndex` lists names (plugins never see event ids), `getValues` decrypts
 * only the requested names. Degrades exactly like Node when the oracle has no
 * P-256 key seated: the index still lists, values come back empty.
 *
 * The runtime's own LLM credentials (BYO API keys, the ChatGPT OAuth tokens
 * with their refresh token) share the room but are not the user's tool
 * secrets: plugins neither list nor read them. The sandbox forwards every
 * secret it sees to code the model writes, where a prompt injection could
 * send it anywhere. The BYO service reads them from the service directly.
 */
import type { SecretsAdapter } from '../core/runtime-context';
import { isRuntimeOnlySecret } from '../llm/byo-catalog';
import type { SecretIndex } from '../plugin-api/types';
import type { WorkersSecretsService } from '../secrets/secrets-service';

export function createSecretsAdapter(
  service: Pick<WorkersSecretsService, 'getIndex' | 'getValues'>,
): SecretsAdapter {
  return {
    async getIndex(roomId: string): Promise<SecretIndex> {
      const entries = await service.getIndex(roomId);
      const index: Record<string, { key: string }> = {};
      for (const entry of entries) {
        if (isRuntimeOnlySecret(entry.name)) continue;
        index[entry.name] = { key: entry.name };
      }
      return index satisfies SecretIndex;
    },
    async getValues(
      roomId: string,
      keys: string[],
    ): Promise<Record<string, string>> {
      const allowed = keys.filter((key) => !isRuntimeOnlySecret(key));
      return allowed.length > 0 ? service.getValues(roomId, allowed) : {};
    },
  };
}

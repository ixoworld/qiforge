import { MatrixManager } from '@ixo/matrix';
import { getMatrixHomeServerCroppedForDid } from '@ixo/oracles-chain-client';
import { SecretsService } from '../../../modules/secrets/index.js';
import type { CodexSecretReader } from '../auth/credentials.js';
import type { CodexTenantScope } from '../domain/provider.js';

/**
 * Reads per-room encrypted secrets outside a graph run.
 *
 * The tool path gets `ctx.secrets` from the RuntimeContext; the HTTP control
 * plane has no graph run, so it resolves the user↔oracle room the same way the
 * runtime does and reads through the same `SecretsService`. Values are handed
 * straight to the App Server process env and never returned to the caller.
 */
export function createRoomSecretReader(
  scope: CodexTenantScope,
): CodexSecretReader {
  return {
    async getValues(keys: string[]): Promise<Record<string, string>> {
      const userHomeServer = await getMatrixHomeServerCroppedForDid(
        scope.userDid,
      );
      const { roomId } =
        await MatrixManager.getInstance().getOracleRoomIdWithHomeServer({
          userDid: scope.userDid,
          oracleEntityDid: scope.oracleEntityDid,
          userHomeServer,
        });
      if (!roomId) return {};

      const service = SecretsService.getInstance();
      const requested = new Set(keys);
      const index = await service.getSecretIndex(roomId);
      const matching = index.filter((entry) => requested.has(entry.name));
      if (matching.length === 0) return {};
      return service.loadSecretValues(roomId, matching);
    },
  };
}

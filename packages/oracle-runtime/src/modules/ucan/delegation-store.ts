import { MatrixError, MatrixManager } from '@ixo/matrix';
import { Injectable, Logger } from '@nestjs/common';
import { z } from 'zod';

export const UCAN_DELEGATION_STATE_KEY = 'ucan_delegation';

/**
 * Persisted shape of a user→oracle UCAN delegation stored in the user's
 * Matrix room state. The delegation is authorization-only and safe to expose
 * (useless without the oracle's signing key or the user's invocation
 * signature), so it is stored in PLAINTEXT room state — same path as
 * `UserPreferencesService`, NOT the PIN-AES secret path.
 */
export const StoredDelegationSchema = z.object({
  raw: z.string(),
  issuer: z.string().optional(),
  audience: z.string().optional(),
  expiration: z.number().optional(),
  updatedAt: z.string(),
});
export type StoredDelegation = z.infer<typeof StoredDelegationSchema>;

/**
 * Stores a per-room user→oracle UCAN delegation in Matrix room state.
 *
 * Mirrors `UserPreferencesService`: same `MatrixManager.getInstance()
 * .stateManager` read/write, same Zod validation, same plaintext storage.
 * The event type is `ixo.room.state` and the payload is auto-deflated by the
 * state manager — identical to preferences.
 *
 * Injectable so consumers (`UcanService`) get it via Nest DI; unit-testable by
 * stubbing `MatrixManager.getInstance().stateManager`.
 */
@Injectable()
export class DelegationStore {
  private readonly logger = new Logger(DelegationStore.name);

  /**
   * Read the stored delegation for a room. Returns null when none has been
   * stored (`M_NOT_FOUND`), when the payload fails validation, or on any
   * other read error — a missing delegation must never break a turn.
   */
  async read(roomId: string): Promise<StoredDelegation | null> {
    let raw: unknown;
    try {
      const stateManager = MatrixManager.getInstance().stateManager;
      raw = await stateManager.getState<unknown>(
        roomId,
        UCAN_DELEGATION_STATE_KEY,
      );
    } catch (error) {
      if (error instanceof MatrixError && error.errcode === 'M_NOT_FOUND') {
        return null;
      }
      this.logger.warn(
        `[DelegationStore] Failed to load delegation for room ${roomId}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
      return null;
    }

    const parsed = StoredDelegationSchema.safeParse(raw);
    if (!parsed.success) {
      this.logger.warn(
        `[DelegationStore] Invalid delegation payload for room ${roomId}: ${parsed.error.message}`,
      );
      return null;
    }

    return parsed.data;
  }

  /**
   * Persist a delegation to room state. `updatedAt` is always set by this
   * method; any caller-supplied `updatedAt` is overwritten.
   */
  async write(
    roomId: string,
    data: Omit<StoredDelegation, 'updatedAt'>,
  ): Promise<void> {
    const payload = StoredDelegationSchema.parse({
      ...data,
      updatedAt: new Date().toISOString(),
    });

    const stateManager = MatrixManager.getInstance().stateManager;
    await stateManager.setState<StoredDelegation>({
      roomId,
      stateKey: UCAN_DELEGATION_STATE_KEY,
      data: payload,
    });
  }

  /**
   * Revoke the stored delegation. Matrix state events can't be truly deleted,
   * so we overwrite with empty content — a subsequent `read` then fails schema
   * validation and returns null, i.e. "no delegation stored".
   */
  async delete(roomId: string): Promise<void> {
    const stateManager = MatrixManager.getInstance().stateManager;
    await stateManager.setState<Record<string, never>>({
      roomId,
      stateKey: UCAN_DELEGATION_STATE_KEY,
      data: {},
    });
  }
}

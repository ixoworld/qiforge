/**
 * Per-room JWE secrets for the Workers runtime — the port of the Node
 * runtime's `SecretsService` (`modules/secrets/secrets.service.ts`).
 *
 * Storage is Matrix room state + timeline, wire-identical to the portal and
 * the Node runtime:
 *   - `ixo.room.secret.index` STATE events, one per secret name
 *     (`state_key` = name, content `{ eventId, publicKeyId }`; empty content
 *     marks a deleted entry);
 *   - `ixo.room.secret` TIMELINE events carrying `{ value: <compact JWE> }`.
 *
 * Values are encrypted to the oracle's published P-256 key
 * (`ECDH-ES+A256KW` / `A256GCM`, see `jwe.ts`); the private JWK is loaded
 * from the oracle's Matrix account room via the gateway and seated once at
 * boot. All Matrix I/O goes through the gateway stub (the only object holding
 * the bot session) using its JSON-string RPC surface.
 */
import type { Logger } from '../plugin-api/types';
import { decryptJwe, encryptJwe, type JWK } from './jwe';

/**
 * The key id recorded on secret-index entries written by this runtime.
 * Matches the id the oracle's P-256 key is published under
 * (`ixo.room.encryption_key.index` / `p256_encryption`), so portal-written
 * and runtime-written secrets carry the same shape.
 */
export const RUNTIME_PUBLIC_KEY_ID = 'p256_encryption';

const SECRET_INDEX_TYPE = 'ixo.room.secret.index';
const SECRET_VALUE_TYPE = 'ixo.room.secret';
const REDACTION_TYPE = 'm.room.redaction';

const TWENTY_FOUR_HOURS_MS = 24 * 60 * 60 * 1000;

export interface SecretIndexEntry {
  name: string;
  eventId: string;
  publicKeyId: string;
}

interface CachedSecret {
  value: string;
  eventId: string;
  expiresAt: number;
}

/**
 * The slice of the gateway RPC surface this service needs — structurally
 * satisfied by `DurableObjectStub<MatrixGatewayObject>` and trivially mocked
 * in tests. All content crosses as JSON strings (`do/contracts.ts` rule).
 */
export interface SecretsGateway {
  /** Full room state as JSON `[{ type, state_key, content, ... }]`. */
  getRoomState(roomId: string): Promise<string>;
  /** Send a timeline event (`content` JSON-encoded); returns the event id. */
  sendEvent(roomId: string, type: string, content: string): Promise<string>;
  /** Send a state event (`content` JSON-encoded); returns the event id. */
  sendStateEvent(
    roomId: string,
    type: string,
    content: string,
    stateKey?: string,
  ): Promise<string>;
  /** One timeline event as JSON `{ event_id, type, content, ... }`, or null. */
  getEvent(roomId: string, eventId: string): Promise<string | null>;
}

export interface WorkersSecretsServiceOptions {
  gateway: SecretsGateway;
  /** The oracle's P-256 private JWK, when already loaded. Seat later via {@link WorkersSecretsService.setEncryptionKey}. */
  encryptionKey?: JWK | null;
  logger?: Logger;
}

const NOOP: Logger = {
  log: () => undefined,
  warn: () => undefined,
  error: () => undefined,
};

interface StateEventRow {
  type?: unknown;
  state_key?: unknown;
  content?: unknown;
}

export class WorkersSecretsService {
  private readonly gateway: SecretsGateway;
  private readonly logger: Logger;
  // TODO: Key rotation — Map<publicKeyId, JWK> once multiple keys exist.
  private encryptionKey: JWK | null;
  /** 24h in-memory cache per (room, name), invalidated by eventId changes. */
  private readonly cache = new Map<string, CachedSecret>();

  constructor(opts: WorkersSecretsServiceOptions) {
    this.gateway = opts.gateway;
    this.encryptionKey = opts.encryptionKey ?? null;
    this.logger = opts.logger ?? NOOP;
  }

  setEncryptionKey(key: JWK): void {
    this.encryptionKey = key;
  }

  hasEncryptionKey(): boolean {
    return this.encryptionKey !== null;
  }

  private cacheKey(roomId: string, name: string): string {
    return JSON.stringify([roomId, name]);
  }

  /**
   * The secret index from room state. One gateway round-trip; the Matrix CS
   * API has no per-type state listing, so full state + client-side filter is
   * the only option (same as the Node service). Errors degrade to `[]`.
   */
  async getIndex(roomId: string): Promise<SecretIndexEntry[]> {
    let rows: unknown;
    try {
      rows = JSON.parse(await this.gateway.getRoomState(roomId));
    } catch (error) {
      this.logger.error(
        `[secrets] failed to read secret index for room ${roomId}: ${error instanceof Error ? error.message : String(error)}`,
      );
      return [];
    }
    if (!Array.isArray(rows)) return [];

    const index: SecretIndexEntry[] = [];
    for (const row of rows as StateEventRow[]) {
      if (row?.type !== SECRET_INDEX_TYPE) continue;
      if (typeof row.state_key !== 'string') continue;
      const content = row.content;
      // Empty content is the "deleted" marker.
      if (!content || typeof content !== 'object') continue;
      const record = content as Record<string, unknown>;
      if (Object.keys(record).length === 0) continue;
      if (typeof record.eventId !== 'string' || record.eventId.length === 0)
        continue;
      index.push({
        name: row.state_key,
        eventId: record.eventId,
        publicKeyId:
          typeof record.publicKeyId === 'string'
            ? record.publicKeyId
            : RUNTIME_PUBLIC_KEY_ID,
      });
    }
    return index;
  }

  /**
   * Decrypted values for the named secrets. Uses the cache where the index's
   * eventId still matches; otherwise fetches the timeline event and decrypts.
   * Without a seated key this returns `{}` (each undecryptable entry is
   * logged and skipped — the Node service degrades identically).
   */
  async getValues(
    roomId: string,
    names: string[],
  ): Promise<Record<string, string>> {
    if (names.length === 0) return {};
    const requested = new Set(names);
    const index = (await this.getIndex(roomId)).filter((entry) =>
      requested.has(entry.name),
    );
    return this.loadValues(roomId, index);
  }

  private async loadValues(
    roomId: string,
    index: SecretIndexEntry[],
  ): Promise<Record<string, string>> {
    const result: Record<string, string> = {};
    const now = Date.now();

    for (const entry of index) {
      const key = this.cacheKey(roomId, entry.name);
      const cached = this.cache.get(key);
      if (
        cached &&
        cached.eventId === entry.eventId &&
        cached.expiresAt > now
      ) {
        result[entry.name] = cached.value;
        continue;
      }
      if (!this.encryptionKey) {
        this.logger.error(
          `[secrets] secret "${entry.name}" is encrypted but no encryption key is seated — skipping`,
        );
        continue;
      }
      try {
        const raw = await this.gateway.getEvent(roomId, entry.eventId);
        if (!raw) {
          this.logger.warn(
            `[secrets] secret event ${entry.eventId} for "${entry.name}" not found in ${roomId}`,
          );
          continue;
        }
        const parsed: unknown = JSON.parse(raw);
        const content =
          parsed && typeof parsed === 'object'
            ? (parsed as { content?: unknown }).content
            : undefined;
        const jwe =
          content && typeof content === 'object'
            ? (content as Record<string, unknown>).value
            : undefined;
        if (typeof jwe !== 'string' || jwe.length === 0) {
          this.logger.warn(
            `[secrets] secret event ${entry.eventId} for "${entry.name}" carries no value`,
          );
          continue;
        }
        // TODO: Key rotation — select the key via entry.publicKeyId.
        const value = await decryptJwe(jwe, this.encryptionKey);
        result[entry.name] = value;
        this.cache.set(key, {
          value,
          eventId: entry.eventId,
          expiresAt: Date.now() + TWENTY_FOUR_HOURS_MS,
        });
      } catch (error) {
        this.logger.error(
          `[secrets] failed to fetch/decrypt secret "${entry.name}" (event ${entry.eventId}): ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }
    return result;
  }

  /**
   * Write (or overwrite) a room secret from the runtime side, using the same
   * event shape the portal writes: the JWE value in an `ixo.room.secret`
   * timeline event, referenced by an `ixo.room.secret.index` state event
   * keyed by the secret name. Encrypts to the oracle's own published key so
   * the read path decrypts it identically to a portal-written secret. The
   * cache is primed with the plaintext; the superseded ciphertext event is
   * redacted best-effort.
   */
  async putSecret(roomId: string, name: string, value: string): Promise<void> {
    if (!this.encryptionKey) {
      throw new Error(
        `[secrets] cannot write secret "${name}" — no encryption key seated`,
      );
    }

    const previous = (await this.getIndex(roomId)).find(
      (entry) => entry.name === name,
    );

    const jwe = await encryptJwe(value, this.encryptionKey);
    const eventId = await this.gateway.sendEvent(
      roomId,
      SECRET_VALUE_TYPE,
      JSON.stringify({ value: jwe }),
    );
    await this.gateway.sendStateEvent(
      roomId,
      SECRET_INDEX_TYPE,
      JSON.stringify({ eventId, publicKeyId: RUNTIME_PUBLIC_KEY_ID }),
      name,
    );

    if (previous && previous.eventId !== eventId) {
      try {
        await this.gateway.sendEvent(
          roomId,
          REDACTION_TYPE,
          JSON.stringify({ redacts: previous.eventId }),
        );
      } catch (error) {
        this.logger.warn(
          `[secrets] could not redact superseded secret event ${previous.eventId} in ${roomId}: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }

    this.cache.set(this.cacheKey(roomId, name), {
      value,
      eventId,
      expiresAt: Date.now() + TWENTY_FOUR_HOURS_MS,
    });
    this.logger.log(
      `[secrets] wrote secret "${name}" to room ${roomId} (event ${eventId})`,
    );
  }

  /**
   * Delete a room secret: clears the index entry (empty state content is the
   * "deleted" marker `getIndex` filters on), best-effort redacts the
   * timeline event carrying the value, and drops the cache entry.
   */
  async deleteSecret(roomId: string, name: string): Promise<void> {
    const entry = (await this.getIndex(roomId)).find((e) => e.name === name);

    await this.gateway.sendStateEvent(roomId, SECRET_INDEX_TYPE, '{}', name);

    if (entry) {
      try {
        await this.gateway.sendEvent(
          roomId,
          REDACTION_TYPE,
          JSON.stringify({ redacts: entry.eventId }),
        );
      } catch (error) {
        this.logger.warn(
          `[secrets] could not redact secret event ${entry.eventId} in ${roomId}: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }

    this.cache.delete(this.cacheKey(roomId, name));
    this.logger.log(`[secrets] deleted secret "${name}" from room ${roomId}`);
  }
}

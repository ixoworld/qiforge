import {
  canonicalJson,
  parseOutcome,
  parseReference,
  type ActionOutcomeV1,
  type ActionOperationV1,
  type ActionReferenceV1,
} from '@ixo/action-protocol';
import type { DoSqliteDatabase } from '../sqlite/database';
import type { TransferToken } from './transfer';

function isTransferToken(value: unknown): value is TransferToken {
  return (
    !!value &&
    typeof value === 'object' &&
    'denom' in value &&
    typeof value.denom === 'string' &&
    'symbol' in value &&
    typeof value.symbol === 'string' &&
    'decimals' in value &&
    typeof value.decimals === 'number' &&
    Number.isSafeInteger(value.decimals) &&
    'verified' in value &&
    typeof value.verified === 'boolean'
  );
}

/**
 * Outcomes after which the Hub never reports another for the action
 * (`expired` and `cancelled`: never executed, protocol 0.4.0).
 */
export const TERMINAL_HUB_STATUSES: ReadonlySet<ActionOutcomeV1['status']> =
  new Set(['succeeded', 'failed', 'declined', 'expired', 'cancelled']);
/** Status refreshes of a non-terminal action back off 15 s -> 10 min. */
export const HUB_CHECK_BASE_MS = 15_000;
export const HUB_CHECK_MAX_MS = 10 * 60_000;
/** A non-terminal action is no longer refreshed this long after its review expired. */
export const HUB_CHECK_AFTER_EXPIRY_MS = 24 * 60 * 60_000;
/** Rows are dropped this long after their review expired. */
const HUB_RETENTION_SECONDS = 30 * 24 * 60 * 60;

/**
 * A refusal the model can act on: a cap reached, a request that expired, or
 * an operation the owner's own state rules out (an unknown connection, an
 * email whose earlier send is unconfirmed: `priorActionId`). A refusal
 * Auth Hub answered carries its HTTP status (`httpStatus`), so a caller can
 * tell a 429 or 503, which pass with time, from a deterministic refusal
 * without reading the words.
 */
export class HubActionRefused extends Error {
  constructor(
    readonly kind: 'limit' | 'expired' | 'refused',
    message: string,
    readonly priorActionId?: string,
    readonly httpStatus?: number,
  ) {
    super(message);
    this.name = 'HubActionRefused';
  }
}

export interface HubActionOrigin {
  ownerDid: string;
  sessionId: string;
  runId: string;
  requestId: string;
  bindingId: string;
  bindingRevision: number;
  requestKey: string;
}

interface ActionRow extends Record<
  string,
  string | number | bigint | null | Uint8Array
> {
  reference: string;
  owner_did: string;
  session_id: string;
  run_id: string;
  request_id: string;
  binding_id: string;
  binding_revision: number;
  request_key: string;
}

export class HubActionStore {
  constructor(
    private readonly db: DoSqliteDatabase,
    private readonly now = Date.now,
  ) {}

  async setup(): Promise<void> {
    await this.db.run(`CREATE TABLE IF NOT EXISTS hub_actions (
      action_id TEXT PRIMARY KEY, owner_did TEXT NOT NULL, session_id TEXT NOT NULL,
      run_id TEXT NOT NULL, request_id TEXT NOT NULL, binding_id TEXT NOT NULL,
      binding_revision INTEGER NOT NULL, request_key TEXT NOT NULL UNIQUE,
      reference TEXT NOT NULL
    )`);
    await this.db.run(`CREATE INDEX IF NOT EXISTS hub_actions_turn
      ON hub_actions(owner_did, session_id, run_id)`);
    await this.db.run(`CREATE TABLE IF NOT EXISTS hub_action_requests (
      request_key TEXT PRIMARY KEY, owner_did TEXT NOT NULL, session_id TEXT NOT NULL,
      run_id TEXT NOT NULL, request_id TEXT NOT NULL, binding_id TEXT NOT NULL,
      binding_revision INTEGER NOT NULL, operation TEXT NOT NULL, expires_at INTEGER NOT NULL
    )`);
    await this.db.run(`CREATE TABLE IF NOT EXISTS hub_action_outcomes (
      event_id TEXT PRIMARY KEY, action_id TEXT NOT NULL, sequence INTEGER NOT NULL,
      outcome TEXT NOT NULL, FOREIGN KEY(action_id) REFERENCES hub_actions(action_id)
    )`);
    // The unique index below covers the same columns.
    await this.db.run(`DROP INDEX IF EXISTS hub_action_outcomes_action`);
    await this.db
      .run(`CREATE UNIQUE INDEX IF NOT EXISTS hub_action_outcomes_sequence
      ON hub_action_outcomes(action_id, sequence)`);
    // Columns added after the first shape (flag-gated, so only test and
    // devnet objects hold it): adding a column is instant in SQLite.
    const actionColumns = await this.db.exec<{ name: string }>(
      `PRAGMA table_info(hub_actions)`,
    );
    if (!actionColumns.some((c) => c.name === 'next_check_at'))
      await this.db.run(
        `ALTER TABLE hub_actions ADD COLUMN next_check_at INTEGER NOT NULL DEFAULT 0`,
      );
    if (!actionColumns.some((c) => c.name === 'check_attempts'))
      await this.db.run(
        `ALTER TABLE hub_actions ADD COLUMN check_attempts INTEGER NOT NULL DEFAULT 0`,
      );
    // The token a transfer was prepared with (symbol, decimals, verified),
    // for the owner-facing outcome line.
    if (!actionColumns.some((c) => c.name === 'token'))
      await this.db.run(`ALTER TABLE hub_actions ADD COLUMN token TEXT`);
    if (!actionColumns.some((c) => c.name === 'expires_at'))
      await this.db.run(
        `ALTER TABLE hub_actions ADD COLUMN expires_at INTEGER NOT NULL DEFAULT 0`,
      );
    const requestColumns = await this.db.exec<{ name: string }>(
      `PRAGMA table_info(hub_action_requests)`,
    );
    if (!requestColumns.some((c) => c.name === 'created_at'))
      await this.db.run(
        `ALTER TABLE hub_action_requests ADD COLUMN created_at INTEGER NOT NULL DEFAULT 0`,
      );
    await this.db.run(`CREATE INDEX IF NOT EXISTS hub_action_requests_expires
      ON hub_action_requests(expires_at)`);
    await this.db.run(`CREATE INDEX IF NOT EXISTS hub_action_requests_owner
      ON hub_action_requests(owner_did, created_at)`);
    await this.db.run(
      `UPDATE hub_actions SET expires_at = json_extract(reference, '$.expiresAt') WHERE expires_at = 0`,
    );
    await this.db.run(`CREATE INDEX IF NOT EXISTS hub_actions_expires
      ON hub_actions(expires_at)`);
  }

  /**
   * Drop requests, actions and outcomes whose review expired more than
   * 30 days ago (bounded per call). Returns how many rows went.
   */
  async prune(): Promise<number> {
    const before = Math.floor(this.now() / 1000) - HUB_RETENTION_SECONDS;
    return this.db.transaction(async () => {
      const requests = await this.db.run(
        `DELETE FROM hub_action_requests WHERE request_key IN (SELECT request_key FROM hub_action_requests WHERE expires_at < ? LIMIT 64)`,
        [before],
      );
      const actions = await this.db.exec<{ action_id: string }>(
        `SELECT action_id FROM hub_actions WHERE expires_at < ? LIMIT 64`,
        [before],
      );
      for (const { action_id } of actions) {
        await this.db.run(
          `DELETE FROM hub_action_outcomes WHERE action_id = ?`,
          [action_id],
        );
        await this.db.run(`DELETE FROM hub_actions WHERE action_id = ?`, [
          action_id,
        ]);
      }
      return requests.changes + actions.length;
    });
  }

  /**
   * The newest Gmail send to the same mailbox (the same `connectionId`, or
   * the same account label: a reconnect gets a new id) that is still in
   * flight: approved and not finished, its latest outcome `authorized`,
   * `submitted` or `unknown` (the connector could not tell whether it
   * went). Its action id, or null. One Gmail send in flight per mailbox:
   * while one exists no other email is prepared.
   */
  async gmailSendInFlight(
    ownerDid: string,
    connectionId: string,
    accountLabel: string,
  ): Promise<string | null> {
    const row = await this.db.get<{ action_id: string }>(
      `SELECT a.action_id FROM hub_action_requests r JOIN hub_actions a ON a.request_key = r.request_key
       WHERE r.owner_did = ? AND json_extract(r.operation, '$.kind') = 'gmail.message.send.v1'
         AND (json_extract(r.operation, '$.connectionId') = ?
              OR lower(json_extract(r.operation, '$.accountLabel')) = lower(?))
         AND (SELECT json_extract(o.outcome, '$.status') FROM hub_action_outcomes o
              WHERE o.action_id = a.action_id ORDER BY o.sequence DESC LIMIT 1)
             IN ('authorized', 'submitted', 'unknown')
       ORDER BY r.created_at DESC LIMIT 1`,
      [ownerDid, connectionId, accountLabel],
    );
    return row?.action_id ?? null;
  }

  /** Keep the token a transfer was prepared with, for its outcome line. */
  async setToken(actionId: string, token: TransferToken): Promise<void> {
    await this.db.run('UPDATE hub_actions SET token = ? WHERE action_id = ?', [
      JSON.stringify({
        denom: token.denom,
        symbol: token.symbol,
        decimals: token.decimals,
        verified: token.verified,
      }),
      actionId,
    ]);
  }
  async token(
    ownerDid: string,
    actionId: string,
  ): Promise<TransferToken | null> {
    const row = await this.db.get<{ token: string | null }>(
      'SELECT token FROM hub_actions WHERE owner_did = ? AND action_id = ?',
      [ownerDid, actionId],
    );
    if (!row?.token) return null;
    const value: unknown = JSON.parse(row.token);
    return isTransferToken(value) ? value : null;
  }

  /** The reference already recorded for a request key, if any. */
  async byRequestKey(requestKey: string): Promise<ActionReferenceV1 | null> {
    const row = await this.db.get<{ reference: string }>(
      'SELECT reference FROM hub_actions WHERE request_key = ?',
      [requestKey],
    );
    return row ? parseReference(JSON.parse(row.reference)) : null;
  }

  async reserve(
    origin: HubActionOrigin,
    operation: ActionOperationV1,
    proposedExpiry: number,
  ): Promise<number> {
    return this.db.transaction(async () => {
      const previous = await this.db.get<
        ActionRow & { operation: string; expires_at: number }
      >('SELECT * FROM hub_action_requests WHERE request_key = ?', [
        origin.requestKey,
      ]);
      const encoded = canonicalJson(operation);
      if (previous) {
        if (
          previous.owner_did !== origin.ownerDid ||
          previous.session_id !== origin.sessionId ||
          previous.run_id !== origin.runId ||
          previous.request_id !== origin.requestId ||
          previous.binding_id !== origin.bindingId ||
          previous.binding_revision !== origin.bindingRevision ||
          previous.operation !== encoded
        )
          throw new Error(
            'Hub action request key belongs to another operation',
          );
        return previous.expires_at;
      }
      await this.db.run(
        `INSERT INTO hub_action_requests(request_key,owner_did,session_id,run_id,request_id,binding_id,binding_revision,operation,expires_at,created_at)
         VALUES(?,?,?,?,?,?,?,?,?,?)`,
        [
          origin.requestKey,
          origin.ownerDid,
          origin.sessionId,
          origin.runId,
          origin.requestId,
          origin.bindingId,
          origin.bindingRevision,
          encoded,
          proposedExpiry,
          this.now(),
        ],
      );
      return proposedExpiry;
    });
  }

  async record(
    origin: HubActionOrigin,
    input: ActionReferenceV1,
  ): Promise<ActionReferenceV1> {
    const reference = parseReference(input);
    if (
      reference.bindingId !== origin.bindingId ||
      reference.bindingRevision !== origin.bindingRevision
    )
      throw new Error(
        'Hub action reference does not match the channel binding',
      );
    return this.db.transaction(async () => {
      const previous = await this.db.get<ActionRow>(
        'SELECT * FROM hub_actions WHERE request_key = ?',
        [origin.requestKey],
      );
      if (previous) {
        const old = parseReference(JSON.parse(previous.reference));
        if (
          previous.owner_did !== origin.ownerDid ||
          previous.session_id !== origin.sessionId ||
          previous.run_id !== origin.runId ||
          previous.request_id !== origin.requestId ||
          previous.binding_id !== origin.bindingId ||
          previous.binding_revision !== origin.bindingRevision ||
          canonicalJson(old) !== canonicalJson(reference)
        )
          throw new Error('Hub action request key belongs to another action');
        return old;
      }
      await this.db.run(
        `INSERT INTO hub_actions(action_id,owner_did,session_id,run_id,request_id,binding_id,binding_revision,request_key,reference,expires_at)
         VALUES(?,?,?,?,?,?,?,?,?,?)`,
        [
          reference.id,
          origin.ownerDid,
          origin.sessionId,
          origin.runId,
          origin.requestId,
          origin.bindingId,
          origin.bindingRevision,
          origin.requestKey,
          JSON.stringify(reference),
          reference.expiresAt,
        ],
      );
      return reference;
    });
  }

  async get(
    ownerDid: string,
    actionId: string,
  ): Promise<{ origin: HubActionOrigin; reference: ActionReferenceV1 } | null> {
    const row = await this.db.get<ActionRow>(
      'SELECT * FROM hub_actions WHERE owner_did = ? AND action_id = ?',
      [ownerDid, actionId],
    );
    if (!row) return null;
    return {
      origin: {
        ownerDid: row.owner_did,
        sessionId: row.session_id,
        runId: row.run_id,
        requestId: row.request_id,
        bindingId: row.binding_id,
        bindingRevision: row.binding_revision,
        requestKey: row.request_key,
      },
      reference: parseReference(JSON.parse(row.reference)),
    };
  }

  async forRun(
    ownerDid: string,
    sessionId: string,
    runId: string,
  ): Promise<ActionReferenceV1[]> {
    const rows = await this.db.exec<ActionRow>(
      'SELECT * FROM hub_actions WHERE owner_did = ? AND session_id = ? AND run_id = ? ORDER BY action_id',
      [ownerDid, sessionId, runId],
    );
    return rows.map((row) => parseReference(JSON.parse(row.reference)));
  }

  /**
   * The run's actions with their latest stored outcome and refresh
   * schedule, from SQLite only.
   */
  async runState(
    ownerDid: string,
    sessionId: string,
    runId: string,
  ): Promise<
    {
      reference: ActionReferenceV1;
      latest: ActionOutcomeV1 | null;
      nextCheckAt: number;
      checkAttempts: number;
    }[]
  > {
    const rows = await this.db.exec<{
      reference: string;
      next_check_at: number;
      check_attempts: number;
      outcome: string | null;
    }>(
      `SELECT a.reference, a.next_check_at, a.check_attempts, (
         SELECT e.outcome FROM hub_action_outcomes e WHERE e.action_id=a.action_id
         ORDER BY e.sequence DESC LIMIT 1) AS outcome
       FROM hub_actions a WHERE a.owner_did=? AND a.session_id=? AND a.run_id=?
       ORDER BY a.action_id`,
      [ownerDid, sessionId, runId],
    );
    return rows.map((row) => ({
      reference: parseReference(JSON.parse(row.reference)),
      latest: row.outcome ? parseOutcome(JSON.parse(row.outcome)) : null,
      nextCheckAt: row.next_check_at,
      checkAttempts: row.check_attempts,
    }));
  }

  /** Spend one status refresh: the next waits 15 s, doubling to 10 min. */
  async scheduleCheck(actionId: string, attempts: number): Promise<void> {
    await this.db.run(
      'UPDATE hub_actions SET next_check_at = ?, check_attempts = ? WHERE action_id = ?',
      [
        this.now() +
          Math.min(HUB_CHECK_BASE_MS * 2 ** attempts, HUB_CHECK_MAX_MS),
        attempts + 1,
        actionId,
      ],
    );
  }

  /**
   * Store an authenticated outcome. Returns whether it was new: a repeat
   * (same event) or an older one than the latest stored (a late or stale
   * read; sequences only move forward) changes nothing.
   */
  async recordOutcome(input: ActionOutcomeV1): Promise<boolean> {
    const outcome = parseOutcome(input);
    const held = await this.get(outcome.ownerDid, outcome.reference.id);
    if (
      !held ||
      canonicalJson(held.reference) !== canonicalJson(outcome.reference)
    )
      throw new Error('Hub outcome does not match a prepared action');
    if (
      outcome.authorizedRevision < held.reference.revision ||
      (outcome.authorizedRevision === held.reference.revision &&
        outcome.authorizedDigest !== held.reference.digest)
    )
      throw new Error(
        'Hub outcome revision does not descend from the reference',
      );
    return this.db.transaction(async () => {
      const existing = await this.db.get<{ outcome: string }>(
        'SELECT outcome FROM hub_action_outcomes WHERE event_id = ?',
        [outcome.eventId],
      );
      if (existing) {
        if (
          canonicalJson(JSON.parse(existing.outcome)) !== canonicalJson(outcome)
        )
          throw new Error('Hub outcome event ID conflict');
        return false;
      }
      const latest = await this.db.get<{ sequence: number }>(
        'SELECT MAX(sequence) AS sequence FROM hub_action_outcomes WHERE action_id = ?',
        [outcome.reference.id],
      );
      if (latest?.sequence != null && outcome.sequence < latest.sequence)
        return false;
      const sameSequence = await this.db.get<{ outcome: string }>(
        'SELECT outcome FROM hub_action_outcomes WHERE action_id = ? AND sequence = ?',
        [outcome.reference.id, outcome.sequence],
      );
      if (sameSequence) throw new Error('Hub outcome sequence conflict');
      await this.db.run(
        'INSERT INTO hub_action_outcomes(event_id,action_id,sequence,outcome) VALUES(?,?,?,?)',
        [
          outcome.eventId,
          outcome.reference.id,
          outcome.sequence,
          JSON.stringify(outcome),
        ],
      );
      return true;
    });
  }

  /** The stored outcome of the owner's action at `sequence`, if any. */
  async outcomeAt(
    ownerDid: string,
    actionId: string,
    sequence: number,
  ): Promise<ActionOutcomeV1 | null> {
    const row = await this.db.get<{ outcome: string }>(
      `SELECT o.outcome FROM hub_action_outcomes o
         JOIN hub_actions a ON a.action_id = o.action_id
        WHERE a.owner_did = ? AND o.action_id = ? AND o.sequence = ?`,
      [ownerDid, actionId, sequence],
    );
    return row ? parseOutcome(JSON.parse(row.outcome)) : null;
  }

  async outcomesForRun(
    ownerDid: string,
    sessionId: string,
    runId: string,
  ): Promise<ActionOutcomeV1[]> {
    const rows = await this.db.exec<{ outcome: string }>(
      `SELECT o.outcome FROM hub_actions a JOIN hub_action_outcomes o ON o.event_id=(
         SELECT e.event_id FROM hub_action_outcomes e WHERE e.action_id=a.action_id
         ORDER BY e.sequence DESC LIMIT 1)
       WHERE a.owner_did=? AND a.session_id=? AND a.run_id=?
       ORDER BY a.action_id`,
      [ownerDid, sessionId, runId],
    );
    return rows.map((row) => parseOutcome(JSON.parse(row.outcome)));
  }
}

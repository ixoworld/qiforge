import {
  canonicalJson,
  parseOutcome,
  parseReference,
  type ActionOutcomeV1,
  type ActionOperationV1,
  type ActionReferenceV1,
} from '@ixo/action-protocol';
import type { DoSqliteDatabase } from '../sqlite/database';

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
  constructor(private readonly db: DoSqliteDatabase) {}

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
    await this.db.run(`CREATE INDEX IF NOT EXISTS hub_action_outcomes_action
      ON hub_action_outcomes(action_id, sequence)`);
    await this.db
      .run(`CREATE UNIQUE INDEX IF NOT EXISTS hub_action_outcomes_sequence
      ON hub_action_outcomes(action_id, sequence)`);
  }

  async reserve(
    origin: HubActionOrigin,
    operation: ActionOperationV1,
    proposedExpiry: number,
  ): Promise<number> {
    return this.db.transaction(async () => {
      await this.db.run(
        'DELETE FROM hub_action_requests WHERE expires_at < ?',
        [Math.floor(Date.now() / 1000) - 30 * 24 * 60 * 60],
      );
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
        `INSERT INTO hub_action_requests(request_key,owner_did,session_id,run_id,request_id,binding_id,binding_revision,operation,expires_at)
         VALUES(?,?,?,?,?,?,?,?,?)`,
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
        `INSERT INTO hub_actions(action_id,owner_did,session_id,run_id,request_id,binding_id,binding_revision,request_key,reference)
         VALUES(?,?,?,?,?,?,?,?,?)`,
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

  async recordOutcome(input: ActionOutcomeV1): Promise<void> {
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
    await this.db.transaction(async () => {
      const existing = await this.db.get<{ outcome: string }>(
        'SELECT outcome FROM hub_action_outcomes WHERE event_id = ?',
        [outcome.eventId],
      );
      if (existing) {
        if (
          canonicalJson(JSON.parse(existing.outcome)) !== canonicalJson(outcome)
        )
          throw new Error('Hub outcome event ID conflict');
        return;
      }
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
    });
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

import type { DoSqliteDatabase } from '../sqlite/database';
import type { RunRecord } from '../do/run-store';
import type { TurnIdentity, TurnRequest } from '../do/contracts';
import { parseReplyPlan, planText } from '../delivery/schema';
import type { ReplyPlan } from '../delivery/types';
import {
  ChannelError,
  channelRequestHash,
  type ChannelTurnInput,
  type ChannelTurnResponse,
} from './contract';

interface ReceiptRow extends Record<string, string | number | null> {
  binding_id: string;
  request_id: string;
  request_hash: string;
  run_id: string;
  session_id: string | null;
  /** 1 once the assistant reply was mirrored into the Companion room. */
  reply_mirrored: number;
}

export interface ChannelTurnsHost {
  createSession(identity: TurnIdentity, markerTxnId: string): Promise<string>;
  assertSession(identity: TurnIdentity, sessionId: string): Promise<void>;
  /**
   * Throws a `ChannelError` (428 `delegation_required`) when the user has no
   * usable delegation for this oracle: none, or one too close to expiry.
   */
  requireDelegation(identity: TurnIdentity): Promise<void>;
  getRun(runId: string): Promise<RunRecord | undefined>;
  /** The Reply Plan (JSON) a finished run was built into, if any. */
  getPlan(runId: string): Promise<string | null>;
  wasPruned(runId: string): Promise<boolean>;
  begin(runId: string, request: TurnRequest): Promise<RunRecord>;
  mirror(
    request: TurnRequest,
    text: string,
    author: 'user' | 'oracle',
  ): Promise<void>;
  changed(): Promise<void>;
}

export class ChannelTurns {
  private admission: Promise<unknown> = Promise.resolve();
  private setupPromise: Promise<void> | undefined;

  constructor(
    private readonly db: DoSqliteDatabase,
    private readonly host: ChannelTurnsHost,
  ) {}

  private setup(): Promise<void> {
    this.setupPromise ??= (async () => {
      await this.db.run(`CREATE TABLE IF NOT EXISTS channel_requests (
        binding_id TEXT NOT NULL, request_id TEXT NOT NULL, request_hash TEXT NOT NULL,
        run_id TEXT NOT NULL UNIQUE, session_id TEXT,
        reply_mirrored INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY (binding_id, request_id)
      )`);
      // Tables created before the column existed (CREATE TABLE IF NOT
      // EXISTS leaves them as they were).
      const columns = await this.db.exec<{ name: string }>(
        'PRAGMA table_info(channel_requests)',
      );
      if (!columns.some((c) => c.name === 'reply_mirrored'))
        await this.db.run(
          'ALTER TABLE channel_requests ADD COLUMN reply_mirrored INTEGER NOT NULL DEFAULT 0',
        );
      await this.db.run(`CREATE TABLE IF NOT EXISTS channel_sessions (
        binding_id TEXT PRIMARY KEY, session_id TEXT NOT NULL
      )`);
    })().catch((error: unknown) => {
      this.setupPromise = undefined;
      throw error;
    });
    return this.setupPromise;
  }

  /** Admissions, reply deliveries and session releases run one at a time. */
  private serialize<T>(work: () => Promise<T>): Promise<T> {
    const next = this.admission.then(work);
    this.admission = next.catch(() => undefined);
    return next;
  }

  submit(
    identity: TurnIdentity,
    input: ChannelTurnInput,
    requestHash: string,
  ): Promise<ChannelTurnResponse> {
    return this.serialize(() => this.admit(identity, input, requestHash));
  }

  /**
   * Mirror a finished run's reply into the Companion room once: the receipt
   * records the delivery, so later polls of the same request do not send it
   * again. Called when the run ends; a poll retries a delivery that failed.
   * `text` is the model's reply; a run with a Reply Plan mirrors the plan
   * instead, as the channel user received it.
   */
  deliverReply(
    request: TurnRequest,
    runId: string,
    text: string,
  ): Promise<void> {
    return this.serialize(async () => {
      await this.deliver(request, runId, await this.reply(runId, text));
    });
  }

  /** A finished run's Reply Plan, and the reply as the channel user sees it. */
  private async reply(
    runId: string,
    text: string,
  ): Promise<{ plan: ReplyPlan | null; rendered: string }> {
    const plan = parseReplyPlan(await this.host.getPlan(runId));
    return { plan, rendered: plan ? planText(plan) : text };
  }

  /**
   * The session was deleted: release every binding that pointed at it, so
   * the binding's next message opens a new Companion session. Returns
   * whether a binding was released.
   */
  forgetSession(sessionId: string): Promise<boolean> {
    return this.serialize(async () => {
      await this.setup();
      const released = await this.db.run(
        'DELETE FROM channel_sessions WHERE session_id = ?',
        [sessionId],
      );
      if (released.changes === 0) return false;
      await this.host.changed();
      return true;
    });
  }

  private async deliver(
    request: TurnRequest,
    runId: string,
    reply: { rendered: string },
  ): Promise<void> {
    await this.setup();
    const receipt = await this.db.get<{ reply_mirrored: number }>(
      'SELECT reply_mirrored FROM channel_requests WHERE run_id = ?',
      [runId],
    );
    if (Number(receipt?.reply_mirrored ?? 0) === 1) return;
    await this.host.mirror(request, reply.rendered, 'oracle');
    await this.db.run(
      'UPDATE channel_requests SET reply_mirrored = 1 WHERE run_id = ?',
      [runId],
    );
    await this.host.changed();
  }

  private async admit(
    identity: TurnIdentity,
    input: ChannelTurnInput,
    requestHash: string,
  ): Promise<ChannelTurnResponse> {
    await this.setup();
    if (
      !identity.channel ||
      identity.channel.bindingId !== input.bindingId ||
      identity.channel.bindingRevision !== input.bindingRevision ||
      identity.channel.provider !== input.provider
    )
      throw new ChannelError(
        403,
        'Channel identity does not match this request',
        'identity_mismatch',
      );
    const runId = `channel_${await channelRequestHash(JSON.stringify([input.bindingId, input.requestId]))}`;
    // Checked before a receipt is written: the receipt of a pruned run is
    // gone (run-store.ts), and a new one must not take its place.
    if (await this.host.wasPruned(runId))
      throw new ChannelError(
        410,
        'Channel response has expired; this request cannot execute again',
        'response_expired',
      );
    const admitted = await this.db.run(
      `INSERT OR IGNORE INTO channel_requests
      (binding_id, request_id, request_hash, run_id) VALUES (?, ?, ?, ?)`,
      [input.bindingId, input.requestId, requestHash, runId],
    );
    // A poll of an admitted request changes nothing.
    if (admitted.changes === 1) await this.host.changed();
    const receipt = await this.db.get<ReceiptRow>(
      'SELECT * FROM channel_requests WHERE binding_id = ? AND request_id = ?',
      [input.bindingId, input.requestId],
    );
    if (!receipt || receipt.request_hash !== requestHash)
      throw new ChannelError(
        409,
        'This request ID already belongs to another message',
        'request_conflict',
      );
    let sessionId = receipt.session_id;
    // The session is checked when this request is bound to it, and again
    // before the request starts a run; a poll of a run that exists already
    // only reads its receipt and row.
    let sessionChecked = false;
    if (!sessionId) {
      const binding = await this.db.get<{ session_id: string }>(
        'SELECT session_id FROM channel_sessions WHERE binding_id = ?',
        [input.bindingId],
      );
      if (binding && input.sessionId && binding.session_id !== input.sessionId)
        throw new ChannelError(
          409,
          'This channel already has another session',
          'session_conflict',
        );
      sessionId =
        binding?.session_id ??
        input.sessionId ??
        // The marker transaction id is fixed per binding AND the request that
        // opens the session: a retry of that request reuses the marker event,
        // while a binding whose session was deleted gets a new one.
        (await this.host.createSession(
          identity,
          `channel-session-${await channelRequestHash(JSON.stringify([input.bindingId, input.requestId]))}`,
        ));
      await this.host.assertSession(identity, sessionId);
      sessionChecked = true;
      await this.db.transaction(async () => {
        await this.db.run(
          'INSERT OR IGNORE INTO channel_sessions (binding_id, session_id) VALUES (?, ?)',
          [input.bindingId, sessionId],
        );
        await this.db.run(
          'UPDATE channel_requests SET session_id = ? WHERE run_id = ?',
          [sessionId, runId],
        );
      });
      await this.host.changed();
    }
    const request: TurnRequest = {
      identity,
      sessionId,
      message: input.message,
      client: 'channel',
      requestId: input.requestId,
      multitask: 'enqueue',
      channel: {
        provider: input.provider,
        bindingId: input.bindingId,
        remoteMessageRef: input.remoteMessageRef,
      },
    };
    let record = await this.host.getRun(runId);
    if (!record) {
      if (!sessionChecked) await this.host.assertSession(identity, sessionId);
      await this.host.requireDelegation(identity);
      await this.host.mirror(request, request.message, 'user');
      record = await this.host.begin(runId, request);
    }
    const reply =
      record.status === 'finished'
        ? await this.reply(runId, record.partialText ?? '')
        : null;
    // The Companion room records the reply the channel user received, once.
    if (reply) await this.deliver(request, runId, reply);
    return {
      requestId: input.requestId,
      runId,
      sessionId,
      status: record.status,
      ...(record.messageId ? { messageId: record.messageId } : {}),
      // `text` is the whole reply as one message for gateways that predate
      // plans: the rendered plan when there is one (it carries the artefact
      // links), else the model's text.
      ...(reply ? { text: reply.rendered } : {}),
      ...(reply?.plan ? { plan: reply.plan } : {}),
    };
  }
}

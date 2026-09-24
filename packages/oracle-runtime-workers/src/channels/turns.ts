import type { DoSqliteDatabase } from '../sqlite/database';
import type { RunRecord } from '../do/run-store';
import type { TurnIdentity, TurnRequest } from '../do/contracts';
import {
  ChannelError,
  channelRequestHash,
  type ChannelTurnInput,
  type ChannelTurnResponse,
} from './contract';

interface ReceiptRow extends Record<string, string | null> {
  binding_id: string;
  request_id: string;
  request_hash: string;
  run_id: string;
  session_id: string | null;
}

export interface ChannelTurnsHost {
  createSession(identity: TurnIdentity, markerTxnId: string): Promise<string>;
  assertSession(identity: TurnIdentity, sessionId: string): Promise<void>;
  getRun(runId: string): Promise<RunRecord | undefined>;
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
        PRIMARY KEY (binding_id, request_id)
      )`);
      await this.db.run(`CREATE TABLE IF NOT EXISTS channel_sessions (
        binding_id TEXT PRIMARY KEY, session_id TEXT NOT NULL
      )`);
    })().catch((error: unknown) => {
      this.setupPromise = undefined;
      throw error;
    });
    return this.setupPromise;
  }

  submit(
    identity: TurnIdentity,
    input: ChannelTurnInput,
    requestHash: string,
  ): Promise<ChannelTurnResponse> {
    const next = this.admission.then(() =>
      this.admit(identity, input, requestHash),
    );
    this.admission = next.catch(() => undefined);
    return next;
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
      );
    const runId = `channel_${await channelRequestHash(JSON.stringify([input.bindingId, input.requestId]))}`;
    await this.db.run(
      `INSERT OR IGNORE INTO channel_requests
      (binding_id, request_id, request_hash, run_id) VALUES (?, ?, ?, ?)`,
      [input.bindingId, input.requestId, requestHash, runId],
    );
    await this.host.changed();
    const receipt = await this.db.get<ReceiptRow>(
      'SELECT * FROM channel_requests WHERE binding_id = ? AND request_id = ?',
      [input.bindingId, input.requestId],
    );
    if (!receipt || receipt.request_hash !== requestHash)
      throw new ChannelError(
        409,
        'This request ID already belongs to another message',
      );
    let sessionId = receipt.session_id;
    if (!sessionId) {
      const binding = await this.db.get<{ session_id: string }>(
        'SELECT session_id FROM channel_sessions WHERE binding_id = ?',
        [input.bindingId],
      );
      if (binding && input.sessionId && binding.session_id !== input.sessionId)
        throw new ChannelError(409, 'This channel already has another session');
      sessionId =
        binding?.session_id ??
        input.sessionId ??
        (await this.host.createSession(
          identity,
          `channel-session-${await channelRequestHash(input.bindingId)}`,
        ));
      await this.host.assertSession(identity, sessionId);
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
    await this.host.assertSession(identity, sessionId);
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
      await this.host.mirror(request, request.message, 'user');
      record = await this.host.begin(runId, request);
    }
    if (record.status === 'finished')
      await this.host.mirror(request, record.partialText ?? '', 'oracle');
    return {
      requestId: input.requestId,
      runId,
      sessionId,
      status: record.status,
      ...(record.messageId ? { messageId: record.messageId } : {}),
      ...(record.status === 'finished'
        ? { text: record.partialText ?? '' }
        : {}),
    };
  }
}

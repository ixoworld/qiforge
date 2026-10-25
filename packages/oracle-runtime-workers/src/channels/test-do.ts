import { DurableObject } from 'cloudflare:workers';
import { DoSqliteDatabase, type SqlRow } from '../sqlite/database';
import { RunStore, type RunRecord } from '../do/run-store';
import type { ReplyPlan } from '../delivery/types';
import { ChannelTurns } from './turns';
import {
  channelRequestHash,
  requireChannelDelegation,
  type ChannelDelegation,
  type ChannelTurnInput,
  type ChannelControlInput,
  type ChannelControlOutcome,
  type ChannelTurnOutcome,
  ChannelError,
  StaleSessionError,
} from './contract';

/** How the next room mirrors behave (`setMirror`). */
type MirrorMode = 'ok' | 'transient' | 'forbidden' | 'hang';

export class ChannelTurnsTestDO extends DurableObject {
  private db?: DoSqliteDatabase;
  private runs?: RunStore;
  private turns?: ChannelTurns;
  private nowMs = Date.now();
  /** Host calls made since the object loaded. */
  private calls = { assertSession: 0, changed: 0, createSession: 0 };
  private mirrorMode: MirrorMode = 'ok';
  private holdSessionCreation = false;
  private pendingSessions: (() => void)[] = [];
  /** Mirrors held by `hang`, released by `setMirror` with another mode. */
  private held: (() => void)[] = [];
  /** Wake-ups the turns asked for (`scheduleRetry`), epoch ms. */
  private retries: number[] = [];

  private async ready(): Promise<ChannelTurns> {
    if (this.turns) return this.turns;
    this.db = await DoSqliteDatabase.open(this.ctx, 'channels-test.db');
    const db = this.db;
    this.runs = new RunStore(db, () => this.nowMs);
    await this.runs.setup();
    const runs = this.runs;
    this.turns = new ChannelTurns(db, {
      createSession: async (_identity, marker) => {
        this.calls.createSession += 1;
        if (this.holdSessionCreation)
          await new Promise<void>((resolve) =>
            this.pendingSessions.push(resolve),
          );
        return `$${marker}`;
      },
      assertSession: async (_identity, sessionId) => {
        this.calls.assertSession += 1;
        if ((await this.deletedSessions()).includes(sessionId))
          throw new StaleSessionError('Session deleted');
        if (
          !sessionId.startsWith('$channel-session-') &&
          !sessionId.startsWith('$channel-reset-')
        )
          throw new ChannelError(404, 'Session not owned', 'session_not_found');
      },
      requireDelegation: async () =>
        requireChannelDelegation(
          await this.delegation(),
          Math.floor(this.nowMs / 1000),
        ),
      stopRun: async (runId) => {
        if (await runs.get(runId))
          await runs.close(runId, { status: 'aborted' });
      },
      getRun: (runId) => runs.get(runId),
      getPlan: (runId) => runs.getPlan(runId),
      wasPruned: (runId) => runs.wasChannelRunPruned(runId),
      begin: async (runId, request) => {
        await runs.create({
          runId,
          sessionId: request.sessionId,
          requestId: request.requestId,
          client: 'channel',
          status: 'running',
          request: JSON.stringify(request),
          checkpointId: null,
          instanceId: 'test',
        });
        await this.ctx.storage.sync();
        await this.ctx.storage.put(
          'executions',
          ((await this.ctx.storage.get<number>('executions')) ?? 0) + 1,
        );
        const row = await runs.get(runId);
        if (!row) throw new Error('Run was not persisted');
        return row;
      },
      requestOf: (record) => JSON.parse(record.request),
      mirror: async (_request, text, author) => {
        if (this.mirrorMode === 'hang')
          await new Promise<void>((resolve) => this.held.push(resolve));
        if (this.mirrorMode === 'transient')
          throw new Error('Network connection lost');
        if (this.mirrorMode === 'forbidden')
          throw new Error(
            'MatrixError: [403] User @oracle:test not in room !room:test',
          );
        const key = `mirrors:${author}`;
        await this.ctx.storage.put(
          key,
          ((await this.ctx.storage.get<number>(key)) ?? 0) + 1,
        );
        await this.ctx.storage.put(`mirrored:${author}`, text);
        await this.ctx.storage.put('mirror-log', [
          ...((await this.ctx.storage.get<string[]>('mirror-log')) ?? []),
          `${author}:${text}`,
        ]);
      },
      changed: () => {
        this.calls.changed += 1;
        return this.ctx.storage.sync();
      },
      scheduleRetry: (at) => {
        this.retries.push(at);
      },
      keepAlive: (work) => this.ctx.waitUntil(work),
      pruneTombstones: (before, limit) =>
        runs.pruneChannelTombstones(before, limit),
      now: () => this.nowMs,
    });
    return this.turns;
  }

  /** The shell's poll path: answered only for a request whose run exists. */
  async poll(input: ChannelTurnInput): Promise<ChannelTurnOutcome | null> {
    const result = await (
      await this.ready()
    ).poll(
      this.identity(input),
      input,
      await channelRequestHash(JSON.stringify(input)),
    );
    return result ? { ok: true, result } : null;
  }

  private identity(
    input: Pick<ChannelTurnInput, 'provider' | 'bindingId' | 'bindingRevision'>,
  ) {
    return {
      userDid: 'did:ixo:user',
      channel: {
        callerDid: 'did:web:channels.test',
        provider: input.provider,
        bindingId: input.bindingId,
        bindingRevision: input.bindingRevision,
      },
    };
  }

  /** How the room mirrors behave from now on; held (`hang`) ones go on. */
  async setMirror(mode: MirrorMode): Promise<void> {
    this.mirrorMode = mode;
    if (mode !== 'hang') for (const release of this.held.splice(0)) release();
  }

  /** Wait until no mirror pass runs. */
  async settle(): Promise<void> {
    await (await this.ready()).whenIdle();
  }

  async housekeeping(): Promise<number | null> {
    return (await this.ready()).housekeeping();
  }

  async retryWakes(): Promise<number[]> {
    return [...this.retries];
  }

  /** Every mirror posted, in order (`author:text`). */
  async mirrorLog(): Promise<string[]> {
    return (await this.ctx.storage.get<string[]>('mirror-log')) ?? [];
  }

  /** The receipt of a request, as stored. */
  async receipt(requestId: string): Promise<SqlRow | null> {
    await this.ready();
    return (
      (await this.db!.get(
        'SELECT * FROM channel_requests WHERE request_id = ?',
        [requestId],
      )) ?? null
    );
  }

  /** The session bound to a binding, if any. */
  async boundSession(bindingId: string): Promise<string | null> {
    await this.ready();
    const row = await this.db!.get<{ session_id: string }>(
      'SELECT session_id FROM channel_sessions WHERE binding_id = ?',
      [bindingId],
    );
    return row?.session_id ?? null;
  }

  /** Advance the clock without reopening the database. */
  async advance(ms: number): Promise<void> {
    this.nowMs += ms;
  }

  async control(input: ChannelControlInput): Promise<ChannelControlOutcome> {
    try {
      return {
        ok: true,
        result: await (
          await this.ready()
        ).control(
          this.identity(input),
          input,
          await channelRequestHash(JSON.stringify(input)),
        ),
      };
    } catch (error) {
      if (error instanceof ChannelError)
        return {
          ok: false,
          status: error.status,
          code: error.code,
          message: error.message,
        };
      throw error;
    }
  }

  async submit(input: ChannelTurnInput): Promise<ChannelTurnOutcome> {
    try {
      const result = await (
        await this.ready()
      ).submit(
        this.identity(input),
        input,
        await channelRequestHash(JSON.stringify(input)),
      );
      return { ok: true, result };
    } catch (error) {
      if (error instanceof ChannelError)
        return {
          ok: false,
          status: error.status,
          code: error.code,
          message: error.message,
        };
      throw error;
    }
  }

  /** Finish a run as the coordinator does: the model's text, and a plan for a chat run. */
  async finish(
    runId: string,
    plan?: ReplyPlan,
    text = 'One answer',
  ): Promise<void> {
    await this.ready();
    if (plan) await this.runs!.setPlan(runId, JSON.stringify(plan));
    await this.runs!.update(runId, {
      status: 'finished',
      partialText: text,
      messageId: 'message-1',
    });
  }

  /**
   * What the user object's `onRunEnded` does for a channel run (a mirror
   * pass in the background), then wait for that pass.
   */
  async deliverReply(): Promise<void> {
    const turns = await this.ready();
    turns.deliverReply();
    await turns.whenIdle();
  }

  /** End a run without a reply, as a failed run does. */
  async fail(runId: string): Promise<void> {
    await this.ready();
    await this.runs!.update(runId, { status: 'failed', partialText: null });
  }

  async run(runId: string): Promise<RunRecord | undefined> {
    await this.ready();
    return this.runs!.get(runId);
  }

  /** The text of the last assistant mirror into the user's oracle room. */
  async mirroredReply(): Promise<string | undefined> {
    return this.ctx.storage.get<string>('mirrored:oracle');
  }

  async mirrors(): Promise<{ user: number; oracle: number }> {
    return {
      user: (await this.ctx.storage.get<number>('mirrors:user')) ?? 0,
      oracle: (await this.ctx.storage.get<number>('mirrors:oracle')) ?? 0,
    };
  }

  /** What `UserOracleDO.deleteSession` does: the session is gone, the binding released. */
  async deleteSession(sessionId: string): Promise<boolean> {
    const turns = await this.ready();
    await this.ctx.storage.put('deleted-sessions', [
      ...(await this.deletedSessions()),
      sessionId,
    ]);
    return turns.forgetSession(sessionId);
  }

  /** The session is gone, but the binding was never released. */
  async markSessionDeleted(sessionId: string): Promise<void> {
    await this.ctx.storage.put('deleted-sessions', [
      ...(await this.deletedSessions()),
      sessionId,
    ]);
  }

  /** A receipt as a request leaves it when the object stops before its run starts. */
  async orphanReceipt(requestId: string): Promise<void> {
    await this.ready();
    await this.db!.run(
      `INSERT INTO channel_requests (binding_id, request_id, request_hash, run_id, created_at)
       VALUES ('chb_one', ?, 'hash', ?, ?)`,
      [requestId, `channel_orphan_${requestId}`, this.nowMs],
    );
  }

  private async deletedSessions(): Promise<string[]> {
    return (await this.ctx.storage.get<string[]>('deleted-sessions')) ?? [];
  }

  async revokeDelegation(): Promise<void> {
    await this.ctx.storage.put('delegation-revoked', true);
  }

  /** The user's delegation from now on (an expiry in unix seconds). */
  async setDelegation(delegation: ChannelDelegation): Promise<void> {
    await this.ctx.storage.delete('delegation-revoked');
    await this.ctx.storage.put('delegation', delegation);
  }

  /** None once revoked; else the one set, else one valid for an hour. */
  private async delegation(): Promise<ChannelDelegation | undefined> {
    if ((await this.ctx.storage.get<boolean>('delegation-revoked')) === true)
      return undefined;
    return (
      (await this.ctx.storage.get<ChannelDelegation>('delegation')) ?? {
        raw: 'grant',
        expiration: Math.floor(this.nowMs / 1000) + 3600,
      }
    );
  }

  async expire(ms: number): Promise<void> {
    this.nowMs += ms;
    await this.reopen();
    await this.ready();
    await this.ctx.storage.sync();
  }

  async retained(): Promise<Record<string, number>> {
    await this.ready();
    const counts: Record<string, number> = {};
    for (const table of [
      'turn_runs',
      'turn_tool_marks',
      'turn_run_segments',
      'turn_run_plans',
      'channel_run_tombstones',
      'channel_requests',
    ]) {
      counts[table] = (await this.db!.get<{ n: number }>(
        `SELECT COUNT(*) AS n FROM ${table}`,
      ))!.n;
    }
    return counts;
  }

  async blockSessionCreation(blocked: boolean): Promise<void> {
    this.holdSessionCreation = blocked;
    if (!blocked)
      for (const release of this.pendingSessions.splice(0)) release();
  }

  async hostCalls(): Promise<{
    assertSession: number;
    changed: number;
    createSession: number;
  }> {
    return { ...this.calls };
  }

  async count(): Promise<number> {
    return (await this.ctx.storage.get<number>('executions')) ?? 0;
  }

  async reset(): Promise<void> {
    this.ctx.abort('channel test reset');
  }

  async reopen(): Promise<void> {
    await this.db?.close();
    this.db = undefined;
    this.runs = undefined;
    this.turns = undefined;
  }
}

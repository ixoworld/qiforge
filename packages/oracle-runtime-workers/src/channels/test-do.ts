import { DurableObject } from 'cloudflare:workers';
import { DoSqliteDatabase } from '../sqlite/database';
import type { TurnRequest } from '../do/contracts';
import { RunStore } from '../do/run-store';
import { planText } from '../delivery/schema';
import type { ReplyPlan } from '../delivery/types';
import { ChannelTurns } from './turns';
import {
  channelRequestHash,
  requireChannelDelegation,
  type ChannelTurnInput,
  type ChannelTurnOutcome,
  ChannelError,
} from './contract';

export class ChannelTurnsTestDO extends DurableObject {
  private db?: DoSqliteDatabase;
  private runs?: RunStore;
  private turns?: ChannelTurns;
  private nowMs = Date.now();

  private async ready(): Promise<ChannelTurns> {
    if (this.turns) return this.turns;
    this.db = await DoSqliteDatabase.open(this.ctx, 'channels-test.db');
    const db = this.db;
    this.runs = new RunStore(db, () => this.nowMs);
    await this.runs.setup();
    const runs = this.runs;
    this.turns = new ChannelTurns(db, {
      createSession: async (_identity, marker) => `$${marker}`,
      assertSession: async (_identity, sessionId) => {
        if (!sessionId.startsWith('$channel-session-'))
          throw new ChannelError(404, 'Session not owned');
        if ((await this.deletedSessions()).includes(sessionId))
          throw new ChannelError(404, 'Session deleted');
      },
      requireDelegation: async () =>
        requireChannelDelegation(
          (await this.ctx.storage.get<boolean>('delegation-revoked')) !== true,
        ),
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
      mirror: async (_request, _text, author) => {
        const key = `mirrors:${author}`;
        await this.ctx.storage.put(
          key,
          ((await this.ctx.storage.get<number>(key)) ?? 0) + 1,
        );
      },
      changed: () => this.ctx.storage.sync(),
    });
    return this.turns;
  }

  async submit(input: ChannelTurnInput): Promise<ChannelTurnOutcome> {
    try {
      const result = await (
        await this.ready()
      ).submit(
        {
          userDid: 'did:ixo:user',
          channel: {
            callerDid: 'did:web:channels.test',
            provider: input.provider,
            bindingId: input.bindingId,
            bindingRevision: input.bindingRevision,
          },
        },
        input,
        await channelRequestHash(JSON.stringify(input)),
      );
      return { ok: true, result };
    } catch (error) {
      if (error instanceof ChannelError)
        return { ok: false, status: error.status, message: error.message };
      throw error;
    }
  }

  async finish(runId: string, plan?: ReplyPlan): Promise<void> {
    await this.ready();
    if (plan) await this.runs!.setPlan(runId, JSON.stringify(plan));
    await this.runs!.update(runId, {
      status: 'finished',
      partialText: plan ? planText(plan) : 'One answer',
      messageId: 'message-1',
    });
  }

  /** What the user object's `onRunEnded` does for a finished channel run. */
  async deliverReply(runId: string): Promise<void> {
    const turns = await this.ready();
    const record = await this.runs!.get(runId);
    if (!record) throw new Error('No such run');
    const request: TurnRequest = JSON.parse(record.request);
    await turns.deliverReply(request, runId, record.partialText ?? '');
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

  private async deletedSessions(): Promise<string[]> {
    return (await this.ctx.storage.get<string[]>('deleted-sessions')) ?? [];
  }

  async revokeDelegation(): Promise<void> {
    await this.ctx.storage.put('delegation-revoked', true);
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

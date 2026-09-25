import { DurableObject } from 'cloudflare:workers';
import { DoSqliteDatabase } from '../sqlite/database';
import { RunStore } from '../do/run-store';
import { planText } from '../delivery/schema';
import type { ReplyPlan } from '../delivery/types';
import { ChannelTurns } from './turns';
import {
  channelRequestHash,
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
      mirror: async (_request, _text, _author) => undefined,
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

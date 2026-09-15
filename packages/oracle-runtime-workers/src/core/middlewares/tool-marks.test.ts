import { ToolMessage } from '@langchain/core/messages';
import { describe, expect, it } from 'vitest';
import type { ToolMark } from '../../do/run-store';
import {
  continuationNote,
  createToolMarksMiddleware,
  toolEffectOf,
  unknownOutcomeToolResult,
  type ToolMarkStore,
} from './tool-marks';

function fakeStore(seed: ToolMark[] = []) {
  const marks = new Map(seed.map((m) => [m.toolCallId, m]));
  const log: string[] = [];
  const store: ToolMarkStore = {
    async startMark(input) {
      const existing = marks.get(input.toolCallId);
      if (existing) return existing;
      marks.set(input.toolCallId, {
        runId: input.runId,
        toolCallId: input.toolCallId,
        toolName: input.toolName,
        effect: input.effect,
        startedAt: 'now',
        doneAt: null,
        outcome: null,
        attempts: 1,
      });
      log.push(`start:${input.toolCallId}`);
      return undefined;
    },
    async bumpMark(_runId, toolCallId) {
      const mark = marks.get(toolCallId)!;
      mark.attempts += 1;
      mark.doneAt = null;
      log.push(`bump:${toolCallId}`);
    },
    async finishMark(_runId, toolCallId, outcome) {
      const mark = marks.get(toolCallId)!;
      mark.doneAt = 'now';
      mark.outcome = outcome;
      log.push(`finish:${toolCallId}:${outcome}`);
    },
  };
  return { store, marks, log };
}

type WrapToolCall = NonNullable<
  ReturnType<typeof createToolMarksMiddleware>['wrapToolCall']
>;
type WrapModelCall = NonNullable<
  ReturnType<typeof createToolMarksMiddleware>['wrapModelCall']
>;

function requestFor(id: string, name: string) {
  return {
    toolCall: { id, name, args: {}, type: 'tool_call' as const },
    tool: undefined,
    state: {},
    runtime: {},
  } as unknown as Parameters<WrapToolCall>[0];
}

describe('toolEffectOf', () => {
  it('prefers the declaration, then MCP annotations, then the name convention', () => {
    expect(toolEffectOf({ name: 'send_money', effect: 'read' })).toBe('read');
    expect(
      toolEffectOf({
        name: 'memory__add_memory',
        annotations: { readOnlyHint: true },
      }),
    ).toBe('read');
    expect(toolEffectOf({ name: 'memory__search_memory_engine' })).toBe('read');
    expect(toolEffectOf({ name: 'list_my_tasks' })).toBe('read');
    expect(toolEffectOf({ name: 'vfs_grep' })).toBe('read');
    expect(toolEffectOf({ name: 'create_task' })).toBe('write');
    expect(toolEffectOf({ name: 'sandbox_run' })).toBe('write');
    expect(toolEffectOf({ name: 'call_research_agent' })).toBe('write');
  });
});

describe('ToolMarksMiddleware', () => {
  it('marks a first execution started then done', async () => {
    const { store, log } = fakeStore();
    const mw = createToolMarksMiddleware({
      runId: 'r1',
      store,
      effectOf: () => 'write',
    });
    const out = await (mw.wrapToolCall as WrapToolCall)(
      requestFor('c1', 'create_task'),
      async () => new ToolMessage({ tool_call_id: 'c1', content: 'ok' }),
    );
    expect(ToolMessage.isInstance(out)).toBe(true);
    expect(log).toEqual(['start:c1', 'finish:c1:ok']);
  });

  it('records an error outcome for a thrown tool and rethrows', async () => {
    const { store, log } = fakeStore();
    const mw = createToolMarksMiddleware({
      runId: 'r1',
      store,
      effectOf: () => 'write',
    });
    await expect(
      (mw.wrapToolCall as WrapToolCall)(requestFor('c2', 'x'), async () => {
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');
    expect(log).toEqual(['start:c2', 'finish:c2:error']);
  });

  it('never re-executes a started, unfinished write call on resume', async () => {
    const { store, log, marks } = fakeStore([
      {
        runId: 'r1',
        toolCallId: 'c3',
        toolName: 'create_task',
        effect: 'write',
        startedAt: 'earlier',
        doneAt: null,
        outcome: null,
        attempts: 1,
      },
    ]);
    const mw = createToolMarksMiddleware({
      runId: 'r1',
      store,
      effectOf: () => 'write',
    });
    let executed = false;
    const out = (await (mw.wrapToolCall as WrapToolCall)(
      requestFor('c3', 'create_task'),
      async () => {
        executed = true;
        return new ToolMessage({ tool_call_id: 'c3', content: 'ran' });
      },
    )) as ToolMessage;
    expect(executed).toBe(false);
    expect(out.status).toBe('error');
    expect(out.content).toBe(unknownOutcomeToolResult('create_task'));
    expect(marks.get('c3')?.outcome).toBe('interrupted');
    expect(log).toEqual(['finish:c3:interrupted']);
  });

  it('re-runs a started, unfinished read call and counts the attempt', async () => {
    const { store, log, marks } = fakeStore([
      {
        runId: 'r1',
        toolCallId: 'c4',
        toolName: 'list_my_tasks',
        effect: 'read',
        startedAt: 'earlier',
        doneAt: null,
        outcome: null,
        attempts: 1,
      },
    ]);
    const mw = createToolMarksMiddleware({
      runId: 'r1',
      store,
      effectOf: () => 'read',
    });
    let executed = 0;
    await (mw.wrapToolCall as WrapToolCall)(
      requestFor('c4', 'list_my_tasks'),
      async () => {
        executed += 1;
        return new ToolMessage({ tool_call_id: 'c4', content: '[]' });
      },
    );
    expect(executed).toBe(1);
    expect(marks.get('c4')?.attempts).toBe(2);
    expect(log).toEqual(['bump:c4', 'finish:c4:ok']);
  });

  it('adds the continuation note to the first model call only', async () => {
    const { store } = fakeStore();
    const mw = createToolMarksMiddleware({
      runId: 'r1',
      store,
      effectOf: () => 'write',
      continuation: 'The capital of France is',
    });
    const seen: number[] = [];
    const call = async () =>
      (mw.wrapModelCall as WrapModelCall)(
        { messages: [], model: {}, tools: [] } as never,
        async (req) => {
          seen.push((req as { messages: unknown[] }).messages.length);
          return { content: '' } as never;
        },
      );
    await call();
    await call();
    expect(seen).toEqual([1, 0]);
    expect(continuationNote('x'.repeat(2000))).toContain('…');
    expect(continuationNote('short')).toContain('"""short"""');
  });
});

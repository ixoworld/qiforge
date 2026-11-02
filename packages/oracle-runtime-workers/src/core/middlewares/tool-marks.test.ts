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
        sentAt: null,
      });
      log.push(`start:${input.toolCallId}`);
      return undefined;
    },
    async bumpMark(_runId, toolCallId) {
      const mark = marks.get(toolCallId)!;
      mark.attempts += 1;
      mark.doneAt = null;
      mark.sentAt = null;
      log.push(`bump:${toolCallId}`);
    },
    async markSent(_runId, toolCallId) {
      marks.get(toolCallId)!.sentAt = 'now';
      log.push(`sent:${toolCallId}`);
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

  it('reads the camelCase forms of the read verbs, and find', () => {
    expect(toolEffectOf({ name: 'getEntityProfileDomain' })).toBe('read');
    expect(toolEffectOf({ name: 'getResources' })).toBe('read');
    expect(toolEffectOf({ name: 'getOntology' })).toBe('read');
    expect(toolEffectOf({ name: 'findEntity' })).toBe('read');
    expect(toolEffectOf({ name: 'find_entity' })).toBe('read');
    expect(toolEffectOf({ name: 'listRooms' })).toBe('read');
    expect(toolEffectOf({ name: 'viewPage' })).toBe('read');
    // The verb must end at a word boundary of either convention.
    expect(toolEffectOf({ name: 'getter' })).toBe('write');
    expect(toolEffectOf({ name: 'finder' })).toBe('write');
    expect(toolEffectOf({ name: 'get' })).toBe('write');
    expect(toolEffectOf({ name: 'createEntity' })).toBe('write');
    expect(toolEffectOf({ name: 'mutate_topic' })).toBe('write');
    // A declaration still wins over the name.
    expect(toolEffectOf({ name: 'getAndDelete', effect: 'write' })).toBe(
      'write',
    );
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
        sentAt: null,
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
        sentAt: null,
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

  function frontendMark(
    toolCallId: string,
    toolName: string,
    effect: ToolMark['effect'],
    sentAt: string | null,
  ): ToolMark {
    return {
      runId: 'r1',
      toolCallId,
      toolName,
      effect,
      startedAt: 'earlier',
      doneAt: null,
      outcome: null,
      attempts: 1,
      sentAt,
    };
  }

  it('re-runs a frontend write that was parked and never sent', async () => {
    const { store, log, marks } = fakeStore([
      frontendMark('c5', 'mutate_topic', 'write', null),
    ]);
    const mw = createToolMarksMiddleware({
      runId: 'r1',
      store,
      effectOf: () => 'write',
      surfaceOf: (name) => (name === 'mutate_topic' ? 'frontend' : undefined),
    });
    let executed = 0;
    const out = (await (mw.wrapToolCall as WrapToolCall)(
      requestFor('c5', 'mutate_topic'),
      async () => {
        executed += 1;
        return new ToolMessage({ tool_call_id: 'c5', content: 'done' });
      },
    )) as ToolMessage;
    expect(executed).toBe(1);
    expect(out.content).toBe('done');
    expect(marks.get('c5')?.attempts).toBe(2);
    expect(marks.get('c5')?.outcome).toBe('ok');
    expect(log).toEqual(['bump:c5', 'finish:c5:ok']);
  });

  it('keeps the unknown outcome for a frontend write that was sent', async () => {
    const { store, log, marks } = fakeStore([
      frontendMark('c6', 'mutate_topic', 'write', 'earlier'),
    ]);
    const mw = createToolMarksMiddleware({
      runId: 'r1',
      store,
      effectOf: () => 'write',
      surfaceOf: () => 'frontend',
    });
    let executed = false;
    const out = (await (mw.wrapToolCall as WrapToolCall)(
      requestFor('c6', 'mutate_topic'),
      async () => {
        executed = true;
        return new ToolMessage({ tool_call_id: 'c6', content: 'ran' });
      },
    )) as ToolMessage;
    expect(executed).toBe(false);
    expect(out.status).toBe('error');
    expect(out.content).toBe(unknownOutcomeToolResult('mutate_topic'));
    expect(marks.get('c6')?.outcome).toBe('interrupted');
    expect(log).toEqual(['finish:c6:interrupted']);
  });

  it('re-runs a frontend read that was sent', async () => {
    const { store, log } = fakeStore([
      frontendMark('c7', 'getEntityProfileDomain', 'read', 'earlier'),
    ]);
    const mw = createToolMarksMiddleware({
      runId: 'r1',
      store,
      effectOf: () => 'read',
      surfaceOf: () => 'frontend',
    });
    let executed = 0;
    await (mw.wrapToolCall as WrapToolCall)(
      requestFor('c7', 'getEntityProfileDomain'),
      async () => {
        executed += 1;
        return new ToolMessage({ tool_call_id: 'c7', content: '{}' });
      },
    );
    expect(executed).toBe(1);
    expect(log).toEqual(['bump:c7', 'finish:c7:ok']);
  });

  it('does not re-run an unsent write of a tool that is not a frontend tool', async () => {
    const { store, log } = fakeStore([
      frontendMark('c8', 'create_task', 'write', null),
    ]);
    const mw = createToolMarksMiddleware({
      runId: 'r1',
      store,
      effectOf: () => 'write',
      surfaceOf: (name) => (name === 'mutate_topic' ? 'frontend' : undefined),
    });
    let executed = false;
    const out = (await (mw.wrapToolCall as WrapToolCall)(
      requestFor('c8', 'create_task'),
      async () => {
        executed = true;
        return new ToolMessage({ tool_call_id: 'c8', content: 'ran' });
      },
    )) as ToolMessage;
    expect(executed).toBe(false);
    expect(out.content).toBe(unknownOutcomeToolResult('create_task'));
    expect(log).toEqual(['finish:c8:interrupted']);
  });

  it('does not re-run a frontend write that already finished, sent or not', async () => {
    const { store, log } = fakeStore([
      { ...frontendMark('c9', 'mutate_topic', 'write', null), doneAt: 'x' },
    ]);
    const mw = createToolMarksMiddleware({
      runId: 'r1',
      store,
      effectOf: () => 'write',
      surfaceOf: () => 'frontend',
    });
    let executed = false;
    await (mw.wrapToolCall as WrapToolCall)(
      requestFor('c9', 'mutate_topic'),
      async () => {
        executed = true;
        return new ToolMessage({ tool_call_id: 'c9', content: 'ran' });
      },
    );
    expect(executed).toBe(false);
    expect(log).toEqual(['finish:c9:interrupted']);
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

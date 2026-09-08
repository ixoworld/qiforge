/**
 * Tasks plugin — the 10 tools over a fake `OracleTasksSurface`, the approval
 * gate's deterministic reply classification, and the plugin wiring.
 */
import { describe, expect, it } from 'vitest';
import { makeBuildCtx, makeRuntimeContext } from '../../core/test-fixtures';
import type {
  OracleTaskInput,
  OracleTaskRecord,
  OracleTasksSurface,
  PluginTool,
  RuntimeContext,
} from '../../plugin-api/types';
import type { TaskRecord } from '../../tasks/store';
import {
  classifyReplyFast,
  computeApprovalHint,
  lastHumanText,
  userDidFromContext,
} from './middleware';
import { createTaskTools } from './tasks-tools';
import { createTasksPlugin, TasksPlugin } from './tasks.plugin';
import { HumanMessage, AIMessage } from '@langchain/core/messages';

const EXPECTED_TOOL_NAMES = [
  'preview_task',
  'create_task',
  'list_my_tasks',
  'get_task',
  'update_task',
  'pause_task',
  'resume_task',
  'cancel_task',
  'resolve_task_approval',
  'suggest_spec_fix',
];

let idSeq = 0;

function makeRecord(
  input: OracleTaskInput,
  overrides: Partial<TaskRecord> = {},
): TaskRecord {
  const now = new Date().toISOString();
  return {
    id: `task_test_000000${(idSeq++ % 10).toString()}a`,
    title: input.title,
    intent: input.intent,
    schedule: input.schedule,
    status: 'active',
    approval: input.approval ?? 'never',
    createdAt: now,
    updatedAt: now,
    nextRunAt: '2027-01-01T00:00:00.000Z',
    consecutiveFailures: 0,
    ...overrides,
  };
}

class FakeSurface implements OracleTasksSurface {
  records = new Map<string, TaskRecord>();
  resolveCalls: Array<{ taskId: string; decision: string; note?: string }> = [];
  failCreateWith: string | null = null;

  seed(record: TaskRecord): TaskRecord {
    this.records.set(record.id, record);
    return record;
  }

  async preview(): Promise<{
    ok: boolean;
    nextRuns: string[];
    problems: string[];
  }> {
    return { ok: true, nextRuns: ['2027-01-01T00:00:00.000Z'], problems: [] };
  }

  async create(input: OracleTaskInput): Promise<OracleTaskRecord> {
    if (this.failCreateWith) throw new Error(this.failCreateWith);
    return this.seed(makeRecord(input));
  }

  async list(): Promise<OracleTaskRecord[]> {
    return [...this.records.values()];
  }

  async get(id: string): Promise<OracleTaskRecord | null> {
    return this.records.get(id) ?? null;
  }

  async update(
    id: string,
    patch: Partial<OracleTaskInput>,
  ): Promise<OracleTaskRecord> {
    const record = this.records.get(id);
    if (!record) throw new Error('Task not found.');
    Object.assign(record, patch);
    return record;
  }

  async pause(id: string): Promise<OracleTaskRecord> {
    return this.setStatus(id, 'paused');
  }

  async resume(id: string): Promise<OracleTaskRecord> {
    return this.setStatus(id, 'active');
  }

  async cancel(id: string): Promise<OracleTaskRecord> {
    return this.setStatus(id, 'cancelled');
  }

  private setStatus(
    id: string,
    status: OracleTaskRecord['status'],
  ): OracleTaskRecord {
    const record = this.records.get(id);
    if (!record) throw new Error('Task not found.');
    record.status = status;
    return record;
  }

  async resolveApproval(
    taskId: string,
    decision: 'approve' | 'reject',
    note?: string,
  ): Promise<{ resolved: boolean }> {
    this.resolveCalls.push({ taskId, decision, ...(note ? { note } : {}) });
    const record = this.records.get(taskId);
    if (!record || record.pendingApprovalAt === undefined) {
      return { resolved: false };
    }
    delete record.pendingApprovalAt;
    return { resolved: true };
  }
}

function toolByName(name: string): PluginTool {
  const found = createTaskTools().find((t) => t.name === name);
  if (!found) throw new Error(`tool ${name} not found`);
  return found;
}

function ctxWith(surface?: OracleTasksSurface): RuntimeContext {
  return surface
    ? makeRuntimeContext({ tasks: surface })
    : makeRuntimeContext();
}

function asRecord(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('expected an object result');
  }
  return Object.fromEntries(Object.entries(value));
}

const cronInput: OracleTaskInput = {
  title: 'Morning Brief',
  intent: 'Summarize the news.',
  schedule: { kind: 'cron', cron: '0 7 * * *', timezone: 'UTC' },
};

describe('task tools', () => {
  it('exposes exactly the 10 task tools', () => {
    expect(createTaskTools().map((t) => t.name)).toEqual(EXPECTED_TOOL_NAMES);
  });

  it('every tool degrades cleanly when the host provides no scheduler', async () => {
    const result = asRecord(
      await toolByName('list_my_tasks').handler({}, ctxWith()),
    );
    expect(result.ok).toBe(false);
    expect(String(result.error)).toMatch(/not available/);
  });

  it('preview_task returns next runs plus a stop-and-confirm note', async () => {
    const surface = new FakeSurface();
    const result = asRecord(
      await toolByName('preview_task').handler(cronInput, ctxWith(surface)),
    );
    expect(result.ok).toBe(true);
    expect(result.nextRuns).toEqual(['2027-01-01T00:00:00.000Z']);
    expect(String(result.note)).toMatch(/create_task/);
  });

  it('create_task creates through the surface and points at the room', async () => {
    const surface = new FakeSurface();
    const result = asRecord(
      await toolByName('create_task').handler(cronInput, ctxWith(surface)),
    );
    expect(result.ok).toBe(true);
    expect(typeof result.taskId).toBe('string');
    expect(result.schedule).toBe('cron `0 7 * * *` (UTC)');
    expect(String(result.note)).toMatch(/oracle chat room/);
    expect(surface.records.size).toBe(1);
  });

  it('create_task surfaces validation errors instead of throwing', async () => {
    const surface = new FakeSurface();
    surface.failCreateWith =
      'Task limit reached (50). Cancel an existing task first.';
    const result = asRecord(
      await toolByName('create_task').handler(cronInput, ctxWith(surface)),
    );
    expect(result).toEqual({
      ok: false,
      error: 'Task limit reached (50). Cancel an existing task first.',
    });
  });

  it('list_my_tasks filters by status and flags pending approvals', async () => {
    const surface = new FakeSurface();
    const active = surface.seed(makeRecord(cronInput));
    surface.seed(
      makeRecord(
        { ...cronInput, title: 'Paused one' },
        { status: 'paused', id: 'task_paused_00000000' },
      ),
    );
    surface.seed(
      makeRecord(
        { ...cronInput, title: 'Waiting one', approval: 'before-action' },
        {
          id: 'task_waiting_00000000',
          pendingApprovalAt: '2026-08-26T00:00:00.000Z',
        },
      ),
    );

    const all = asRecord(
      await toolByName('list_my_tasks').handler({}, ctxWith(surface)),
    );
    expect(all.count).toBe(3);

    const activeOnly = asRecord(
      await toolByName('list_my_tasks').handler(
        { status: ['active'] },
        ctxWith(surface),
      ),
    );
    expect(activeOnly.count).toBe(2);
    const rows = activeOnly.tasks;
    if (!Array.isArray(rows)) throw new Error('expected tasks array');
    const waiting = rows
      .map(asRecord)
      .find((r) => r.taskId === 'task_waiting_00000000');
    expect(waiting?.awaitingApprovalSince).toBe('2026-08-26T00:00:00.000Z');
    const plain = rows.map(asRecord).find((r) => r.taskId === active.id);
    expect(plain?.awaitingApprovalSince).toBeUndefined();
  });

  it('get_task returns the full record and update_task patches it', async () => {
    const surface = new FakeSurface();
    const record = surface.seed(makeRecord(cronInput));

    const got = asRecord(
      await toolByName('get_task').handler(
        { taskId: record.id },
        ctxWith(surface),
      ),
    );
    expect(got.ok).toBe(true);
    expect(got.intent).toBe('Summarize the news.');
    expect(got.consecutiveFailures).toBe(0);

    const missing = asRecord(
      await toolByName('get_task').handler(
        { taskId: 'task_missing_00000000' },
        ctxWith(surface),
      ),
    );
    expect(missing).toEqual({ ok: false, error: 'Task not found.' });

    const updated = asRecord(
      await toolByName('update_task').handler(
        { taskId: record.id, intent: 'Summarize sports news.' },
        ctxWith(surface),
      ),
    );
    expect(updated.ok).toBe(true);
    expect(record.intent).toBe('Summarize sports news.');
  });

  it('pause/resume/cancel map through the surface and report errors', async () => {
    const surface = new FakeSurface();
    const record = surface.seed(makeRecord(cronInput));

    const paused = asRecord(
      await toolByName('pause_task').handler(
        { taskId: record.id },
        ctxWith(surface),
      ),
    );
    expect(paused).toMatchObject({ ok: true, status: 'paused' });

    const resumed = asRecord(
      await toolByName('resume_task').handler(
        { taskId: record.id },
        ctxWith(surface),
      ),
    );
    expect(resumed).toMatchObject({ ok: true, status: 'active' });

    const cancelled = asRecord(
      await toolByName('cancel_task').handler(
        { taskId: record.id },
        ctxWith(surface),
      ),
    );
    expect(cancelled).toMatchObject({ ok: true, status: 'cancelled' });

    const missing = asRecord(
      await toolByName('cancel_task').handler(
        { taskId: 'task_missing_00000000' },
        ctxWith(surface),
      ),
    );
    expect(missing).toEqual({ ok: false, error: 'Task not found.' });
  });

  it('resolve_task_approval records the decision with the note', async () => {
    const surface = new FakeSurface();
    const record = surface.seed(
      makeRecord(
        { ...cronInput, approval: 'before-action' },
        { pendingApprovalAt: '2026-08-26T00:00:00.000Z' },
      ),
    );

    const approved = asRecord(
      await toolByName('resolve_task_approval').handler(
        { taskId: record.id, outcome: 'approved', note: 'fix the title' },
        ctxWith(surface),
      ),
    );
    expect(approved.ok).toBe(true);
    expect(String(approved.note)).toMatch(/executed/);
    expect(surface.resolveCalls).toEqual([
      { taskId: record.id, decision: 'approve', note: 'fix the title' },
    ]);

    const again = asRecord(
      await toolByName('resolve_task_approval').handler(
        { taskId: record.id, outcome: 'declined' },
        ctxWith(surface),
      ),
    );
    expect(again).toEqual({
      ok: false,
      error: 'No approval is pending for this task.',
    });
  });

  it('suggest_spec_fix reports the failing intent or that nothing is wrong', async () => {
    const surface = new FakeSurface();
    const healthy = surface.seed(makeRecord(cronInput));
    const failing = surface.seed(
      makeRecord(
        { ...cronInput, title: 'Broken' },
        {
          id: 'task_broken_00000000',
          consecutiveFailures: 2,
          lastResult: {
            ok: false,
            summary: 'HTTP 500 from upstream',
            at: '2026-08-26T00:00:00.000Z',
          },
        },
      ),
    );

    const nothing = asRecord(
      await toolByName('suggest_spec_fix').handler(
        { taskId: healthy.id },
        ctxWith(surface),
      ),
    );
    expect(nothing.proposal).toBeNull();
    expect(String(nothing.note)).toMatch(/nothing to fix/i);

    const fix = asRecord(
      await toolByName('suggest_spec_fix').handler(
        { taskId: failing.id },
        ctxWith(surface),
      ),
    );
    expect(fix.ok).toBe(true);
    expect(fix.currentIntent).toBe('Summarize the news.');
    expect(fix.lastError).toBe('HTTP 500 from upstream');
    expect(fix.consecutiveFailures).toBe(2);
    expect(String(fix.instruction)).toMatch(/update_task/);
  });
});

describe('approval gate', () => {
  it('classifyReplyFast is exact-match only', () => {
    expect(classifyReplyFast('Yes.')).toBe('approved');
    expect(classifyReplyFast('  go ahead!! ')).toBe('approved');
    expect(classifyReplyFast('SHIP IT')).toBe('approved');
    expect(classifyReplyFast('nope')).toBe('rejected');
    expect(classifyReplyFast("Don't send")).toBe('rejected');
    expect(classifyReplyFast('ok so what does this do')).toBe('other');
    expect(classifyReplyFast('yes but change the title')).toBe('other');
  });

  it('computeApprovalHint is silent without pending approvals', async () => {
    const surface = new FakeSurface();
    surface.seed(makeRecord(cronInput));
    expect(await computeApprovalHint(surface, 'yes')).toBeUndefined();
  });

  it('computeApprovalHint gives a strong hint for a plain yes/no on one pending task', async () => {
    const surface = new FakeSurface();
    const record = surface.seed(
      makeRecord(
        { ...cronInput, approval: 'before-action' },
        { pendingApprovalAt: '2026-08-26T00:00:00.000Z' },
      ),
    );
    const approve = await computeApprovalHint(surface, 'yes');
    expect(approve).toContain('APPROVES');
    expect(approve).toContain(record.id);
    const reject = await computeApprovalHint(surface, 'no');
    expect(reject).toContain('DECLINES');
    const nuanced = await computeApprovalHint(
      surface,
      'fix the title then send',
    );
    expect(nuanced).toContain('waiting for the user');
    expect(nuanced).toContain(record.id);
  });

  it('computeApprovalHint falls back to the listing hint for multiple pending tasks', async () => {
    const surface = new FakeSurface();
    surface.seed(
      makeRecord(
        { ...cronInput, title: 'A', approval: 'before-action' },
        {
          id: 'task_a_00000000',
          pendingApprovalAt: '2026-08-26T00:00:00.000Z',
        },
      ),
    );
    surface.seed(
      makeRecord(
        { ...cronInput, title: 'B', approval: 'before-action' },
        {
          id: 'task_b_00000000',
          pendingApprovalAt: '2026-08-26T00:00:00.000Z',
        },
      ),
    );
    const hint = await computeApprovalHint(surface, 'yes');
    expect(hint).toContain('2 task run(s)');
    expect(hint).toContain('task_a_00000000');
    expect(hint).toContain('task_b_00000000');
    expect(hint).not.toContain('APPROVES');
  });

  it('userDidFromContext and lastHumanText read defensively', () => {
    expect(
      userDidFromContext({ user: { did: 'did:ixo:u1' }, session: { id: 's' } }),
    ).toBe('did:ixo:u1');
    expect(userDidFromContext({ user: {} })).toBeUndefined();
    expect(userDidFromContext(null)).toBeUndefined();
    expect(userDidFromContext('nope')).toBeUndefined();

    expect(
      lastHumanText([
        new HumanMessage('first'),
        new AIMessage('draft posted'),
        new HumanMessage('yes'),
      ]),
    ).toBe('yes');
    expect(lastHumanText([new AIMessage('only ai')])).toBeNull();
    expect(
      lastHumanText([
        new HumanMessage({ content: [{ type: 'text', text: 'go ahead' }] }),
      ]),
    ).toBe('go ahead');
  });
});

describe('plugin wiring', () => {
  it('declares identity, config schema and always-on autoDetect', () => {
    expect(TasksPlugin.name).toBe('tasks');
    expect(TasksPlugin.manifest.title).toBe('Scheduled Tasks');
    expect(TasksPlugin.autoDetect?.({})).toBe(true);
    const parsed = TasksPlugin.configSchema?.parse({});
    expect(parsed).toEqual({
      TASKS_MAX_PER_USER: 50,
      TASKS_MIN_CRON_INTERVAL_SEC: 300,
    });
  });

  it('contributes the 10 tools and the approval-gate middleware', async () => {
    const plugin = createTasksPlugin();
    const buildCtx = makeBuildCtx();
    const tools = await plugin.getTools?.(buildCtx);
    expect(tools?.map((t) => t.name)).toEqual(EXPECTED_TOOL_NAMES);
    const middlewares = plugin.getMiddlewares?.(buildCtx);
    expect(middlewares).toHaveLength(1);
    expect(middlewares?.[0]?.name).toBe('TaskApprovalGateMiddleware');
  });

  it('getRequestTools stashes the per-user surface and contributes no tools', async () => {
    const plugin = createTasksPlugin();
    const surface = new FakeSurface();
    const withTasks = await plugin.getRequestTools?.(
      makeRuntimeContext({ tasks: surface }),
    );
    expect(withTasks).toEqual([]);
    const withoutTasks = await plugin.getRequestTools?.(makeRuntimeContext());
    expect(withoutTasks).toEqual([]);
  });
});

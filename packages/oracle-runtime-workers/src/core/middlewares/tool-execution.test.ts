import { ToolMessage } from '@langchain/core/messages';
import { describe, expect, it } from 'vitest';
import { ToolScheduler } from '../tool-scheduler';
import { HarnessLimitError, TurnBudget } from '../turn-budget';
import {
  canonicalArguments,
  createToolExecutionMiddleware,
  isUncertainOutcome,
  operationKey,
  uncertainWriteToolResult,
  type WriteClaimStore,
} from './tool-execution';

/** The ledger's claim rules (run-store.ts), in memory. */
function fakeClaims() {
  const rows = new Map<
    string,
    { toolName: string; runId: string; state: 'pending' | 'warned' }
  >();
  const log: string[] = [];
  const store: WriteClaimStore = {
    async claimWrite(input) {
      const existing = rows.get(input.fingerprint);
      if (!existing) {
        rows.set(input.fingerprint, {
          toolName: input.toolName,
          runId: input.runId,
          state: 'pending',
        });
        log.push(`claim:${input.toolName}`);
        return { status: 'claimed' };
      }
      if (existing.state === 'warned' && existing.runId !== input.runId) {
        rows.set(input.fingerprint, {
          toolName: input.toolName,
          runId: input.runId,
          state: 'pending',
        });
        log.push(`reclaim:${input.toolName}`);
        return { status: 'claimed' };
      }
      if (existing.state === 'pending') {
        existing.state = 'warned';
        existing.runId = input.runId;
      }
      log.push(`blocked:${input.toolName}`);
      return { status: 'blocked', toolName: existing.toolName, since: 't0' };
    },
    async releaseWrite(fingerprint, runId) {
      const existing = rows.get(fingerprint);
      if (existing && existing.runId === runId) rows.delete(fingerprint);
      log.push(`release:${existing?.toolName ?? '?'}`);
    },
  };
  return { store, rows, log };
}

type WrapToolCall = NonNullable<
  ReturnType<typeof createToolExecutionMiddleware>['wrapToolCall']
>;

function requestFor(name: string, args: Record<string, unknown> = {}) {
  return {
    toolCall: { id: `call_${name}`, name, args, type: 'tool_call' as const },
    tool: undefined,
    state: {},
    runtime: {},
  } as unknown as Parameters<WrapToolCall>[0];
}

const okResult = (name: string) =>
  new ToolMessage({ tool_call_id: `call_${name}`, name, content: 'ok' });

function middlewareFor(
  overrides: Partial<Parameters<typeof createToolExecutionMiddleware>[0]> = {},
) {
  const budget = new TurnBudget(
    { tokens: 1_000_000, tools: 5, durationMs: 60_000 },
    () => 0,
  );
  const claims = fakeClaims();
  const middleware = createToolExecutionMiddleware({
    budget,
    scheduler: new ToolScheduler(),
    laneOf: (name) =>
      name.startsWith('call_')
        ? 'subagent'
        : name.startsWith('get_')
          ? 'read'
          : 'write',
    runId: 'run-1',
    sessionId: 'session-1',
    claims: claims.store,
    ...overrides,
  });
  const wrap = middleware.wrapToolCall as WrapToolCall;
  return { budget, claims, wrap };
}

describe('operationKey', () => {
  it('fingerprints the tool name and canonical arguments', async () => {
    expect(
      canonicalArguments({ b: [1, { d: 2, c: 3 }], a: 'x', u: undefined }),
    ).toBe('{"a":"x","b":[1,{"c":3,"d":2}]}');
    const one = await operationKey('send', { to: 'a', text: 'hi' });
    const same = await operationKey('send', { text: 'hi', to: 'a' });
    const other = await operationKey('send', { to: 'a', text: 'hi!' });
    expect(one).toMatch(/^[a-f0-9]{64}$/);
    expect(same).toBe(one);
    expect(other).not.toBe(one);
  });
});

describe('isUncertainOutcome', () => {
  it('is true for aborts, deadlines, transport failures and server errors', () => {
    expect(
      isUncertainOutcome(
        new HarnessLimitError('budget_exhausted', 'time', 'x'),
      ),
    ).toBe(true);
    expect(
      isUncertainOutcome(Object.assign(new Error('x'), { name: 'AbortError' })),
    ).toBe(true);
    expect(isUncertainOutcome(new TypeError('fetch failed'))).toBe(true);
    expect(
      isUncertainOutcome(
        Object.assign(new Error('Bad Gateway'), { status: 502 }),
      ),
    ).toBe(true);
    const controller = new AbortController();
    controller.abort();
    expect(isUncertainOutcome(new Error('anything'), controller.signal)).toBe(
      true,
    );
  });

  it('is false for a failure the service reported', () => {
    expect(isUncertainOutcome(new Error('invalid recipient'))).toBe(false);
    expect(
      isUncertainOutcome(
        Object.assign(new Error('Unauthorized'), { status: 401 }),
      ),
    ).toBe(false);
    expect(
      isUncertainOutcome(
        Object.assign(new Error('Too Many Requests'), { status: 429 }),
      ),
    ).toBe(false);
    expect(isUncertainOutcome('not an error')).toBe(false);
  });
});

describe('createToolExecutionMiddleware', () => {
  it('charges every call to the budget and refuses the one past the limit', async () => {
    const { budget, wrap } = middlewareFor();
    for (let i = 0; i < 5; i += 1)
      await wrap(requestFor('get_thing'), async () => okResult('get_thing'));
    expect(budget.snapshot().toolAttempts).toBe(5);
    await expect(
      wrap(requestFor('get_thing'), async () => okResult('get_thing')),
    ).rejects.toThrow(HarnessLimitError);
  });

  it('claims a write and releases it on a returned outcome', async () => {
    const { claims, wrap } = middlewareFor();
    const out = await wrap(requestFor('send_message', { to: 'a' }), async () =>
      okResult('send_message'),
    );
    expect(out).toMatchObject({ content: 'ok' });
    expect(claims.log).toEqual(['claim:send_message', 'release:send_message']);
    expect(claims.rows.size).toBe(0);
  });

  it('releases the claim on a failure the service reported, keeps it on an uncertain one', async () => {
    const { claims, wrap } = middlewareFor();
    await expect(
      wrap(requestFor('send_message', { to: 'a' }), async () => {
        throw new Error('invalid recipient');
      }),
    ).rejects.toThrow('invalid recipient');
    expect(claims.rows.size).toBe(0);
    await expect(
      wrap(requestFor('send_message', { to: 'b' }), async () => {
        throw new TypeError('fetch failed');
      }),
    ).rejects.toThrow('fetch failed');
    expect(claims.rows.size).toBe(1);
    expect([...claims.rows.values()][0]).toMatchObject({
      toolName: 'send_message',
      state: 'pending',
    });
  });

  it('does not run an identical write while its outcome is unknown, and tells the model', async () => {
    const { claims, wrap } = middlewareFor();
    await Promise.resolve(
      wrap(requestFor('send_message', { to: 'b' }), async () => {
        throw new TypeError('fetch failed');
      }),
    ).catch(() => undefined);
    let ran = false;
    const out = await wrap(
      requestFor('send_message', { to: 'b' }),
      async () => {
        ran = true;
        return okResult('send_message');
      },
    );
    expect(ran).toBe(false);
    expect(out).toBeInstanceOf(ToolMessage);
    expect(out).toMatchObject({
      status: 'error',
      content: uncertainWriteToolResult('send_message'),
    });
    expect(claims.log.at(-1)).toBe('blocked:send_message');
    // A different write is unaffected.
    await wrap(requestFor('send_message', { to: 'c' }), async () =>
      okResult('send_message'),
    );
    expect(claims.log.at(-1)).toBe('release:send_message');
  });

  it('runs the write again for a later turn that asks after the warning', async () => {
    const shared = fakeClaims();
    const first = middlewareFor({ claims: shared.store, runId: 'run-1' });
    await Promise.resolve(
      first.wrap(requestFor('send_message', { to: 'b' }), async () => {
        throw new TypeError('fetch failed');
      }),
    ).catch(() => undefined);
    const second = middlewareFor({ claims: shared.store, runId: 'run-2' });
    const blocked = await second.wrap(
      requestFor('send_message', { to: 'b' }),
      async () => okResult('send_message'),
    );
    expect(blocked).toMatchObject({ status: 'error' });
    // Same turn again: still blocked.
    const again = await second.wrap(
      requestFor('send_message', { to: 'b' }),
      async () => okResult('send_message'),
    );
    expect(again).toMatchObject({ status: 'error' });
    const third = middlewareFor({ claims: shared.store, runId: 'run-3' });
    let ran = false;
    await third.wrap(requestFor('send_message', { to: 'b' }), async () => {
      ran = true;
      return okResult('send_message');
    });
    expect(ran).toBe(true);
    expect(shared.rows.size).toBe(0);
  });

  it('never claims reads or sub-agent dispatches', async () => {
    const { claims, wrap } = middlewareFor();
    await wrap(requestFor('get_thing'), async () => okResult('get_thing'));
    await wrap(requestFor('call_research_agent', { task: 'x' }), async () =>
      okResult('call_research_agent'),
    );
    expect(claims.log).toEqual([]);
  });

  it('serializes writes through the scheduler but lets reads overlap', async () => {
    const { wrap } = middlewareFor();
    const order: string[] = [];
    let release!: () => void;
    const hold = new Promise<void>((resolve) => {
      release = resolve;
    });
    const a = wrap(requestFor('send_message', { to: 'a' }), async () => {
      order.push('a');
      await hold;
      return okResult('send_message');
    });
    const b = wrap(requestFor('send_message', { to: 'b' }), async () => {
      order.push('b');
      return okResult('send_message');
    });
    const r = wrap(requestFor('get_thing'), async () => {
      order.push('read');
      return okResult('get_thing');
    });
    // The write fingerprints its arguments (async) before it starts.
    for (let i = 0; i < 50 && !order.includes('a'); i += 1)
      await new Promise((resolve) => setTimeout(resolve, 1));
    await new Promise((resolve) => setTimeout(resolve, 5));
    // The read overlapped the first write; the second write waited for it.
    expect([...order].sort()).toEqual(['a', 'read']);
    release();
    await Promise.all([a, b, r]);
    expect(order.at(-1)).toBe('b');
  });

  it('is refused outright once the turn is aborted', async () => {
    const controller = new AbortController();
    const { wrap } = middlewareFor({ signal: controller.signal });
    const reason = new HarnessLimitError(
      'budget_exhausted',
      'time',
      'deadline',
    );
    controller.abort(reason);
    await expect(
      wrap(requestFor('get_thing'), async () => okResult('get_thing')),
    ).rejects.toBe(reason);
  });
});

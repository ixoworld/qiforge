import { frontendOutcomeUnknown } from '@ixo/common/ai/frontend-bridge';
import { ToolMessage } from '@langchain/core/messages';
import { describe, expect, it, vi } from 'vitest';
import { ProviderStallError } from '../../llm/stream-liveness';
import { ToolScheduler } from '../tool-scheduler';
import { HarnessLimitError, TurnBudget } from '../turn-budget';
import {
  canonicalArguments,
  createToolExecutionMiddleware,
  isUncertainOutcome,
  operationKey,
  uncertainResultReason,
  uncertainWriteToolResult,
} from './tool-execution';
import { makeClaimStore } from '../test-fixtures';
import {
  FrontendCallNotSentError,
  FrontendCallRegistry,
  OPEN_CHAT_HINT,
} from '../../realtime/frontend-call-registry';

type WrapToolCall = NonNullable<
  ReturnType<typeof createToolExecutionMiddleware>['wrapToolCall']
>;

function requestFor(
  name: string,
  args: Record<string, unknown> = {},
): Parameters<WrapToolCall>[0] {
  return {
    toolCall: { id: `call_${name}`, name, args, type: 'tool_call' },
    tool: undefined,
    state: { messages: [] },
    runtime: {},
  };
}

const okResult = (name: string) =>
  new ToolMessage({ tool_call_id: `call_${name}`, name, content: 'ok' });

function middlewareFor(
  overrides: Partial<Parameters<typeof createToolExecutionMiddleware>[0]> = {},
) {
  const budget = new TurnBudget({ tools: 5, durationMs: 60_000 }, () => 0);
  const claims = makeClaimStore();
  const middleware = createToolExecutionMiddleware({
    budget,
    scheduler: new ToolScheduler(),
    laneOf: (name) =>
      name.startsWith('call_')
        ? 'subagent'
        : name.startsWith('get_')
          ? 'read'
          : 'write',
    effectOf: (name) => (name.startsWith('get_') ? 'read' : 'write'),
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

  it('names the session for a frontend write: the same call in two chats is two actions', async () => {
    const plain = await operationKey('show_card', { id: 'a' });
    const one = await operationKey('show_card', { id: 'a' }, 's1');
    const again = await operationKey('show_card', { id: 'a' }, 's1');
    const two = await operationKey('show_card', { id: 'a' }, 's2');
    expect(again).toBe(one);
    expect(two).not.toBe(one);
    expect(one).not.toBe(plain);
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
        Object.assign(new Error('read failed'), { code: 'ECONNRESET' }),
      ),
    ).toBe(true);
    expect(isUncertainOutcome(new Error('Network connection lost.'))).toBe(
      true,
    );
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

  it('is true for a tool whose own model call stalled, wrapped or not', () => {
    const stall = new ProviderStallError({
      phase: 'stream',
      idleMs: 90_000,
      elapsedMs: 100_000,
      bytesSeen: 10,
      label: 'openrouter subagent m',
    });
    expect(isUncertainOutcome(stall)).toBe(true);
    expect(
      isUncertainOutcome(new Error('Connection error.', { cause: stall })),
    ).toBe(true);
  });

  it('is false for a frontend call that was never sent, even on an aborted turn and when wrapped', () => {
    const notSent = new FrontendCallNotSentError(
      'aborted',
      'Browser tool mutate_topic was not sent: the turn was aborted',
    );
    const controller = new AbortController();
    controller.abort();
    expect(isUncertainOutcome(notSent, controller.signal)).toBe(false);
    const deadline = new FrontendCallNotSentError(
      'park-deadline',
      `Browser tool mutate_topic was not sent: no browser joined session s1 within 300 s. ${OPEN_CHAT_HINT}`,
    );
    expect(isUncertainOutcome(deadline)).toBe(false);
    // LangChain's middleware error keeps the original as `cause`.
    expect(
      isUncertainOutcome(
        new Error(deadline.message, { cause: deadline }),
        controller.signal,
      ),
    ).toBe(false);
    // The texts would not read as uncertain either, typed or not.
    expect(isUncertainOutcome(new Error(deadline.message))).toBe(false);
    expect(isUncertainOutcome(new Error(notSent.message))).toBe(false);
  });

  it('is false for a failure the service reported', () => {
    expect(isUncertainOutcome(new Error('invalid recipient'))).toBe(false);
    // Definite refusals that merely contain a transport-sounding word.
    expect(isUncertainOutcome(new Error("network 'base' not supported"))).toBe(
      false,
    );
    expect(isUncertainOutcome(new Error('invalid timeout: -1'))).toBe(false);
    expect(isUncertainOutcome(new Error('payment aborted by the user'))).toBe(
      false,
    );
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

describe('uncertainResultReason', () => {
  const result = (
    content: string,
    status: 'success' | 'error' = 'success',
  ): ToolMessage =>
    new ToolMessage({ tool_call_id: 'c', name: 'w', content, status });

  it('keeps the claim for a frontend call whose outcome is unknown', () => {
    // The bridge's deadline / lost-socket result: the browser may have
    // written, so an identical write must not run again unverified.
    expect(
      uncertainResultReason(
        result(JSON.stringify(frontendOutcomeUnknown('tc-req:inv'))),
      ),
    ).toBe('outcome unknown');
    // A client that cannot tell whether its own write landed.
    expect(
      uncertainResultReason(
        result(JSON.stringify({ success: false, outcome: 'unknown' })),
      ),
    ).toBe('outcome unknown');
    // A definite refusal from the browser is a known outcome.
    expect(
      uncertainResultReason(
        result(JSON.stringify({ success: false, error: 'Permission denied' })),
      ),
    ).toBeNull();
  });

  it('names the reason when an error-shaped result reports a timeout, a transport failure or a 5xx', () => {
    // The flows plugin's catch-all around a dropped connection.
    expect(
      uncertainResultReason(
        result(
          JSON.stringify({
            ok: false,
            error: { code: 'error', message: 'fetch failed' },
          }),
        ),
      ),
    ).toBe('fetch failed');
    // The editor's undelivered write: a send that failed with a server
    // error may still have landed.
    expect(
      uncertainResultReason(
        result(
          JSON.stringify({
            ok: false,
            code: 'write_not_saved',
            message: 'The edit was NOT saved.',
          }),
        ),
      ),
    ).toBe('write_not_saved');
    expect(
      uncertainResultReason(
        result(JSON.stringify({ successful: false, error: 'Bad Gateway' })),
      ),
    ).toBe('Bad Gateway');
    expect(
      uncertainResultReason(
        result(JSON.stringify({ error: 'upstream', statusCode: 503 })),
      ),
    ).toBe('server error');
    expect(
      uncertainResultReason(result('Error: request timed out after 30s')),
    ).toBe('timed out');
    expect(
      uncertainResultReason(result('socket hang up while sending', 'error')),
    ).toBe('socket hang up');
    expect(
      uncertainResultReason(result('Error: upstream answered HTTP 503')),
    ).toBe('HTTP 503');
    expect(
      uncertainResultReason(
        result(
          JSON.stringify({
            ok: false,
            error: { name: 'TimeoutError', message: 'deadline' },
          }),
        ),
      ),
    ).toBe('TimeoutError');
  });

  it('is null for a definite refusal that merely contains a transport-sounding word', () => {
    // A write whose claim stayed for one of these would refuse the next
    // identical write as outcome-unknown although nothing happened.
    expect(
      uncertainResultReason(
        result("Error: network 'base' not supported", 'error'),
      ),
    ).toBeNull();
    expect(
      uncertainResultReason(
        result(
          JSON.stringify({
            ok: false,
            error: "network 'base' not supported; use 'ixo'",
          }),
        ),
      ),
    ).toBeNull();
    expect(
      uncertainResultReason(result('Error: invalid timeout value', 'error')),
    ).toBeNull();
    expect(
      uncertainResultReason(
        result('Failed: the transfer was aborted by the user', 'error'),
      ),
    ).toBeNull();
    expect(
      uncertainResultReason(
        result(
          JSON.stringify({
            success: false,
            error: 'status 400: bad network id',
          }),
        ),
      ),
    ).toBeNull();
  });

  it('is null for a success and for a failure the service reported', () => {
    expect(uncertainResultReason(result('ok'))).toBeNull();
    // Success that happens to mention a timeout.
    expect(
      uncertainResultReason(result('Reminder set: timeout in 5 minutes')),
    ).toBeNull();
    expect(
      uncertainResultReason(
        result(JSON.stringify({ ok: true, note: 'retried after a timeout' })),
      ),
    ).toBeNull();
    expect(
      uncertainResultReason(
        result(
          JSON.stringify({
            ok: false,
            error: { code: 'validation_failed', message: 'Step name taken' },
          }),
        ),
      ),
    ).toBeNull();
    expect(
      uncertainResultReason(
        result(JSON.stringify({ error: 'Not found', status: 404 })),
      ),
    ).toBeNull();
    expect(
      uncertainResultReason(result('Error: invalid recipient', 'error')),
    ).toBeNull();
    expect(uncertainResultReason('not a tool message')).toBeNull();
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

  it('keeps the claim when the tool returns an uncertain failure instead of throwing it', async () => {
    const { claims, wrap } = middlewareFor();
    const dropped = new ToolMessage({
      tool_call_id: 'call_edit_flow',
      name: 'edit_flow',
      content: JSON.stringify({
        ok: false,
        error: { code: 'error', message: 'fetch failed' },
      }),
    });
    const out = await wrap(
      requestFor('edit_flow', { step: 'a' }),
      async () => dropped,
    );
    // The model still sees what the tool said …
    expect(out).toBe(dropped);
    // … but the claim stands, so the identical write is not run again.
    expect(claims.log).toEqual(['claim:edit_flow']);
    let ran = false;
    const again = (await wrap(
      requestFor('edit_flow', { step: 'a' }),
      async () => {
        ran = true;
        return okResult('edit_flow');
      },
    )) as ToolMessage;
    expect(ran).toBe(false);
    expect(again.status).toBe('error');
    expect(String(again.content)).toBe(uncertainWriteToolResult('edit_flow'));
  });

  it('releases the claim when the tool returns a failure the service reported', async () => {
    const { claims, wrap } = middlewareFor();
    await wrap(
      requestFor('edit_flow', { step: 'b' }),
      async () =>
        new ToolMessage({
          tool_call_id: 'call_edit_flow',
          name: 'edit_flow',
          content: JSON.stringify({
            ok: false,
            error: { code: 'validation_failed', message: 'Step name taken' },
          }),
        }),
    );
    expect(claims.log).toEqual(['claim:edit_flow', 'release:edit_flow']);
    expect(claims.rows.size).toBe(0);
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
    const shared = makeClaimStore();
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

  it('leaves a debug trace of every completed call', async () => {
    const logger = {
      log: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
    };
    const { wrap } = middlewareFor({ logger });
    await wrap(requestFor('get_page'), async () => okResult('get_page'));
    await wrap(
      requestFor('send'),
      async () =>
        new ToolMessage({
          tool_call_id: 'call_send',
          name: 'send',
          content: 'invalid recipient',
          status: 'error',
        }),
    );
    expect(logger.debug).toHaveBeenCalledWith(
      expect.stringMatching(
        /^\[tool-execution\] get_page \(call_get_page\): ok in \d+ ms$/,
      ),
    );
    expect(logger.debug).toHaveBeenCalledWith(
      expect.stringMatching(
        /^\[tool-execution\] send \(call_send\): returned an error in \d+ ms$/,
      ),
    );
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

  describe('frontend tools', () => {
    /** `show_*` / `view_*` act in the browser (`surface: 'frontend'`); `view_*` only read. */
    const laneOf = (name: string) =>
      name.startsWith('show_') || name.startsWith('view_')
        ? ('frontend' as const)
        : name.startsWith('get_')
          ? ('read' as const)
          : ('write' as const);
    const effectOf = (name: string) =>
      name.startsWith('get_') || name.startsWith('view_')
        ? ('read' as const)
        : ('write' as const);

    function sessions(options: { maxReads?: number } = {}) {
      const scheduler = new ToolScheduler(options);
      const claims = makeClaimStore();
      const forSession = (
        sessionId: string,
        runId: string,
        signal?: AbortSignal,
      ) =>
        middlewareFor({
          scheduler,
          claims: claims.store,
          laneOf,
          effectOf,
          sessionId,
          runId,
          ...(signal ? { signal } : {}),
        }).wrap;
      return { scheduler, claims, forSession };
    }

    const held = () => {
      let release!: () => void;
      const done = new Promise<void>((resolve) => {
        release = resolve;
      });
      return { done, release };
    };

    const until = async (check: () => boolean) => {
      for (let i = 0; i < 50 && !check(); i += 1)
        await new Promise((resolve) => setTimeout(resolve, 1));
    };

    it('runs in the session’s own frontend lane, one at a time per session, beside the user-wide write lane', async () => {
      const { scheduler, forSession } = sessions();
      const one = forSession('session-1', 'run-1');
      const two = forSession('session-2', 'run-2');
      const started: string[] = [];
      const first = held();
      const write = held();
      const runs = [
        one(requestFor('send_message', { to: 'x' }), async () => {
          started.push('write');
          await write.done;
          return okResult('send_message');
        }),
        one(requestFor('show_card', { id: 'a' }), async () => {
          started.push('one:a');
          await first.done;
          return okResult('show_card');
        }),
        one(requestFor('show_card', { id: 'b' }), async () => {
          started.push('one:b');
          return okResult('show_card');
        }),
        two(requestFor('show_card', { id: 'c' }), async () => {
          started.push('two:c');
          return okResult('show_card');
        }),
      ];
      await until(() => started.length >= 4);
      await new Promise((resolve) => setTimeout(resolve, 5));
      // The held server write held up no browser call; session 1's second
      // browser call waits for its first.
      expect([...started].sort()).toEqual(['one:a', 'two:c', 'write']);
      expect(scheduler.snapshot()).toMatchObject({
        write: { inFlight: 1, queued: 0 },
        sessionLanes: { 'frontend:session-1': { inFlight: 1, queued: 1 } },
      });
      first.release();
      write.release();
      await Promise.all(runs);
      expect(started.at(-1)).toBe('one:b');
      expect(scheduler.snapshot().sessionLanes).toEqual({});
    });

    it('lets a user read run while four chats each have a browser read parked', async () => {
      const { scheduler, claims, forSession } = sessions({ maxReads: 4 });
      const parked = held();
      const views = ['s1', 's2', 's3', 's4'].map((sessionId, i) =>
        forSession(sessionId, `run-${i}`)(
          requestFor('view_page', { tab: i }),
          async () => {
            await parked.done;
            return okResult('view_page');
          },
        ),
      );
      await until(() => scheduler.snapshot().frontend.inFlight === 4);
      expect(scheduler.snapshot().read).toEqual({ inFlight: 0, queued: 0 });
      const read = await forSession('s5', 'run-5')(
        requestFor('get_thing'),
        async () => okResult('get_thing'),
      );
      expect(read).toMatchObject({ content: 'ok' });
      parked.release();
      await Promise.all(views);
      // A browser read is never claimed.
      expect(claims.log).toEqual([]);
    });

    it('claims a frontend write by its effect, under a fingerprint of its session', async () => {
      const { claims, forSession } = sessions();
      // The same browser write in two chats at once: two actions, both run.
      const first = held();
      let secondRan = false;
      const a = forSession('session-1', 'run-1')(
        requestFor('show_card', { id: 'a' }),
        async () => {
          await first.done;
          return okResult('show_card');
        },
      );
      await until(() => claims.rows.size === 1);
      const b = await forSession('session-2', 'run-2')(
        requestFor('show_card', { id: 'a' }),
        async () => {
          secondRan = true;
          return okResult('show_card');
        },
      );
      expect(secondRan).toBe(true);
      expect(b).toMatchObject({ content: 'ok' });
      first.release();
      await a;
      expect(claims.log).toEqual([
        'claim:show_card',
        'claim:show_card',
        'release:show_card',
        'release:show_card',
      ]);
      expect(claims.rows.size).toBe(0);
    });

    it('still blocks an identical frontend write in the same session while its outcome is unknown', async () => {
      const { claims, forSession } = sessions();
      const one = forSession('session-1', 'run-1');
      await Promise.resolve(
        one(requestFor('show_card', { id: 'a' }), async () => {
          throw new TypeError('fetch failed');
        }),
      ).catch(() => undefined);
      let ran = false;
      const out = await forSession('session-1', 'run-2')(
        requestFor('show_card', { id: 'a' }),
        async () => {
          ran = true;
          return okResult('show_card');
        },
      );
      expect(ran).toBe(false);
      expect(out).toMatchObject({
        status: 'error',
        content: uncertainWriteToolResult('show_card'),
      });
      expect(claims.log.at(-1)).toBe('blocked:show_card');
    });

    it('still guards an identical server write user-wide across sessions', async () => {
      const { claims, forSession } = sessions();
      await Promise.resolve(
        forSession('session-1', 'run-1')(
          requestFor('send_message', { to: 'a' }),
          async () => {
            throw new TypeError('fetch failed');
          },
        ),
      ).catch(() => undefined);
      let ran = false;
      await forSession('session-2', 'run-2')(
        requestFor('send_message', { to: 'a' }),
        async () => {
          ran = true;
          return okResult('send_message');
        },
      );
      expect(ran).toBe(false);
      expect(claims.log.at(-1)).toBe('blocked:send_message');
    });

    it('releases the claim of a frontend write never sent: the turn aborted while it was parked', async () => {
      const { claims, forSession } = sessions();
      const registry = new FrontendCallRegistry();
      const controller = new AbortController();
      const wrap = forSession('session-1', 'run-1', controller.signal);
      const out = wrap(requestFor('show_card', { id: 'a' }), async () => {
        const pending = registry.open(
          {
            kind: 'browser',
            toolCallId: 'inv-1',
            toolName: 'show_card',
            sessionId: 'session-1',
          },
          {
            timeoutMs: 15_000,
            parkTimeoutMs: 60_000,
            signal: controller.signal,
          },
        );
        controller.abort();
        await pending;
        return okResult('show_card');
      });
      await expect(out).rejects.toBeInstanceOf(FrontendCallNotSentError);
      expect(claims.log).toEqual(['claim:show_card', 'release:show_card']);
      expect(claims.rows.size).toBe(0);
    });

    it('releases the claim of a frontend write never sent: its park deadline passed', async () => {
      const { claims, forSession } = sessions();
      const registry = new FrontendCallRegistry();
      const out = forSession('session-1', 'run-1')(
        requestFor('show_card', { id: 'a' }),
        async () => {
          await registry.open(
            {
              kind: 'browser',
              toolCallId: 'inv-1',
              toolName: 'show_card',
              sessionId: 'session-1',
            },
            { timeoutMs: 15_000, parkTimeoutMs: 5 },
          );
          return okResult('show_card');
        },
      );
      await expect(out).rejects.toMatchObject({
        name: 'FrontendCallNotSentError',
        reason: 'park-deadline',
      });
      expect(claims.log).toEqual(['claim:show_card', 'release:show_card']);
    });
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

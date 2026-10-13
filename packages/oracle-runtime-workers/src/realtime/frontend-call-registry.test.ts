import {
  FRONTEND_OUTCOME_UNKNOWN,
  frontendOutcomeUnknown,
} from '@ixo/common/ai/frontend-bridge';
import { describe, expect, it } from 'vitest';
import {
  FrontendCallRegistry,
  type FrontendExecutor,
} from './frontend-call-registry';

const call = (kind: 'browser' | 'agui', id: string) => ({
  kind,
  toolCallId: id,
  toolName: 'open_url',
  sessionId: 's1',
});

const tab: FrontendExecutor = {
  sid: 'sid-a',
  sessionId: 's1',
  userDid: 'did:ixo:alice',
};

/** Open an invocation and bind it to `executor`, as the endpoint does after sending it. */
function issue(
  reg: FrontendCallRegistry,
  kind: 'browser' | 'agui',
  id: string,
  opts: { timeoutMs?: number; executor?: FrontendExecutor } = {},
): Promise<unknown> {
  const p = reg.open(call(kind, id), { timeoutMs: opts.timeoutMs ?? 1000 });
  reg.dispatched(id, opts.executor ?? tab);
  return p;
}

describe('FrontendCallRegistry', () => {
  it('resolves a call with the result its executing socket delivered', async () => {
    const reg = new FrontendCallRegistry();
    const p = issue(reg, 'browser', 'tc-1');
    expect(reg.size).toBe(1);
    expect(reg.list()).toMatchObject([
      { toolCallId: 'tc-1', executorSid: 'sid-a' },
    ]);
    expect(
      reg.settle('browser', {
        toolCallId: 'tc-1',
        from: tab,
        result: { ok: 1 },
      }),
    ).toEqual({ settled: true });
    await expect(p).resolves.toEqual({ ok: 1 });
    expect(reg.size).toBe(0);
  });

  it('rejects on error and on AG-UI success:false, but returns a client-reported unknown outcome', async () => {
    const reg = new FrontendCallRegistry();
    const failing = issue(reg, 'browser', 'tc-2');
    reg.settle('browser', {
      toolCallId: 'tc-2',
      from: tab,
      error: 'Tool x not found',
    });
    await expect(failing).rejects.toThrow('Tool x not found');

    const action = issue(reg, 'agui', 'ag-1');
    reg.settle('agui', {
      toolCallId: 'ag-1',
      from: tab,
      result: { success: false, error: 'render failed' },
    });
    await expect(action).rejects.toThrow('render failed');

    const action2 = issue(reg, 'agui', 'ag-2');
    reg.settle('agui', {
      toolCallId: 'ag-2',
      from: tab,
      result: { success: false },
    });
    await expect(action2).rejects.toThrow('Action failed');

    const uncertain = issue(reg, 'agui', 'ag-3');
    reg.settle('agui', {
      toolCallId: 'ag-3',
      from: tab,
      result: { success: false, outcome: 'unknown' },
    });
    await expect(uncertain).resolves.toEqual({
      success: false,
      outcome: 'unknown',
    });

    // A browser tool's own `success: false` is its result, not a rejection.
    const browser = issue(reg, 'browser', 'tc-3');
    reg.settle('browser', {
      toolCallId: 'tc-3',
      from: tab,
      result: { success: false, error: 'denied' },
    });
    await expect(browser).resolves.toEqual({ success: false, error: 'denied' });
  });

  it('accepts a result only from the socket, session and principal the call was sent to', async () => {
    const reg = new FrontendCallRegistry();
    const p = issue(reg, 'browser', 'tc-x');
    for (const from of [
      { ...tab, sid: 'sid-other-tab' },
      { ...tab, sessionId: 's2' },
      { ...tab, userDid: 'did:ixo:mallory' },
    ])
      expect(
        reg.settle('browser', { toolCallId: 'tc-x', from, result: 'forged' }),
      ).toEqual({ settled: false, reason: 'wrong-socket' });
    expect(
      reg.settle('agui', { toolCallId: 'tc-x', from: tab, result: 'kind' }),
    ).toEqual({ settled: false, reason: 'wrong-kind' });
    expect(reg.size).toBe(1);
    reg.settle('browser', { toolCallId: 'tc-x', from: tab, result: 'own' });
    await expect(p).resolves.toBe('own');
  });

  it('rejects duplicate and never-issued results, and never reissues an id', async () => {
    const reg = new FrontendCallRegistry();
    const p = issue(reg, 'browser', 'tc-once');
    reg.settle('browser', { toolCallId: 'tc-once', from: tab, result: 1 });
    await p;
    expect(
      reg.settle('browser', { toolCallId: 'tc-once', from: tab, result: 2 }),
    ).toEqual({ settled: false, reason: 'already-settled' });
    expect(
      reg.settle('browser', { toolCallId: 'tc-never', from: tab, result: 3 }),
    ).toEqual({ settled: false, reason: 'not-issued' });
    expect(() =>
      reg.open(call('browser', 'tc-once'), { timeoutMs: 1000 }),
    ).toThrow('already issued');
    const pending = issue(reg, 'browser', 'tc-live');
    expect(() =>
      reg.open(call('browser', 'tc-live'), { timeoutMs: 1000 }),
    ).toThrow('already issued');
    reg.settle('browser', { toolCallId: 'tc-live', from: tab, result: 4 });
    await pending;
  });

  it('resolves an unknown outcome at the deadline and remembers the call', async () => {
    const reg = new FrontendCallRegistry();
    await expect(
      issue(reg, 'browser', 'tc-slow', { timeoutMs: 5 }),
    ).resolves.toEqual(frontendOutcomeUnknown('tc-slow'));
    await expect(
      issue(reg, 'agui', 'ag-slow', { timeoutMs: 5 }),
    ).resolves.toMatchObject({ code: FRONTEND_OUTCOME_UNKNOWN });
    expect(reg.size).toBe(0);
    expect(
      reg.settle('browser', {
        toolCallId: 'tc-slow',
        from: tab,
        result: 'late',
      }),
    ).toEqual({ settled: false, reason: 'already-settled' });
  });

  it('ends the calls of a socket that went as unknown, leaving other sockets alone', async () => {
    const reg = new FrontendCallRegistry();
    const other: FrontendExecutor = { ...tab, sid: 'sid-b' };
    const a1 = issue(reg, 'browser', 'a1', { timeoutMs: 60_000 });
    const a2 = issue(reg, 'agui', 'a2', { timeoutMs: 60_000 });
    const b1 = issue(reg, 'browser', 'b1', { executor: other });
    expect(reg.executorGone('sid-a')).toBe(2);
    await expect(a1).resolves.toEqual(frontendOutcomeUnknown('a1'));
    await expect(a2).resolves.toEqual(frontendOutcomeUnknown('a2'));
    expect(reg.list().map((c) => c.toolCallId)).toEqual(['b1']);
    reg.settle('browser', { toolCallId: 'b1', from: other, result: 'b' });
    await expect(b1).resolves.toBe('b');
  });

  it('fails a call that never reached a browser, and honours the abort signal', async () => {
    const reg = new FrontendCallRegistry();
    const p = reg.open(call('browser', 'tc-unsent'), { timeoutMs: 1000 });
    reg.fail('tc-unsent', new Error('not sent'));
    await expect(p).rejects.toThrow('not sent');

    // The turn aborted before the call was sent: a definite failure.
    const before = new AbortController();
    const unsent = reg.open(call('browser', 'tc-abort'), {
      timeoutMs: 10_000,
      signal: before.signal,
    });
    before.abort();
    await expect(unsent).rejects.toThrow(
      'Browser tool open_url was not sent: the turn was aborted',
    );
    const already = new AbortController();
    already.abort();
    await expect(
      reg.open(call('agui', 'ag-abort'), {
        timeoutMs: 10_000,
        signal: already.signal,
      }),
    ).rejects.toThrow('was not sent');
    expect(reg.isPending('ag-abort')).toBe(false);

    // Aborted after it was sent: the browser may have run it.
    const after = new AbortController();
    const sent = reg.open(call('browser', 'tc-sent'), {
      timeoutMs: 10_000,
      signal: after.signal,
    });
    reg.dispatched('tc-sent', tab);
    after.abort();
    await expect(sent).resolves.toEqual(frontendOutcomeUnknown('tc-sent'));
    expect(
      reg.settle('browser', { toolCallId: 'tc-sent', from: tab, result: 1 }),
    ).toEqual({ settled: false, reason: 'already-settled' });
    expect(reg.size).toBe(0);
  });

  it('bounds finished records by count and age without ever evicting a pending call', async () => {
    let now = 0;
    const reg = new FrontendCallRegistry({
      now: () => now,
      maxPending: 2,
      maxCompleted: 2,
      completedTtlMs: 1000,
    });
    const settle = (id: string) =>
      reg.settle('browser', { toolCallId: id, from: tab, result: id });

    const one = issue(reg, 'browser', 'one');
    const two = issue(reg, 'browser', 'two');
    // Two in flight fill the table: a third is refused, the two are kept.
    expect(() =>
      reg.open(call('browser', 'three'), { timeoutMs: 1000 }),
    ).toThrow('2 frontend calls are already in flight');
    expect(reg.list().map((c) => c.toolCallId)).toEqual(['one', 'two']);
    settle('one');
    await one;
    // Finished calls never starve new ones.
    const three = issue(reg, 'browser', 'three');
    settle('two');
    settle('three');
    await Promise.all([two, three]);
    expect(reg.completedCount).toBe(2);
    // The oldest record made room: its replay now reads as never issued.
    expect(settle('one')).toEqual({ settled: false, reason: 'not-issued' });
    expect(settle('three')).toEqual({
      settled: false,
      reason: 'already-settled',
    });
    now = 1001;
    expect(reg.completedCount).toBe(0);
    expect(settle('three')).toEqual({ settled: false, reason: 'not-issued' });
  });
});

import { describe, expect, it } from 'vitest';
import { FrontendCallRegistry } from './frontend-call-registry';

const call = (kind: 'browser' | 'agui', id: string) => ({
  kind,
  toolCallId: id,
  toolName: 'open_url',
  sessionId: 's1',
});

describe('FrontendCallRegistry', () => {
  it('resolves a browser call with the delivered result', async () => {
    const reg = new FrontendCallRegistry();
    const p = reg.wait(call('browser', 'tc-1'), { timeoutMs: 1000 });
    expect(reg.size).toBe(1);
    expect(
      reg.settle('browser', { toolCallId: 'tc-1', result: { ok: 1 } }),
    ).toBe(true);
    await expect(p).resolves.toEqual({ ok: 1 });
    expect(reg.size).toBe(0);
  });

  it('rejects on error, on AG-UI success:false, and ignores unknown ids', async () => {
    const reg = new FrontendCallRegistry();
    const failing = reg.wait(call('browser', 'tc-2'), { timeoutMs: 1000 });
    reg.settle('browser', { toolCallId: 'tc-2', error: 'Tool x not found' });
    await expect(failing).rejects.toThrow('Tool x not found');

    const action = reg.wait(call('agui', 'ag-1'), { timeoutMs: 1000 });
    reg.settle('agui', {
      toolCallId: 'ag-1',
      result: { success: false, error: 'render failed' },
    });
    await expect(action).rejects.toThrow('render failed');

    const action2 = reg.wait(call('agui', 'ag-2'), { timeoutMs: 1000 });
    reg.settle('agui', { toolCallId: 'ag-2', result: { success: false } });
    await expect(action2).rejects.toThrow('Action failed');

    // A browser result is keyed separately from an AG-UI one.
    const browser = reg.wait(call('browser', 'same'), { timeoutMs: 1000 });
    expect(reg.settle('agui', { toolCallId: 'same', result: 1 })).toBe(false);
    expect(reg.settle('browser', { toolCallId: 'same', result: 2 })).toBe(true);
    await expect(browser).resolves.toBe(2);
    expect(reg.settle('browser', { toolCallId: 'nope', result: 1 })).toBe(
      false,
    );
  });

  it("times out with Node's message and honours the abort signal", async () => {
    const reg = new FrontendCallRegistry();
    await expect(
      reg.wait(call('browser', 'tc-3'), { timeoutMs: 5 }),
    ).rejects.toThrow('Browser tool timeout after 5ms: open_url');
    await expect(
      reg.wait(call('agui', 'ag-3'), { timeoutMs: 5 }),
    ).rejects.toThrow('AG-UI action timeout after 5ms: open_url');

    const ac = new AbortController();
    const p = reg.wait(call('browser', 'tc-4'), {
      timeoutMs: 10_000,
      signal: ac.signal,
    });
    ac.abort();
    await expect(p).rejects.toThrow('aborted');
    expect(reg.size).toBe(0);
  });

  it('lists pending calls oldest first', async () => {
    const reg = new FrontendCallRegistry();
    const a = reg.wait(call('browser', 'a'), { timeoutMs: 1000 });
    const b = reg.wait(call('agui', 'b'), { timeoutMs: 1000 });
    expect(reg.list().map((c) => c.toolCallId)).toEqual(['a', 'b']);
    reg.settle('browser', { toolCallId: 'a', result: null });
    reg.settle('agui', { toolCallId: 'b', result: { success: true } });
    await Promise.all([a, b]);
  });
});

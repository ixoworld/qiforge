import { ToolMessage } from '@langchain/core/messages';
import { describe, expect, it, vi } from 'vitest';
import {
  cappedMetaOf,
  createResultCapMiddleware,
  headTailSplit,
  truncateHeadTail,
} from './result-cap';

const request = (name: string) =>
  ({ toolCall: { id: 'call-1', name, args: {} } }) as never;

async function runCap(
  mw: ReturnType<typeof createResultCapMiddleware>,
  name: string,
  output: unknown,
): Promise<unknown> {
  const wrap = mw.wrapToolCall;
  if (!wrap) throw new Error('wrapToolCall missing');
  const fn =
    typeof wrap === 'function' ? wrap : (wrap as { hook: typeof wrap }).hook;
  return (fn as (r: never, h: () => Promise<unknown>) => Promise<unknown>)(
    request(name),
    async () => output,
  );
}

describe('createResultCapMiddleware', () => {
  it('leaves results under the cap untouched', async () => {
    const put = vi.fn();
    const mw = createResultCapMiddleware({
      capChars: 1000,
      sessionId: 's',
      store: { put },
    });
    const small = new ToolMessage({
      tool_call_id: 'call-1',
      name: 't',
      content: 'x'.repeat(999),
    });
    expect(await runCap(mw, 't', small)).toBe(small);
    expect(put).not.toHaveBeenCalled();
  });

  it('stores an oversized result whole and shows head, tail and the handle', async () => {
    const put = vi
      .fn()
      .mockResolvedValue({ id: 'a'.repeat(64), size: 5000, tier: 'sqlite' });
    const mw = createResultCapMiddleware({
      capChars: 1000,
      sessionId: 'sess',
      store: { put },
    });
    const text = `HEAD${'m'.repeat(4990)}TAIL`;
    const out = (await runCap(
      mw,
      'mcp__dump',
      new ToolMessage({
        id: 'msg-1',
        tool_call_id: 'call-1',
        name: 'mcp__dump',
        content: text,
      }),
    )) as ToolMessage;
    expect(put).toHaveBeenCalledWith({
      sessionId: 'sess',
      toolName: 'mcp__dump',
      content: text,
    });
    expect(out.id).toBe('msg-1');
    expect(out.tool_call_id).toBe('call-1');
    expect(out.name).toBe('mcp__dump');
    const shown = String(out.content);
    expect(shown.length).toBeLessThanOrEqual(1000 + 200);
    expect(shown.startsWith('HEAD')).toBe(true);
    expect(shown).toContain('TAIL');
    expect(shown).toContain('characters omitted');
    expect(shown).toContain(`saved as ${'a'.repeat(64)}`);
    expect(shown).toContain('read_result');
    expect(cappedMetaOf(out)).toMatchObject({
      id: 'a'.repeat(64),
      size: text.length,
    });
  });

  it('still truncates when the store fails or is absent, saying the full result is unavailable', async () => {
    const failing = createResultCapMiddleware({
      capChars: 1000,
      sessionId: 's',
      store: {
        put: async () => {
          throw new Error('r2 down');
        },
      },
    });
    const out = (await runCap(
      failing,
      't',
      new ToolMessage({
        tool_call_id: 'call-1',
        name: 't',
        content: 'y'.repeat(3000),
      }),
    )) as ToolMessage;
    expect(String(out.content)).toContain('could not be saved');
    expect(cappedMetaOf(out)?.id).toBeUndefined();
    const none = createResultCapMiddleware({ capChars: 1000, sessionId: 's' });
    const out2 = (await runCap(
      none,
      't',
      new ToolMessage({
        tool_call_id: 'c',
        name: 't',
        content: 'y'.repeat(3000),
      }),
    )) as ToolMessage;
    expect(String(out2.content)).toContain('could not be saved');
  });

  it('caps structured content by its JSON text and keeps error status; exempt tools pass through', async () => {
    const put = vi
      .fn()
      .mockResolvedValue({ id: 'b'.repeat(64), size: 1, tier: 'sqlite' });
    const mw = createResultCapMiddleware({
      capChars: 500,
      sessionId: 's',
      store: { put },
      exempt: new Set(['read_result']),
    });
    const blocks = Array.from({ length: 50 }, (_, i) => ({
      type: 'text',
      text: `block ${i} ${'z'.repeat(40)}`,
    }));
    const out = (await runCap(
      mw,
      't',
      new ToolMessage({
        tool_call_id: 'c',
        name: 't',
        content: blocks,
        status: 'error',
      }),
    )) as ToolMessage;
    expect(typeof out.content).toBe('string');
    expect(out.status).toBe('error');
    expect(put.mock.calls[0]?.[0].content).toBe(JSON.stringify(blocks));
    const big = new ToolMessage({
      tool_call_id: 'c',
      name: 'read_result',
      content: 'q'.repeat(5000),
    });
    expect(await runCap(mw, 'read_result', big)).toBe(big);
  });
});

describe('truncateHeadTail', () => {
  it('splits the visible budget 40/60 and keeps the total inside the cap', () => {
    expect(headTailSplit(1000)).toEqual({ head: 400, tail: 600 });
    const text = 'a'.repeat(10_000);
    const out = truncateHeadTail(text, 2000, { size: 10_000, shown: 1600 });
    expect(out.length).toBeLessThanOrEqual(2000 + 150);
    expect(out).toContain(
      '[Result truncated: showing the first 640 and last 960 of 10000 characters',
    );
  });
});

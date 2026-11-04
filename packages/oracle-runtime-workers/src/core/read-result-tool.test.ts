import { HumanMessage, ToolMessage } from '@langchain/core/messages';
import { describe, expect, it, vi } from 'vitest';
import { buildReadResultTool, readResultMaxChars } from './read-result-tool';
import { makeRuntimeContext } from './test-fixtures';

const CALL_ID = 'call_abc123';

function setup(read = vi.fn()) {
  const tool = buildReadResultTool({ read, maxChars: 8_000 });
  const history = [
    new HumanMessage({ id: 'h0', content: 'first' }),
    new ToolMessage({
      id: 't0',
      tool_call_id: CALL_ID,
      name: 'chain_lookup',
      content: 'x'.repeat(5_000),
    }),
  ];
  const ctx = makeRuntimeContext();
  ctx.history.messages = history;
  return { tool, ctx, read };
}

describe('read_result', () => {
  it('reads back a result trimmed from the context, from the thread itself', async () => {
    const { tool, ctx, read } = setup();
    const first = await tool.handler({ id: CALL_ID, offset: 0 }, ctx);
    expect(first).toEqual({
      id: CALL_ID,
      offset: 0,
      length: 4_000,
      size: 5_000,
      next: 4_000,
      text: 'x'.repeat(4_000),
    });
    const rest = await tool.handler({ id: CALL_ID, offset: 4_000 }, ctx);
    expect(rest).toMatchObject({ length: 1_000, next: null });
    expect(read).not.toHaveBeenCalled();
  });

  it('reads the newest result when a provider used the call id again', async () => {
    const { tool, ctx } = setup();
    ctx.history.messages = [
      ...ctx.history.messages,
      new HumanMessage({ id: 'h1', content: 'later' }),
      new ToolMessage({
        id: 't1',
        tool_call_id: CALL_ID,
        name: 'vfs_read',
        content: 'the later result',
      }),
    ];
    expect(await tool.handler({ id: CALL_ID, offset: 0 }, ctx)).toMatchObject({
      text: 'the later result',
    });
  });

  it('asks the store for anything else and reports what it cannot find', async () => {
    const read = vi.fn(async () => ({ status: 'not-found' as const }));
    const { tool, ctx } = setup(read);
    const id = 'f'.repeat(64);
    expect(await tool.handler({ id, offset: 0 }, ctx)).toEqual({
      error: 'No saved result with this id in this session.',
    });
    expect(read).toHaveBeenCalledWith(id, 0, 4_000);
  });
});

describe('readResultMaxChars', () => {
  it('stays well under the cap so a page is never capped itself', () => {
    expect(readResultMaxChars(64_000)).toBe(16_000);
    expect(readResultMaxChars(10_000)).toBe(5_000);
    expect(readResultMaxChars(600)).toBe(512);
  });
});

import { AIMessage, HumanMessage, ToolMessage } from '@langchain/core/messages';
import { describe, expect, it, vi } from 'vitest';
import {
  buildReadResultTool,
  READ_RESULT_CALLS_PER_TURN,
  READ_RESULT_MIN_CHARS,
  readBudgetSpent,
  readResultMaxChars,
} from './read-result-tool';
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
    const first = await tool.handler(
      { id: CALL_ID, offset: 0, length: 4_000 },
      ctx,
    );
    expect(first).toEqual({
      id: CALL_ID,
      offset: 0,
      length: 4_000,
      size: 5_000,
      next: 4_000,
      text: 'x'.repeat(4_000),
    });
    const rest = await tool.handler(
      { id: CALL_ID, offset: 4_000, length: 4_000 },
      ctx,
    );
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
    // The default chunk is the largest one: a page per call, not a sliver.
    expect(read).toHaveBeenCalledWith(id, 0, 8_000);
  });

  it(`reads at least ${READ_RESULT_MIN_CHARS} characters, whatever length is asked`, async () => {
    const { tool, ctx } = setup();
    expect(
      await tool.handler({ id: CALL_ID, offset: 0, length: 300 }, ctx),
    ).toMatchObject({
      length: READ_RESULT_MIN_CHARS,
      next: READ_RESULT_MIN_CHARS,
    });
  });

  it(`stops after ${READ_RESULT_CALLS_PER_TURN} reads in a turn, and a new turn may read again`, async () => {
    const read = vi.fn(async () => ({ status: 'not-found' as const }));
    const { tool, ctx } = setup(read);
    const readsSoFar = Array.from(
      { length: READ_RESULT_CALLS_PER_TURN },
      (_, i) =>
        new ToolMessage({
          tool_call_id: `read_${i}`,
          name: 'read_result',
          content: '{}',
        }),
    );
    ctx.history.messages = [
      ...ctx.history.messages,
      new HumanMessage({ id: 'h1', content: 'check it' }),
      ...readsSoFar,
    ];
    expect(await tool.handler({ id: 'f'.repeat(64), offset: 0 }, ctx)).toEqual({
      error: readBudgetSpent(READ_RESULT_CALLS_PER_TURN),
    });
    expect(read).not.toHaveBeenCalled();
    // Reads of an earlier turn do not count against this one.
    ctx.history.messages = [
      ...ctx.history.messages,
      new HumanMessage({ id: 'h2', content: 'next turn' }),
    ];
    expect(await tool.handler({ id: CALL_ID, offset: 0 }, ctx)).toMatchObject({
      size: 5_000,
      next: null,
    });
  });
});

describe('read_result budget with parallel reads', () => {
  it(`counts each read of one parallel batch: the first ${READ_RESULT_CALLS_PER_TURN} run, the rest do not`, async () => {
    const read = vi.fn(async () => ({ status: 'not-found' as const }));
    const tool = buildReadResultTool({ read, maxChars: 8_000 });
    const ids = Array.from(
      { length: READ_RESULT_CALLS_PER_TURN + 2 },
      (_, i) => `r${i}`,
    );
    const ctx = makeRuntimeContext();
    ctx.history.messages = [
      new HumanMessage({ id: 'h', content: 'read it all' }),
      new AIMessage({
        content: '',
        tool_calls: ids.map((id, i) => ({
          id,
          name: 'read_result',
          args: { id: 'f'.repeat(64), offset: i * 8_000 },
          type: 'tool_call' as const,
        })),
      }),
    ];
    const results = [];
    for (const id of ids) {
      ctx.toolCallId = id;
      results.push(await tool.handler({ id: 'f'.repeat(64), offset: 0 }, ctx));
    }
    expect(read).toHaveBeenCalledTimes(READ_RESULT_CALLS_PER_TURN);
    expect(results.slice(READ_RESULT_CALLS_PER_TURN)).toEqual([
      { error: readBudgetSpent(READ_RESULT_CALLS_PER_TURN) },
      { error: readBudgetSpent(READ_RESULT_CALLS_PER_TURN + 1) },
    ]);
  });
});

describe('readResultMaxChars', () => {
  it('stays well under the cap so a page is never capped itself', () => {
    expect(readResultMaxChars(64_000)).toBe(16_000);
    expect(readResultMaxChars(10_000)).toBe(5_000);
    expect(readResultMaxChars(600)).toBe(512);
  });
});

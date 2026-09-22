import { AIMessage, HumanMessage, ToolMessage } from '@langchain/core/messages';
import { describe, expect, it, vi } from 'vitest';
import { contextBudgetFor } from '../context-budget';
import {
  type ContextGuardEvent,
  ContextOverflowError,
  createContextGuardMiddleware,
  estimateRequestTokens,
  PRUNE_HARD,
  PRUNE_SOFT,
  pruneToolResults,
} from './context-guard';

const silent = {
  log: () => undefined,
  warn: () => undefined,
  error: () => undefined,
};

/** A turn: user asks, model calls a tool, tool answers with `chars`, model replies. */
function turn(i: number, chars: number, content?: string) {
  return [
    new HumanMessage({ id: `h${i}`, content: `question ${i}` }),
    new AIMessage({
      id: `a${i}`,
      content: '',
      tool_calls: [{ id: `c${i}`, name: 'fetch', args: { i } }],
    }),
    new ToolMessage({
      id: `t${i}`,
      tool_call_id: `c${i}`,
      name: 'fetch',
      content: content ?? `${i}:${'r'.repeat(chars)}`,
    }),
    new AIMessage({ id: `r${i}`, content: `answer ${i}` }),
  ];
}

describe('pruneToolResults', () => {
  it('demotes large old results, keeps the tail verbatim, keeps a capped result’s handle', () => {
    const capped = new ToolMessage({
      id: 'tc',
      tool_call_id: 'cc',
      name: 'mcp__dump',
      content: 'D'.repeat(5000),
      additional_kwargs: {
        capped: { id: 'f'.repeat(64), size: 99_999, shown: 5000 },
      },
    });
    // 17 messages, tail of 10: indexes 0–6 are prunable (t1, the capped
    // result, and the small t2), t3 and t4 sit in the tail.
    const messages = [
      ...turn(1, 2000),
      capped,
      ...turn(2, 50),
      ...turn(3, 2000),
      ...turn(4, 10),
    ];
    const { messages: out, pruned } = pruneToolResults(messages, PRUNE_SOFT);
    expect(pruned).toBe(2);
    expect(String(out[2]!.content)).toMatch(
      /^\[fetch result \(2002 characters\) pruned from context\]$/,
    );
    expect(String(out[4]!.content)).toContain(`saved as ${'f'.repeat(64)}`);
    expect(out[4]!.id).toBe('tc');
    expect(String(out[6]!.content)).toBe(messages[6]!.content); // small: untouched
    expect(out.slice(-10)).toEqual(messages.slice(-10));
    expect(messages[2]!.content).toHaveLength(2002); // input untouched
  });

  it('replaces older identical results with a back-reference and keeps the newest', () => {
    const same = 'S'.repeat(300);
    const messages = [
      ...turn(1, 0, same),
      ...turn(2, 0, same),
      ...turn(3, 0, same),
      ...turn(4, 10),
    ];
    const { messages: out } = pruneToolResults(messages, {
      keepTail: 4,
      demoteMinChars: 10_000,
    });
    expect(String(out[2]!.content)).toContain(
      'identical to a later fetch result',
    );
    expect(String(out[6]!.content)).toContain(
      'identical to a later fetch result',
    );
    expect(String(out[10]!.content)).toBe(same); // newest full copy kept
  });
});

describe('createContextGuardMiddleware', () => {
  const budget = contextBudgetFor({
    model: 'm',
    tokens: 32_000,
    origin: 'catalog',
  });
  // 32k window: pruneAt 11,200 tokens, requestCap 22,400 tokens.
  const run = async (
    mw: ReturnType<typeof createContextGuardMiddleware>,
    messages: unknown[],
    handler: (req: { messages: unknown[] }) => Promise<unknown>,
  ) => {
    const wrap = mw.wrapModelCall;
    if (!wrap) throw new Error('wrapModelCall missing');
    const fn =
      typeof wrap === 'function' ? wrap : (wrap as { hook: typeof wrap }).hook;
    return (fn as (r: never, h: never) => Promise<unknown>)(
      {
        messages,
        systemMessage: { content: 'sys' },
        tools: [],
        runtime: {},
      } as never,
      handler as never,
    );
  };

  it('passes a small request through unchanged', async () => {
    const mw = createContextGuardMiddleware({ budget, logger: silent });
    const messages = [...turn(1, 100)];
    const handler = vi.fn().mockResolvedValue('ok');
    expect(await run(mw, messages, handler)).toBe('ok');
    expect(handler.mock.calls[0]?.[0].messages).toBe(messages);
  });

  it('prunes old results once the request passes the prune threshold', async () => {
    const mw = createContextGuardMiddleware({ budget, logger: silent });
    // 6 turns × 12k chars ≈ 18k tokens > pruneAt (11.2k); tail = 10 messages.
    const messages = Array.from({ length: 6 }, (_, i) =>
      turn(i, 12_000),
    ).flat();
    const handler = vi.fn().mockResolvedValue('ok');
    await run(mw, messages, handler);
    const sent = handler.mock.calls[0]?.[0].messages as ToolMessage[];
    expect(sent).not.toBe(messages);
    expect(String(sent[2]!.content)).toContain('pruned from context');
    expect(sent.slice(-10)).toEqual(messages.slice(-10));
  });

  it('refuses a request that cannot fit even after a hard prune', async () => {
    const mw = createContextGuardMiddleware({ budget, logger: silent });
    // The kept tail alone is too big: a 100k-char result ≈ 25k tokens > the 22.4k cap.
    const messages = [...turn(1, 10), ...turn(2, 40_000), ...turn(3, 100_000)];
    const handler = vi.fn();
    await expect(run(mw, messages, handler)).rejects.toBeInstanceOf(
      ContextOverflowError,
    );
    expect(handler).not.toHaveBeenCalled();
  });

  it('reports every prune, overflow retry and refusal to onEvent, and survives a throwing observer', async () => {
    const events: ContextGuardEvent[] = [];
    const onEvent = vi.fn((e: ContextGuardEvent) => {
      events.push(e);
      throw new Error('observer bug');
    });
    const warn = vi.fn();
    const mw = createContextGuardMiddleware({
      budget,
      onOverflow: async () => 20_000,
      onEvent,
      logger: { ...silent, warn },
    });

    // Soft prune: 6 turns × 12k chars > pruneAt.
    await run(
      mw,
      Array.from({ length: 6 }, (_, i) => turn(i, 12_000)).flat(),
      vi.fn().mockResolvedValue('ok'),
    );
    expect(events).toEqual([
      expect.objectContaining({ kind: 'prune', stage: 'soft', pruned: 3 }),
    ]);
    const soft = events[0] as Extract<ContextGuardEvent, { kind: 'prune' }>;
    expect(soft.beforeTokens).toBeGreaterThan(soft.afterTokens);
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining('onEvent failed: observer bug'),
    );

    // Provider overflow: retry event, then the overflow-stage prune.
    events.length = 0;
    const handler = vi
      .fn()
      .mockRejectedValueOnce(
        new Error("This model's maximum context length is 20000 tokens"),
      )
      .mockResolvedValueOnce('second try');
    await run(
      mw,
      Array.from({ length: 4 }, (_, i) => turn(i, 3_000)).flat(),
      handler,
    );
    expect(events.map((e) => e.kind)).toEqual(['overflow-retry', 'prune']);
    expect(events[0]).toEqual({
      kind: 'overflow-retry',
      learnedWindow: 20_000,
    });
    expect(events[1]).toMatchObject({ kind: 'prune', stage: 'overflow' });

    // Refusal: the soft pass finds no result outside its 10-message tail (no
    // event), the hard pass demotes the 40k result, the 100k tail still does
    // not fit — refused with the remaining size.
    events.length = 0;
    await expect(
      run(
        mw,
        [...turn(1, 10), ...turn(2, 40_000), ...turn(3, 100_000)],
        vi.fn(),
      ),
    ).rejects.toBeInstanceOf(ContextOverflowError);
    expect(events.map((e) => e.kind)).toEqual(['prune', 'refused']);
    expect(events[0]).toMatchObject({
      kind: 'prune',
      stage: 'hard',
      pruned: 1,
    });
    expect(
      (events[1] as Extract<ContextGuardEvent, { kind: 'refused' }>).tokens,
    ).toBeGreaterThan(budget.requestCapTokens);
  });

  it('learns from a provider overflow, retries once pruned hard, then gives up clearly', async () => {
    const onOverflow = vi.fn().mockResolvedValue(20_000);
    const mw = createContextGuardMiddleware({
      budget,
      onOverflow,
      logger: silent,
    });
    const messages = Array.from({ length: 4 }, (_, i) => turn(i, 3_000)).flat();
    const handler = vi
      .fn()
      .mockRejectedValueOnce(
        new Error("This model's maximum context length is 20000 tokens"),
      )
      .mockResolvedValueOnce('second try');
    expect(await run(mw, messages, handler)).toBe('second try');
    expect(onOverflow).toHaveBeenCalledTimes(1);
    const retried = handler.mock.calls[1]?.[0].messages as ToolMessage[];
    expect(String(retried[2]!.content)).toContain('pruned from context');
    expect(retried.slice(-PRUNE_HARD.keepTail)).toEqual(
      messages.slice(-PRUNE_HARD.keepTail),
    );

    const stubborn = vi.fn().mockRejectedValue(new Error('prompt is too long'));
    await expect(run(mw, messages, stubborn)).rejects.toBeInstanceOf(
      ContextOverflowError,
    );
    expect(stubborn).toHaveBeenCalledTimes(2);

    const other = vi.fn().mockRejectedValue(new Error('rate limited'));
    await expect(run(mw, messages, other)).rejects.toThrow('rate limited');
    expect(other).toHaveBeenCalledTimes(1);
  });

  it('never resends an unchanged request after a provider overflow', async () => {
    const mw = createContextGuardMiddleware({ budget, logger: silent });
    // Nothing a hard prune can shrink: small results, all in the tail.
    const messages = [...turn(1, 20)];
    const handler = vi
      .fn()
      .mockRejectedValue(new Error('prompt is too long: 900000 tokens'));
    await expect(run(mw, messages, handler)).rejects.toThrow(
      /nothing more could be trimmed/,
    );
    expect(handler).toHaveBeenCalledTimes(1);
  });
});

describe('estimateRequestTokens', () => {
  it('counts system, schemas, contents and tool calls', () => {
    const n = estimateRequestTokens({
      systemTokens: 100,
      schemaTokens: 50,
      messages: turn(1, 400),
    });
    expect(n).toBeGreaterThan(250);
  });
});

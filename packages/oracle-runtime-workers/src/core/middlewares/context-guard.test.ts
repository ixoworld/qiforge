import {
  AIMessage,
  HumanMessage,
  ToolMessage,
  type BaseMessage,
} from '@langchain/core/messages';
import { tool } from '@langchain/core/tools';
import { convertToOpenAITool } from '@langchain/core/utils/function_calling';
import { createAgent, createMiddleware, FakeToolCallingModel } from 'langchain';
import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { contextBudgetFor } from '../context-budget';
import { USAGE_CARRIED_KWARG } from '../operating-guides';
import {
  type ContextGuardEvent,
  ContextOverflowError,
  createContextGuardMiddleware,
  estimateRequestTokens,
  PRUNE_HARD,
  PRUNE_SOFT,
  pruneToolResults,
  staleResultCutoff,
  trimStaleResults,
} from './context-guard';

vi.mock('@langchain/core/utils/function_calling', async (importOriginal) => {
  const original =
    await importOriginal<
      typeof import('@langchain/core/utils/function_calling')
    >();
  return {
    ...original,
    convertToOpenAITool: vi.fn(original.convertToOpenAITool),
  };
});

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

describe('stale results', () => {
  const MINUTE = 60_000;
  const COLD = 15 * MINUTE;
  /** A turn opened `minutes` after the thread's start. */
  const at = (i: number, minutes: number, chars = 2000) => {
    const [human, ...rest] = turn(i, chars);
    return [
      new HumanMessage({
        id: human!.id,
        content: human!.content,
        additional_kwargs: {
          timestamp: new Date(minutes * MINUTE).toISOString(),
        },
      }),
      ...rest,
    ];
  };
  const stubbed = (messages: BaseMessage[]) =>
    messages
      .filter((m) => ToolMessage.isInstance(m))
      .filter((m) => m.additional_kwargs.pruned === 'stale')
      .map((m) => m.id);
  const cutoff = (messages: BaseMessage[], keep = 2) =>
    staleResultCutoff(messages, keep, COLD);

  it('leaves a warm thread alone, however long', () => {
    const history = [0, 1, 2, 3, 4, 5].flatMap((i) => at(i, i));
    expect(cutoff(history)).toBe(0);
  });

  it('moves the line only on a cold turn and holds it until the next one', () => {
    const history = [at(0, 0), at(1, 1), at(2, 2), at(3, 60)].flat();
    // Turn 3 opened cold: turns 1 and 2 stay whole, turn 0 goes.
    const line = cutoff(history);
    expect(line).toBe(4);
    // The warm turns after it keep the same line, so the prefix holds.
    expect(cutoff([...history, ...at(4, 61)])).toBe(line);
    expect(cutoff([...history, ...at(4, 61), ...at(5, 62)])).toBe(line);
    // The next cold turn moves it.
    expect(cutoff([...history, ...at(4, 61), ...at(5, 120)])).toBe(12);
  });

  it('needs the kept turns behind a cold turn, and reads the time off the messages only', () => {
    expect(cutoff([at(0, 0), at(1, 60)].flat())).toBe(0);
    expect(cutoff([at(0, 0), at(1, 1), at(2, 60)].flat())).toBe(0);
    // No timestamp, no evidence the cache went cold.
    const undated = [0, 1, 2, 3].flatMap((i) => turn(i, 2000));
    expect(cutoff(undated)).toBe(0);
    expect(cutoff([at(0, 0), at(1, 1), at(2, 60)].flat(), 0)).toBe(0);
  });

  it('stubs what is old and large, says how to read it back, and leaves the input alone', () => {
    const history = [at(0, 0), at(1, 0, 100), at(2, 1), at(3, 60)].flat();
    const line = cutoff(history);
    const { messages, pruned } = trimStaleResults(history, line, {
      demoteMinChars: 600,
      readResultChars: 16_000,
    });
    expect(pruned).toBe(1);
    expect(stubbed(messages)).toEqual(['t0']);
    expect(String(messages[2]?.content)).toBe(
      '[fetch result from an earlier turn (2002 characters) removed from context; read_result({ id: "c0", length: 16000 }) reads it back]',
    );
    expect(String(history[2]?.content)).toHaveLength(2002);
    // Same bytes on every call: the stub is part of the cached prefix.
    expect(
      trimStaleResults(history, line, {
        demoteMinChars: 600,
        readResultChars: 16_000,
      }).messages[2]?.content,
    ).toBe(messages[2]?.content);
  });

  it('points a capped result at its saved copy, and says nothing of read_result when it is not bound', () => {
    const [human, call, , reply] = at(0, 0);
    const capped = new ToolMessage({
      id: 't0',
      tool_call_id: 'c0',
      name: 'fetch',
      content: 'r'.repeat(2000),
      additional_kwargs: {
        capped: { id: 'f'.repeat(64), size: 9000, shown: 1 },
      },
    });
    const history = [human!, call!, capped, reply!];
    const options = { demoteMinChars: 600, readResultChars: 16_000 };
    expect(
      String(trimStaleResults(history, 4, options).messages[2]?.content),
    ).toContain(`read_result({ id: "${'f'.repeat(64)}"`);
    expect(
      String(
        trimStaleResults(history, 4, { demoteMinChars: 600 }).messages[2]
          ?.content,
      ),
    ).toContain('call the tool again if you need it');
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

  it('sizes a tool schema once, not again on every turn that binds the same tool', async () => {
    const convert = vi.mocked(convertToOpenAITool);
    convert.mockClear();
    const schema = z.object({ city: z.string(), days: z.number() });
    // Every turn binds fresh tool objects over the plugin's own schema.
    const bound = (description: string) =>
      tool(async () => 'ok', { name: 'get_forecast', description, schema });
    const turnWith = async (description: string) => {
      const mw = createContextGuardMiddleware({ budget, logger: silent });
      const wrap = mw.wrapModelCall;
      if (!wrap) throw new Error('wrapModelCall missing');
      await (wrap as (r: never, h: never) => Promise<unknown>)(
        {
          messages: turn(1, 100),
          systemMessage: { content: 'sys' },
          tools: [bound(description)],
          runtime: {},
        } as never,
        (async () => 'ok') as never,
      );
    };
    await turnWith('Forecast.');
    await turnWith('Forecast.');
    await turnWith('Forecast.');
    expect(convert).toHaveBeenCalledTimes(1);
    // A different description is a different schema payload.
    await turnWith('Weather forecast.');
    expect(convert).toHaveBeenCalledTimes(2);
  });

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

describe('the load result of a loaded plugin', () => {
  const big = 'x'.repeat(2_000);
  const load = () =>
    new ToolMessage({
      id: 'load',
      content: big,
      tool_call_id: 'load',
      name: 'load_capability',
      additional_kwargs: { [USAGE_CARRIED_KWARG]: ['flows'] },
    });

  async function pruned(state: { loadedPlugins?: string[] }) {
    const budget = contextBudgetFor({
      model: 'm',
      tokens: 32_000,
      origin: 'catalog',
    });
    const guard = createContextGuardMiddleware({
      budget: { ...budget, pruneAtTokens: 1 },
      logger: silent,
    });
    const handler = vi.fn(async () => new AIMessage('ok'));
    const filler = Array.from(
      { length: 12 },
      (_, i) => new AIMessage({ id: `f${i}`, content: 'x' }),
    );
    const wrap = guard.wrapModelCall;
    if (!wrap) throw new Error('wrapModelCall missing');
    const fn =
      typeof wrap === 'function' ? wrap : (wrap as { hook: typeof wrap }).hook;
    await (fn as (r: never, h: never) => Promise<unknown>)(
      {
        messages: [load(), ...filler],
        systemMessage: { content: 'sys' },
        tools: [],
        state,
      } as never,
      handler as never,
    );
    const sent = (handler.mock.calls[0] as unknown[])[0] as {
      messages: BaseMessage[];
    };
    return sent.messages[0]?.additional_kwargs.pruned !== undefined;
  }

  it('survives pruning while the plugin is loaded: it is how the model knows its rules', async () => {
    expect(await pruned({ loadedPlugins: ['flows'] })).toBe(false);
  });

  it('goes once the plugin is unloaded', async () => {
    expect(await pruned({ loadedPlugins: [] })).toBe(true);
  });

  it('reads the loaded plugins from the graph state inside an agent', async () => {
    const budget = contextBudgetFor({
      model: 'm',
      tokens: 32_000,
      origin: 'catalog',
    });
    const loadPruned = async (loadedPlugins: string[]): Promise<boolean> => {
      const sent: BaseMessage[][] = [];
      // Inside the guard: sees the request as the guard passes it on.
      const recorder = createMiddleware({
        name: 'Recorder',
        wrapModelCall: (request, handler) => {
          sent.push(request.messages);
          return handler(request);
        },
      });
      const agent = createAgent({
        model: new FakeToolCallingModel({ toolCalls: [] }),
        tools: [],
        middleware: [
          createContextGuardMiddleware({
            budget: { ...budget, pruneAtTokens: 1 },
            logger: silent,
          }),
          recorder,
        ],
      });
      const filler = Array.from(
        { length: 12 },
        (_, i) => new AIMessage({ id: `f${i}`, content: 'x' }),
      );
      await agent.invoke({ messages: [load(), ...filler], loadedPlugins });
      const sentLoad = sent[0]?.find((m) => m.id === 'load');
      if (!sentLoad) throw new Error('the load result was not sent');
      return sentLoad.additional_kwargs.pruned !== undefined;
    };
    expect(await loadPruned(['flows'])).toBe(false);
    expect(await loadPruned([])).toBe(true);
  });

  it('survives stale trimming through the same rule', () => {
    expect(
      trimStaleResults([load()], 1, { demoteMinChars: 10, keep: () => true })
        .pruned,
    ).toBe(0);
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

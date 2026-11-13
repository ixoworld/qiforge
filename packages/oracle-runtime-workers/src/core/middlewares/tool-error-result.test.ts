import { ToolMessage } from '@langchain/core/messages';
import {
  GraphDrained,
  GraphInterrupt,
  ParentCommand,
  Command,
} from '@langchain/langgraph';
import { ToolInvocationError } from 'langchain';
import { describe, expect, it, vi } from 'vitest';
import { HarnessLimitError } from '../turn-budget';
import {
  createToolErrorResultMiddleware,
  isToolInvocationError,
  TOOL_ERROR_RESULT_MAX_CHARS,
  toolErrorResultText,
} from './tool-error-result';

type WrapToolCall = NonNullable<
  ReturnType<typeof createToolErrorResultMiddleware>['wrapToolCall']
>;

function requestFor(signal?: AbortSignal): Parameters<WrapToolCall>[0] {
  return {
    toolCall: {
      id: 'call_1',
      name: 'firecrawl_scrape',
      args: { url: 'https://example.com' },
      type: 'tool_call',
    },
    tool: undefined,
    state: { messages: [] },
    runtime: signal ? { signal } : {},
  };
}

function middlewareFor(signal?: AbortSignal) {
  const logger = { log: vi.fn(), warn: vi.fn(), error: vi.fn() };
  const middleware = createToolErrorResultMiddleware({
    agentName: 'Firecrawl Agent',
    ...(signal ? { signal } : {}),
    logger,
  });
  const wrap = middleware.wrapToolCall as WrapToolCall;
  return { wrap, logger };
}

/** What `@langchain/mcp-adapters` throws for an MCP `isError` result (its class is not exported). */
function toolException(message: string): Error {
  const error = new Error(message);
  error.name = 'ToolException';
  return error;
}

const throwing = (error: unknown) => async (): Promise<ToolMessage> => {
  throw error;
};

describe('createToolErrorResultMiddleware', () => {
  it('hands a thrown tool error to the model as an error result, and warns', async () => {
    const { wrap, logger } = middlewareFor();
    const output = await wrap(
      requestFor(),
      throwing(
        toolException(
          "MCP tool 'firecrawl_scrape' on server 'firecrawl' returned an error: Request failed with status code 403\nmore",
        ),
      ),
    );
    expect(ToolMessage.isInstance(output)).toBe(true);
    const message = output as ToolMessage;
    expect(message.status).toBe('error');
    expect(message.tool_call_id).toBe('call_1');
    expect(message.name).toBe('firecrawl_scrape');
    expect(message.content).toBe(
      "firecrawl_scrape failed: MCP tool 'firecrawl_scrape' on server 'firecrawl' returned an error: Request failed with status code 403\nmore",
    );
    expect(logger.warn).toHaveBeenCalledWith(
      "[tool-error] Firecrawl Agent: firecrawl_scrape (call_1) threw; the error is its result: MCP tool 'firecrawl_scrape' on server 'firecrawl' returned an error: Request failed with status code 403",
    );
  });

  it('passes a result through untouched', async () => {
    const { wrap, logger } = middlewareFor();
    const ok = new ToolMessage({
      content: 'page',
      tool_call_id: 'call_1',
      name: 'firecrawl_scrape',
    });
    expect(await wrap(requestFor(), async () => ok)).toBe(ok);
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it('re-throws when the turn was aborted (its own signal or the graph’s)', async () => {
    const own = new AbortController();
    own.abort();
    const abortError = new DOMException('aborted', 'AbortError');
    await expect(
      middlewareFor(own.signal).wrap(requestFor(), throwing(abortError)),
    ).rejects.toBe(abortError);

    const graph = new AbortController();
    graph.abort();
    await expect(
      middlewareFor().wrap(requestFor(graph.signal), throwing(abortError)),
    ).rejects.toBe(abortError);
  });

  it('re-throws a turn out of budget, also when a middleware wrapped it', async () => {
    const limit = new HarnessLimitError(
      'budget_exhausted',
      'tools',
      'Tool budget exhausted',
    );
    const { wrap, logger } = middlewareFor();
    await expect(wrap(requestFor(), throwing(limit))).rejects.toBe(limit);
    const wrapped = new Error(limit.message, { cause: limit });
    await expect(wrap(requestFor(), throwing(wrapped))).rejects.toBe(wrapped);
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it('re-throws LangGraph control signals: interrupt, drain, parent command', async () => {
    const { wrap } = middlewareFor();
    for (const signal of [
      new GraphInterrupt([]),
      new GraphDrained(),
      new ParentCommand(new Command({ goto: 'x' })),
    ])
      await expect(wrap(requestFor(), throwing(signal))).rejects.toBe(signal);
  });

  it('leaves a schema rejection to ToolNode, which reports it itself', async () => {
    const { wrap } = middlewareFor();
    const rejection = new ToolInvocationError(new Error('Expected string'), {
      id: 'call_1',
      name: 'firecrawl_scrape',
      args: {},
    });
    await expect(wrap(requestFor(), throwing(rejection))).rejects.toBe(
      rejection,
    );
  });

  it('cuts a very long error message', () => {
    const text = toolErrorResultText(
      'x',
      new Error('e'.repeat(TOOL_ERROR_RESULT_MAX_CHARS + 10)),
    );
    expect(text).toBe(
      `x failed: ${'e'.repeat(TOOL_ERROR_RESULT_MAX_CHARS)}… (10 more characters)`,
    );
    expect(toolErrorResultText('x', new Error(''))).toBe(
      'x failed: no error message',
    );
  });
});

describe('isToolInvocationError', () => {
  it('recognizes the class, a copy by name or message, and a wrapped one', () => {
    const rejection = new ToolInvocationError(new Error('bad'), {
      id: 'c',
      name: 't',
      args: {},
    });
    expect(isToolInvocationError(rejection)).toBe(true);
    const copy = new Error('x');
    copy.name = 'ToolInvocationError';
    expect(isToolInvocationError(copy)).toBe(true);
    expect(
      isToolInvocationError(
        new Error("Error invoking tool 't' with kwargs {} with error: bad"),
      ),
    ).toBe(true);
    expect(
      isToolInvocationError(new Error('wrapped', { cause: rejection })),
    ).toBe(true);
    expect(isToolInvocationError(new Error('403 Forbidden'))).toBe(false);
    expect(isToolInvocationError('text')).toBe(false);
  });
});

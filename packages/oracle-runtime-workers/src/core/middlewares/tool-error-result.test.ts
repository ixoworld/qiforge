import { ToolMessage } from '@langchain/core/messages';
import {
  Command,
  GraphDrained,
  GraphInterrupt,
  ParentCommand,
} from '@langchain/langgraph';
import { MiddlewareError, ToolInvocationError } from 'langchain';
import { describe, expect, it, vi } from 'vitest';
import { HarnessLimitError } from '../turn-budget';
import { ERROR_SUMMARY_MAX_CHARS, errorSummary } from '../utils';
import {
  createToolErrorResultMiddleware,
  invalidArgumentsText,
  isToolInvocationError,
  TOOL_ERROR_RESULT_MAX_CHARS,
  toolErrorResultText,
  UNCERTAIN_WRITE_NOTE,
} from './tool-error-result';

type WrapToolCall = NonNullable<
  ReturnType<typeof createToolErrorResultMiddleware>['wrapToolCall']
>;

function requestFor(
  signal?: AbortSignal,
  name = 'firecrawl_scrape',
): Parameters<WrapToolCall>[0] {
  return {
    toolCall: {
      id: 'call_1',
      name,
      args: { url: 'https://example.com' },
      type: 'tool_call',
    },
    tool: undefined,
    state: { messages: [] },
    runtime: signal ? { signal } : {},
  };
}

function middlewareFor(
  options: {
    signal?: AbortSignal;
    effectOf?: (name: string) => 'read' | 'write';
  } = {},
) {
  const logger = { log: vi.fn(), warn: vi.fn(), error: vi.fn() };
  const middleware = createToolErrorResultMiddleware({
    agentName: 'Firecrawl Agent',
    effectOf: options.effectOf ?? (() => 'read'),
    ...(options.signal ? { signal: options.signal } : {}),
    logger,
  });
  const wrap = middleware.wrapToolCall as WrapToolCall;
  return { wrap, logger, middleware };
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

async function resultOf(
  wrap: WrapToolCall,
  error: unknown,
  request = requestFor(),
): Promise<ToolMessage> {
  const output = await wrap(request, throwing(error));
  if (!ToolMessage.isInstance(output)) throw new Error('not a ToolMessage');
  return output;
}

describe('createToolErrorResultMiddleware', () => {
  it('hands a thrown tool error to the model as an error result, and logs it', async () => {
    const { wrap, logger, middleware } = middlewareFor();
    expect(middleware.name).toBe('ToolErrorResultMiddleware');
    const message = await resultOf(
      wrap,
      toolException(
        "MCP tool 'firecrawl_scrape' on server 'firecrawl' returned an error: Request failed with status code 403\nmore",
      ),
    );
    expect(message.status).toBe('error');
    expect(message.tool_call_id).toBe('call_1');
    expect(message.name).toBe('firecrawl_scrape');
    expect(message.content).toBe(
      "firecrawl_scrape failed: MCP tool 'firecrawl_scrape' on server 'firecrawl' returned an error: Request failed with status code 403\nmore",
    );
    expect(logger.log).toHaveBeenCalledWith(
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
    expect(logger.log).not.toHaveBeenCalled();
  });

  it('re-throws when the turn was aborted (its own signal or the graph’s)', async () => {
    const own = new AbortController();
    own.abort();
    const abortError = new DOMException('aborted', 'AbortError');
    await expect(
      middlewareFor({ signal: own.signal }).wrap(
        requestFor(),
        throwing(abortError),
      ),
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
    const wrapped = MiddlewareError.wrap(limit, 'ToolExecutionMiddleware');
    await expect(wrap(requestFor(), throwing(wrapped))).rejects.toBe(wrapped);
    expect(logger.log).not.toHaveBeenCalled();
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

  it('reports a schema rejection by its reason, without the argument dump', async () => {
    const { wrap } = middlewareFor();
    const rejection = new ToolInvocationError(new Error('Expected string'), {
      id: 'call_1',
      name: 'firecrawl_scrape',
      args: { secret: 'do-not-echo' },
    });
    const message = await resultOf(wrap, rejection);
    expect(message.status).toBe('error');
    expect(message.content).toBe(invalidArgumentsText(rejection));
    expect(String(message.content)).toMatch(
      /^Invalid arguments for firecrawl_scrape: /,
    );
    expect(String(message.content)).not.toContain('do-not-echo');
  });

  it('says a failed write whose outcome is unknown may have taken effect', async () => {
    const { wrap, logger } = middlewareFor({ effectOf: () => 'write' });
    const uncertain = await resultOf(
      wrap,
      new TypeError('fetch failed'),
      requestFor(undefined, 'submit_section'),
    );
    expect(uncertain.content).toBe(
      `submit_section failed: fetch failed\n\n${UNCERTAIN_WRITE_NOTE}`,
    );
    expect(logger.log).toHaveBeenCalledWith(
      expect.stringContaining('(write, outcome unknown)'),
    );
    // A definite refusal of a write, and any read failure, carry no note.
    const refused = await resultOf(
      wrap,
      new Error('invalid section id'),
      requestFor(undefined, 'submit_section'),
    );
    expect(refused.content).toBe('submit_section failed: invalid section id');
    const read = await resultOf(
      middlewareFor({ effectOf: () => 'read' }).wrap,
      new TypeError('fetch failed'),
    );
    expect(read.content).toBe('firecrawl_scrape failed: fetch failed');
  });

  it('counts a tool it has no effect for as a write', async () => {
    const logger = { log: vi.fn(), warn: vi.fn(), error: vi.fn() };
    const middleware = createToolErrorResultMiddleware({
      agentName: 'A',
      logger,
    });
    const message = await resultOf(
      middleware.wrapToolCall as WrapToolCall,
      new Error('socket hang up'),
    );
    expect(String(message.content).endsWith(UNCERTAIN_WRITE_NOTE)).toBe(true);
  });

  it('cuts a very long error message, and shows a thrown non-Error as JSON', async () => {
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
    expect(toolErrorResultText('x', { code: 'E_BLOCKED' })).toBe(
      'x failed: {"code":"E_BLOCKED"}',
    );
  });
});

describe('errorSummary', () => {
  it('is the first line, cut for the log', () => {
    expect(errorSummary(new Error('one\ntwo'))).toBe('one');
    expect(
      errorSummary(new Error('x'.repeat(ERROR_SUMMARY_MAX_CHARS + 5))),
    ).toBe(`${'x'.repeat(ERROR_SUMMARY_MAX_CHARS)}…`);
    expect(errorSummary('plain')).toBe('plain');
  });

  it('names a schema rejection by tool and reason, without its arguments', () => {
    expect(
      errorSummary(
        new Error(
          `Error invoking tool 'submit_section' with kwargs {"body":"${'s'.repeat(5_000)}"} with error: Error: Expected string, received number`,
        ),
      ),
    ).toBe(
      "Error invoking tool 'submit_section': Error: Expected string, received number",
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

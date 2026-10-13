/**
 * The Portal browser tools and the AG-UI actions over `ctx.frontend`: the
 * caller id they hand the bridge, the Topic write window, how an unknown
 * outcome reaches the model, and the diagnostic room log that never carries
 * the call's arguments or result body.
 */
import { frontendOutcomeUnknown } from '@ixo/common/ai/frontend-bridge';
import { describe, expect, it, vi } from 'vitest';
import { makeRuntimeContext } from '../../core/test-fixtures';
import type {
  FrontendCallParams,
  FrontendCallSurface,
  RuntimeContext,
} from '../../plugin-api/types';
import { buildActionTool, parseAgActions } from '../agui/agui.plugin';
import { ACTION_LOG_EVENT_TYPE } from './action-log';
import {
  BROWSER_TOOL_TIMEOUT_MS,
  TOPIC_MUTATION_TIMEOUT_MS,
  buildBrowserTool,
  parseBrowserTools,
} from './portal.plugin';

const COMMAND_ID = 'f'.repeat(64);
const schema = {
  type: 'object',
  properties: { note: { type: 'string' } },
};

function harness(answer: (params: FrontendCallParams) => unknown) {
  const calls: FrontendCallParams[] = [];
  const respond = (params: FrontendCallParams): Promise<unknown> => {
    calls.push(params);
    const invocationId = `${params.toolCallId}:inv`;
    params.onInvocation?.(invocationId);
    return Promise.resolve(answer({ ...params, toolCallId: invocationId }));
  };
  const frontend: FrontendCallSurface = {
    callBrowserTool: respond,
    callAgAction: respond,
    hasClient: () => true,
  };
  const postEvent = vi.fn().mockResolvedValue('$ev');
  const kept: Promise<unknown>[] = [];
  const base = makeRuntimeContext();
  const ctx: RuntimeContext = {
    ...makeRuntimeContext({ frontend }),
    session: { ...base.session, roomId: '!room:test' },
    matrix: { ...base.matrix, postEvent },
    background: (work) => {
      kept.push(work);
    },
  };
  const logged = async () => {
    await Promise.all(kept);
    return postEvent.mock.calls.map((call) => ({
      type: call[1],
      content: call[2],
    }));
  };
  return { ctx, calls, logged };
}

describe('Portal browser tools over the frontend bridge', () => {
  it('keeps the first descriptor of a browser tool declared twice', () => {
    const first = { name: 'mutate_topic', description: 'first', schema };
    expect(
      parseBrowserTools([
        first,
        { name: 'mutate_topic', description: 'second', schema },
        { name: 'read_topic', description: 'read', schema },
      ]),
    ).toEqual([first, { name: 'read_topic', description: 'read', schema }]);
  });

  it('hands the bridge a turn-level caller id and logs identifiers only', async () => {
    const { ctx, calls, logged } = harness(() => ({
      commandId: COMMAND_ID,
      status: 'completed',
      echoed: 'PRIVATE-RESULT',
    }));
    const browserTool = buildBrowserTool({
      name: 'read_topic',
      description: 'Read the topic',
      schema,
    });
    const result = await browserTool!.handler({ note: 'PRIVATE-ARG' }, ctx);
    expect(result).toMatchObject({ commandId: COMMAND_ID });
    expect(calls).toMatchObject([
      {
        sessionId: 'session-1',
        toolCallId: 'tc-req-1',
        timeoutMs: BROWSER_TOOL_TIMEOUT_MS,
        args: { note: 'PRIVATE-ARG' },
      },
    ]);
    // The turn's abort signal ends the call with the turn.
    expect(calls[0]?.signal).toBe(ctx.abortSignal);
    const events = await logged();
    expect(events).toEqual([
      {
        type: ACTION_LOG_EVENT_TYPE,
        content: {
          action: {
            name: 'read_topic',
            args: {},
            result: { invocationId: 'tc-req-1:inv', commandId: COMMAND_ID },
            success: true,
          },
          threadId: 'session-1',
        },
      },
    ]);
    expect(JSON.stringify(events)).not.toMatch(/PRIVATE-(ARG|RESULT)/);
  });

  it('gives a Topic mutation the longer window and returns an unknown outcome to the model', async () => {
    const { ctx, calls, logged } = harness((params) =>
      frontendOutcomeUnknown(params.toolCallId),
    );
    const mutate = buildBrowserTool({
      name: 'mutate_topic',
      description: 'Change the topic',
      schema,
    });
    const result = await mutate!.handler({ note: 'x' }, ctx);
    expect(calls[0]?.timeoutMs).toBe(TOPIC_MUTATION_TIMEOUT_MS);
    expect(result).toEqual(frontendOutcomeUnknown('tc-req-1:inv'));
    expect((await logged())[0]?.content).toMatchObject({
      action: {
        name: 'mutate_topic',
        args: {},
        result: { invocationId: 'tc-req-1:inv', outcome: 'unknown' },
        success: false,
      },
    });
  });
});

describe('AG-UI actions over the frontend bridge', () => {
  it('keeps the first descriptor of an action declared twice', () => {
    const first = { name: 'render_table', description: 'first', schema };
    expect(
      parseAgActions([
        first,
        { name: 'render_table', description: 'second', schema },
      ]),
    ).toEqual([first]);
  });

  it('hands the bridge a turn-level caller id, returns the JSON result, and logs identifiers only', async () => {
    const { ctx, calls, logged } = harness(() => ({
      success: true,
      rendered: 'PRIVATE-RESULT',
    }));
    const action = buildActionTool({
      name: 'render_table',
      description: 'Render a table',
      schema,
    });
    const result = await action!.handler({ note: 'PRIVATE-ARG' }, ctx);
    expect(JSON.parse(String(result))).toEqual({
      success: true,
      rendered: 'PRIVATE-RESULT',
    });
    expect(calls[0]?.toolCallId).toBe('ag_req-1');
    expect(calls[0]?.signal).toBe(ctx.abortSignal);
    const events = await logged();
    expect(events[0]?.content).toMatchObject({
      action: {
        name: 'render_table',
        args: {},
        result: { invocationId: 'ag_req-1:inv' },
        success: true,
      },
    });
    expect(JSON.stringify(events)).not.toMatch(/PRIVATE-(ARG|RESULT)/);
  });
});

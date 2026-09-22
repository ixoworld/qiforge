import { FakeListChatModel } from '@langchain/core/utils/testing';
import { tool } from '@langchain/core/tools';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { createSubagentAsTool, type AgentSpec } from './subagent-as-tool';

const noop = tool(async () => 'ok', {
  name: 'noop',
  description: 'does nothing',
  schema: z.object({}),
});

function specWith(
  model: FakeListChatModel,
  extra: Partial<AgentSpec> = {},
): AgentSpec {
  return {
    name: 'Research Agent',
    description: 'researches',
    systemPrompt: 'You research.',
    model,
    tools: [noop],
    userDid: 'did:ixo:user',
    sessionId: 'session-1',
    ...extra,
  };
}

describe('createSubagentAsTool', () => {
  it('returns a refusal as the sub-agent’s answer, without a second attempt', async () => {
    // The fake model answers in order: a second attempt would have returned
    // the second response as the sub-agent's result.
    const model = new FakeListChatModel({
      responses: ["I'm sorry, but I can't do that.", 'second attempt reply'],
    });
    const subagent = createSubagentAsTool(specWith(model));
    const result = await subagent.invoke({ task: 'do the thing' });
    expect(result).toBe("I'm sorry, but I can't do that.");
  });

  it('awaits onComplete before the result reaches the parent', async () => {
    const model = new FakeListChatModel({ responses: ['done'] });
    const seen: string[] = [];
    const subagent = createSubagentAsTool(specWith(model), {
      onComplete: async (messages, task) => {
        await new Promise((resolve) => setTimeout(resolve, 10));
        seen.push(`${task}:${messages.length}`);
      },
    });
    const result = await subagent.invoke({ task: 'summarize' });
    expect(seen).toEqual(['summarize:2']);
    expect(result).toBe('done');
  });

  it('reports a failing onComplete hook without failing the tool call', async () => {
    const model = new FakeListChatModel({ responses: ['done'] });
    const warnings: string[] = [];
    const subagent = createSubagentAsTool(
      specWith(model, {
        logger: {
          log: () => undefined,
          warn: (message: string) => warnings.push(message),
          error: () => undefined,
        },
      }),
      {
        onComplete: async () => {
          throw new Error('persist failed');
        },
      },
    );
    expect(await subagent.invoke({ task: 'x' })).toBe('done');
    expect(warnings.join('\n')).toContain('persist failed');
  });

  it('propagates an aborted turn instead of reporting it as the sub-agent’s error', async () => {
    const model = new FakeListChatModel({ responses: ['never'], sleep: 50 });
    const subagent = createSubagentAsTool(specWith(model));
    const controller = new AbortController();
    const pending = subagent.invoke(
      { task: 'x' },
      { signal: controller.signal },
    );
    controller.abort();
    await expect(pending).rejects.toThrow();
  });
});

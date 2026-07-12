import { describe, expect, it } from 'vitest';
import { BaseChatModel } from '@langchain/core/language_models/chat_models';
import { AIMessage, HumanMessage } from '@langchain/core/messages';
import type { BaseMessage } from '@langchain/core/messages';
import type { ChatResult } from '@langchain/core/outputs';
import { tool } from '@langchain/core/tools';
import { MessagesAnnotation, START, StateGraph } from '@langchain/langgraph';
import { z } from 'zod';
import { createSubagentAsTool, type AgentSpec } from './subagent-as-tool.js';
import {
  currentTaskMessages,
  parentThreadMessages,
  publishParentThreadMessages,
} from './thread-context.js';

function thread(): BaseMessage[] {
  return [
    new HumanMessage('What is the weather in Zug?'),
    new AIMessage('It is 21°C in Zug.'),
  ];
}

/** One-node graph that runs `probe` with the graph's live state in scope. */
async function runInGraphNode(
  messages: BaseMessage[],
  probe: () => void | Promise<void>,
): Promise<void> {
  const graph = new StateGraph(MessagesAnnotation)
    .addNode('probe', async () => {
      await probe();
      return {};
    })
    .addEdge(START, 'probe')
    .compile();
  await graph.invoke({ messages });
}

describe('currentTaskMessages', () => {
  it('returns the live graph state messages inside a task', async () => {
    let seen: readonly BaseMessage[] | undefined;
    await runInGraphNode(thread(), () => {
      seen = currentTaskMessages();
    });
    expect(seen?.map((m) => m.content)).toEqual([
      'What is the weather in Zug?',
      'It is 21°C in Zug.',
    ]);
  });

  it('returns undefined outside a graph task', () => {
    expect(currentTaskMessages()).toBeUndefined();
  });

  it('returns undefined for an empty thread', async () => {
    let seen: readonly BaseMessage[] | undefined = thread();
    await runInGraphNode([], () => {
      seen = currentTaskMessages();
    });
    expect(seen).toBeUndefined();
  });
});

describe('parentThreadMessages', () => {
  it('is undefined until published', () => {
    expect(parentThreadMessages()).toBeUndefined();
  });

  it('crosses into a nested graph invocation once published', async () => {
    const parent = thread();
    let seenInInner: readonly BaseMessage[] | undefined;
    // Outer graph node publishes its thread, then runs a separate inner
    // graph — the exact shape of a sub-agent invocation.
    await runInGraphNode(parent, async () => {
      const current = currentTaskMessages();
      expect(current).toBeDefined();
      publishParentThreadMessages(current ?? []);
      await runInGraphNode([new HumanMessage('inner task')], () => {
        seenInInner = parentThreadMessages();
      });
    });
    expect(seenInInner?.map((m) => m.content)).toEqual(
      parent.map((m) => m.content),
    );
  });

  it('rejects values that are not message arrays', () => {
    publishParentThreadMessages([]);
    expect(parentThreadMessages()).toBeUndefined();
  });
});

/** Replays a fixed message script, one message per model call. */
class ScriptedChatModel extends BaseChatModel {
  private readonly script: AIMessage[];

  constructor(script: AIMessage[]) {
    super({});
    this.script = [...script];
  }

  _llmType(): string {
    return 'scripted';
  }

  override bindTools(): this {
    return this;
  }

  async _generate(): Promise<ChatResult> {
    const message = this.script.shift() ?? new AIMessage('done');
    const text = typeof message.content === 'string' ? message.content : '';
    return { generations: [{ message, text }] };
  }
}

describe('createSubagentAsTool parent-thread publication', () => {
  it("exposes the invoking thread to the inner agent's tools", async () => {
    let seenByInnerTool: readonly BaseMessage[] | undefined;
    const probe = tool(
      () => {
        seenByInnerTool = parentThreadMessages();
        return 'probed';
      },
      { name: 'probe', description: 'records context', schema: z.object({}) },
    );

    const spec: AgentSpec = {
      name: 'echo',
      description: 'echoes',
      systemPrompt: 'call the probe tool, then reply done',
      userDid: 'did:ixo:user1',
      sessionId: 'session-1',
      tools: [probe],
      model: new ScriptedChatModel([
        new AIMessage({
          content: '',
          tool_calls: [{ id: 'call-1', name: 'probe', args: {} }],
        }),
        new AIMessage('done'),
      ]),
    };
    const subagentTool = createSubagentAsTool(spec);

    const parent = thread();
    await runInGraphNode(parent, async () => {
      // Invoke the wrapper the way a tool node would: inside the graph task,
      // so it can read the parent state and publish it for the inner run.
      const reply = await subagentTool.invoke({ task: 'summarize' });
      expect(String(reply)).toBe('done');
    });
    expect(seenByInnerTool?.map((m) => m.content)).toEqual(
      parent.map((m) => m.content),
    );
  });
});

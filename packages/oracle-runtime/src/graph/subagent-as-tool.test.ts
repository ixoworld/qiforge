import { describe, expect, it, vi } from 'vitest';
import { AIMessage, type BaseMessage } from '@langchain/core/messages';
import { BaseChatModel } from '@langchain/core/language_models/chat_models';
import type { ChatResult } from '@langchain/core/outputs';
import { tool } from '@langchain/core/tools';
import { z } from 'zod';
import { sha256Hex, type AuditRecord } from '../kernel/audit.js';
import { createSubagentAsTool, type AgentSpec } from './subagent-as-tool.js';

const baseSpec: AgentSpec = {
  name: 'memory',
  description: 'recalls facts',
  systemPrompt: 'you are the memory agent',
  userDid: 'did:ixo:user1',
  sessionId: 'session-1',
};

/**
 * Deterministic chat model: replays a script of turns through the REAL
 * `createAgent` loop. A `toolCall: true` step emits a call to `noop_tool`;
 * a text step ends the loop. The last step repeats when the script runs out
 * (so an always-`toolCall` script loops until the recursion limit trips).
 */
class ScriptedChatModel extends BaseChatModel {
  calls = 0;

  constructor(
    private readonly script: Array<{ text?: string; toolCall?: boolean }>,
  ) {
    super({});
  }

  _llmType(): string {
    return 'scripted';
  }

  override bindTools(): this {
    return this;
  }

  async _generate(): Promise<ChatResult> {
    const step = this.script[Math.min(this.calls, this.script.length - 1)];
    this.calls += 1;
    if (step?.toolCall) {
      return {
        generations: [
          {
            text: '',
            message: new AIMessage({
              content: '',
              tool_calls: [
                { name: 'noop_tool', args: {}, id: `call_${this.calls}` },
              ],
            }),
          },
        ],
      };
    }
    const text = step?.text ?? '';
    return {
      generations: [{ text, message: new AIMessage(text) }],
    };
  }
}

const noopTool = tool(async () => 'ok', {
  name: 'noop_tool',
  description: 'does nothing',
  schema: z.object({}),
});

const REFUSAL_TEXT = "I'm sorry, but I can't help with that.";

describe('createSubagentAsTool', () => {
  it('derives a `call_<name>_agent` tool name from a plain spec name', () => {
    const t = createSubagentAsTool(baseSpec);
    expect(t.name).toBe('call_memory_agent');
    expect(t.description).toBe('recalls facts');
  });

  it('does not double-suffix when the spec name already ends in `_agent`', () => {
    const t = createSubagentAsTool({ ...baseSpec, name: 'memory_agent' });
    expect(t.name).toBe('call_memory_agent');
  });

  it('lowercases and underscores spec names with mixed casing / spaces', () => {
    const t = createSubagentAsTool({ ...baseSpec, name: 'Domain Indexer' });
    expect(t.name).toBe('call_domain_indexer_agent');
  });

  it('returns a friendly error when no model is configured', async () => {
    const t = createSubagentAsTool(baseSpec);
    // The tool can be invoked through `.invoke({ task })` with a runtime
    // config; with no model we hit the early-return branch deterministically.
    const result = await t.invoke({ task: 'do the thing' });
    expect(String(result)).toContain('has no model configured');
  });

  it('surfaces a refusal verbatim by default (no retry, single model run)', async () => {
    const model = new ScriptedChatModel([
      { text: REFUSAL_TEXT },
      { text: 'SHOULD_NOT_APPEAR' },
    ]);
    const t = createSubagentAsTool({
      ...baseSpec,
      model,
      tools: [noopTool],
    });

    const result = await t.invoke({ task: 'look something up' });

    expect(String(result)).toContain("can't help with that");
    expect(model.calls).toBe(1);
  });

  it('retries exactly once with the honest preamble under retry-once + readOnly, and audits the retry', async () => {
    const model = new ScriptedChatModel([
      { text: REFUSAL_TEXT },
      { text: 'Here is the information.' },
    ]);
    const audits: AuditRecord[] = [];
    const t = createSubagentAsTool({
      ...baseSpec,
      model,
      tools: [noopTool],
      onRefusal: 'retry-once',
      readOnly: true,
      emitAudit: (record) => {
        audits.push(record);
      },
    });

    const task = 'look something up';
    const result = await t.invoke({ task });

    expect(String(result)).toBe('Here is the information.');
    expect(model.calls).toBe(2);
    expect(audits).toHaveLength(1);
    expect(audits[0]?.kind).toBe('subagent.refusal-retry');
    expect(audits[0]?.sessionId).toBe('session-1');
    expect(audits[0]?.detail.subAgent).toBe('memory');
    // Digest, never raw task text, reaches the audit record.
    expect(audits[0]?.detail.taskDigest).toBe(await sha256Hex(task));
    expect(JSON.stringify(audits[0])).not.toContain(task);
  });

  it('never retries under retry-once when readOnly is not declared', async () => {
    const model = new ScriptedChatModel([
      { text: REFUSAL_TEXT },
      { text: 'SHOULD_NOT_APPEAR' },
    ]);
    const t = createSubagentAsTool({
      ...baseSpec,
      model,
      tools: [noopTool],
      onRefusal: 'retry-once',
    });

    const result = await t.invoke({ task: 'look something up' });

    expect(String(result)).toContain("can't help with that");
    expect(model.calls).toBe(1);
  });

  it('does not retry a non-refusal reply', async () => {
    const model = new ScriptedChatModel([
      { text: 'All good.' },
      { text: 'SHOULD_NOT_APPEAR' },
    ]);
    const t = createSubagentAsTool({
      ...baseSpec,
      model,
      tools: [noopTool],
      onRefusal: 'retry-once',
      readOnly: true,
    });

    const result = await t.invoke({ task: 'look something up' });

    expect(String(result)).toBe('All good.');
    expect(model.calls).toBe(1);
  });

  it('propagates abort as a failure and performs no post-cancel work', async () => {
    const model = new ScriptedChatModel([{ toolCall: true }]);
    const onComplete = vi.fn<(messages: BaseMessage[], task: string) => void>();
    const t = createSubagentAsTool(
      { ...baseSpec, model, tools: [noopTool] },
      { onComplete },
    );

    const controller = new AbortController();
    controller.abort();

    await expect(
      t.invoke({ task: 'long running task' }, { signal: controller.signal }),
    ).rejects.toThrow();

    // Terminal semantics: no onComplete callback, no tool-result string a
    // model could read on a run that is already torn down.
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(onComplete).not.toHaveBeenCalled();
  });

  it('bounds the inner loop with the spec recursionLimit', async () => {
    // The script always emits a tool call, so the inner agent loops until
    // the forwarded recursionLimit stops it — proving the limit reaches the
    // nested `agent.invoke`.
    const model = new ScriptedChatModel([{ toolCall: true }]);
    const t = createSubagentAsTool({
      ...baseSpec,
      model,
      tools: [noopTool],
      recursionLimit: 3,
    });

    const result = await t.invoke({ task: 'never finishes' });

    expect(String(result)).toMatch(/recursion/i);
    expect(model.calls).toBeGreaterThan(0);
    expect(model.calls).toBeLessThanOrEqual(3);
  });

  it('still reports non-abort failures as a tool-result string', async () => {
    class ThrowingModel extends ScriptedChatModel {
      override async _generate(): Promise<ChatResult> {
        throw new Error('upstream unavailable');
      }
    }
    const t = createSubagentAsTool({
      ...baseSpec,
      model: new ThrowingModel([]),
      tools: [noopTool],
    });

    const result = await t.invoke({ task: 'anything' });
    expect(String(result)).toContain('Error running memory');
    expect(String(result)).toContain('upstream unavailable');
  });
});

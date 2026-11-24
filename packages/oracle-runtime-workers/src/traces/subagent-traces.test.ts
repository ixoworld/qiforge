import { awaitAllCallbacks } from '@langchain/core/callbacks/promises';
import {
  BaseChatModel,
  type BindToolsInput,
} from '@langchain/core/language_models/chat_models';
import { AIMessage, HumanMessage } from '@langchain/core/messages';
import type { ChatResult } from '@langchain/core/outputs';
import type { Runnable } from '@langchain/core/runnables';
import { MockAsyncLocalStorage } from '@langchain/core/singletons';
import { tool } from '@langchain/core/tools';
import { BaseTracer, type Run } from '@langchain/core/tracers/base';
import { createAgent } from 'langchain';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { budgetedLlm } from '../core/budgeted-llm';
import { TurnModelCalls } from '../core/model-call-reporter';
import { inheritedByNestedRuns } from '../core/nested-run-callbacks';
import { createSubagentAsTool } from '../core/subagent-as-tool';
import { TurnBudget } from '../core/turn-budget';
import {
  attachModelCall,
  MODEL_CALL_METADATA_KEY,
  type ModelCallRecord,
} from '../llm/model-call';
import { record, tracerHarness, validTurn } from './test-helpers';

/**
 * Sub-agents in the trace, under the conditions of Workers: LangChain's
 * AsyncLocalStorage is not set up there (Wrangler bundles its web build), so
 * nothing reaches a nested invocation unless it is passed explicitly. Node's
 * build sets it up; these tests put LangChain's own no-op storage back for
 * their duration, which is what a Worker runs with.
 */
const ALS_KEY = Symbol.for('ls:tracing_async_local_storage');
let nodeStorage: unknown;
beforeAll(() => {
  nodeStorage = Reflect.get(globalThis, ALS_KEY);
  Reflect.set(globalThis, ALS_KEY, new MockAsyncLocalStorage());
});
afterAll(() => {
  Reflect.set(globalThis, ALS_KEY, nodeStorage);
});

interface Step {
  text?: string;
  calls?: Array<{ name: string; args: Record<string, unknown>; id: string }>;
  fail?: boolean;
}

/** A chat model that answers from a script and keeps a call record, like the platform model. */
class ScriptedModel extends BaseChatModel {
  constructor(
    private readonly script: Step[],
    private readonly kept: ModelCallRecord,
  ) {
    super({});
  }

  _llmType(): string {
    return 'scripted';
  }

  override bindTools(_tools: BindToolsInput[]): Runnable {
    return this;
  }

  async _generate(): Promise<ChatResult> {
    const step = this.script.shift() ?? { text: 'done' };
    await new Promise((resolve) => setTimeout(resolve, 2));
    if (step.fail) {
      const error = new Error('502 upstream');
      attachModelCall(error, { ...this.kept, ok: false, errorKind: 'server' });
      throw error;
    }
    const text = step.text ?? '';
    return {
      generations: [
        {
          text,
          message: new AIMessage({
            content: text,
            ...(step.calls ? { tool_calls: step.calls } : {}),
            response_metadata: { [MODEL_CALL_METADATA_KEY]: this.kept },
            usage_metadata: {
              input_tokens: this.kept.promptTokens ?? 0,
              output_tokens: this.kept.outputTokens ?? 0,
              total_tokens:
                (this.kept.promptTokens ?? 0) + (this.kept.outputTokens ?? 0),
            },
          }),
        },
      ],
    };
  }
}

/** Another tracer of the turn (LangSmith's stands here), marked like the runtime marks it. */
class RecordingTracer extends BaseTracer {
  name = 'recording_tracer';
  readonly roots: Run[] = [];
  protected persistRun(run: Run): Promise<void> {
    this.roots.push(run);
    return Promise.resolve();
  }
}

const lookup = tool(async ({ q }: { q: string }) => `found ${q}`, {
  name: 'lookup',
  description: 'Look something up.',
  schema: z.object({ q: z.string() }),
});

const MAIN = record({
  role: 'main',
  promptTokens: 1000,
  cachedTokens: 600,
  outputTokens: 30,
  costUsd: 0.002,
});
const SUB = record({
  role: 'subagent',
  servedModel: 'openai/gpt-5.6-luna-mini',
  promptTokens: 400,
  cachedTokens: 0,
  outputTokens: 20,
  costUsd: 0.0007,
});

/**
 * A turn as the runtime builds it: the main agent and its sub-agent get
 * their models from the turn's metered adapter (the meter rides on each
 * model and in the run config), and the tracer reads the meter's reports.
 */
function turnWith(mainScript: Step[], subScript: Step[]) {
  const calls = new TurnModelCalls();
  const metered = budgetedLlm(
    {
      get: (role) =>
        role === 'main'
          ? new ScriptedModel(mainScript, MAIN)
          : new ScriptedModel(subScript, SUB),
    },
    {
      budget: new TurnBudget(),
      outputReserveTokens: 100,
      onModelCall: (call) => calls.add(call),
    },
  );
  const research = createSubagentAsTool({
    name: 'Research',
    description: 'Researches a question.',
    systemPrompt: 'You research.',
    model: metered.get('subagent'),
    tools: [lookup],
    userDid: 'did:ixo:ixo1testuser',
    sessionId: '$thread-1',
  });
  const agent = createAgent({
    model: metered.get('main'),
    tools: [research],
    systemPrompt: 'You are Yo.',
  }).withConfig({ runName: 'Yo! Agent' });
  const h = tracerHarness({ modelCalls: () => calls.snapshot() });
  const other = inheritedByNestedRuns(new RecordingTracer());
  const run = async (): Promise<void> => {
    try {
      await agent.invoke(
        { messages: [new HumanMessage('hello there')] },
        { callbacks: [metered.callback, other, h.tracer] },
      );
    } finally {
      await awaitAllCallbacks();
      h.tracer.finish();
      await h.settle();
    }
  };
  return { h, calls, other, run };
}

type SentRun = ReturnType<typeof validTurn>['runs'][number];

function ancestry(runs: SentRun[], run: SentRun): string[] {
  const byId = new Map(runs.map((r) => [r.id, r]));
  const names: string[] = [];
  let parent = run.parent_run_id ? byId.get(run.parent_run_id) : undefined;
  while (parent) {
    names.push(parent.name);
    parent = parent.parent_run_id ? byId.get(parent.parent_run_id) : undefined;
  }
  return names;
}

function sum(records: readonly ModelCallRecord[]) {
  return {
    input_tokens: records.reduce((s, r) => s + (r.promptTokens ?? 0), 0),
    cached_tokens: records.reduce((s, r) => s + (r.cachedTokens ?? 0), 0),
    output_tokens: records.reduce((s, r) => s + (r.outputTokens ?? 0), 0),
  };
}

describe('TurnTracer: sub-agents', () => {
  it('nests a sub-agent’s runs under its tool call and counts its model calls once', async () => {
    const t = turnWith(
      [
        {
          calls: [
            {
              name: 'call_research_agent',
              args: { task: 'find x' },
              id: 'c1',
            },
          ],
        },
        { text: 'Here is x.' },
      ],
      [
        { calls: [{ name: 'lookup', args: { q: 'x' }, id: 's1' }] },
        { text: 'x is 42' },
      ],
    );
    await t.run();
    const turns = t.h.ingest.turns();
    expect(turns).toHaveLength(1);
    const turn = validTurn(turns[0]!.body);
    const subModelRuns = turn.runs.filter(
      (r) =>
        r.run_type === 'llm' &&
        JSON.stringify(r.extra).includes('gpt-5.6-luna-mini'),
    );
    expect(subModelRuns).toHaveLength(2);
    for (const r of subModelRuns)
      expect(ancestry(turn.runs, r)).toContain('call_research_agent');
    const innerTool = turn.runs.find((r) => r.name === 'lookup')!;
    expect(ancestry(turn.runs, innerTool)).toEqual(
      expect.arrayContaining(['Research', 'call_research_agent', 'Yo! Agent']),
    );
    expect(innerTool.tags).toEqual(
      expect.arrayContaining(['internal', 'subagent:Research']),
    );
    // Usage: the turn's two calls and the sub-agent's two, each once, and
    // exactly what the runtime's meter reported.
    const reported = t.calls.snapshot();
    expect(reported).toHaveLength(4);
    expect(turn.usage).toMatchObject(sum([MAIN, MAIN, SUB, SUB]));
    expect(turn.usage.cost_usd).toBeCloseTo(2 * 0.002 + 2 * 0.0007, 10);
    expect(turn.usage).toMatchObject(sum(reported));
    // Nothing was counted a second time as a call outside the graph.
    expect(turn.runs.some((r) => r.tags?.includes('outside_graph'))).toBe(
      false,
    );
    // The turn's other tracer (LangSmith's place) nests them the same way.
    expect(t.other.roots).toHaveLength(1);
    const flat: Run[] = [];
    const walk = (r: Run): void => {
      flat.push(r);
      r.child_runs.forEach(walk);
    };
    walk(t.other.roots[0]!);
    expect(flat.filter((r) => r.run_type === 'llm')).toHaveLength(4);
  });

  it('keeps parallel sub-agent calls side by side, each under its own tool call', async () => {
    const t = turnWith(
      [
        {
          calls: [
            { name: 'call_research_agent', args: { task: 'a' }, id: 'c1' },
            { name: 'call_research_agent', args: { task: 'b' }, id: 'c2' },
          ],
        },
        { text: 'Both done.' },
      ],
      [{ text: 'a done' }, { text: 'b done' }],
    );
    await t.run();
    const turn = validTurn(t.h.ingest.turns()[0]!.body);
    const toolRuns = turn.runs.filter((r) => r.name === 'call_research_agent');
    expect(toolRuns).toHaveLength(2);
    const subModelRuns = turn.runs.filter(
      (r) =>
        r.run_type === 'llm' &&
        JSON.stringify(r.extra).includes('gpt-5.6-luna-mini'),
    );
    expect(subModelRuns).toHaveLength(2);
    // One under each tool call.
    const toolOf = (r: SentRun) => {
      const byId = new Map(turn.runs.map((x) => [x.id, x]));
      let p = r.parent_run_id ? byId.get(r.parent_run_id) : undefined;
      while (p && p.name !== 'call_research_agent')
        p = p.parent_run_id ? byId.get(p.parent_run_id) : undefined;
      return p?.id;
    };
    expect(new Set(subModelRuns.map(toolOf)).size).toBe(2);
    expect(turn.usage).toMatchObject(sum([MAIN, MAIN, SUB, SUB]));
  });

  it('keeps a sub-agent whose model call fails: its error run and its record', async () => {
    const t = turnWith(
      [
        {
          calls: [
            { name: 'call_research_agent', args: { task: 'x' }, id: 'c1' },
          ],
        },
        { text: 'The research failed.' },
      ],
      [{ fail: true }],
    );
    await t.run();
    const turn = validTurn(t.h.ingest.turns()[0]!.body);
    expect(turn.status).toBe('success');
    const failed = turn.runs.find(
      (r) => r.run_type === 'llm' && r.status === 'error',
    )!;
    expect(failed.error).toContain('502 upstream');
    expect(ancestry(turn.runs, failed)).toContain('call_research_agent');
    // The failed call's tokens and cost are the provider's: counted once.
    expect(turn.usage).toMatchObject(sum([MAIN, MAIN, SUB]));
    expect(turn.usage).toMatchObject(sum(t.calls.snapshot()));
    const toolRun = turn.runs.find((r) => r.name === 'call_research_agent')!;
    expect(JSON.stringify(toolRun.outputs)).toContain('Error running Research');
  });
});

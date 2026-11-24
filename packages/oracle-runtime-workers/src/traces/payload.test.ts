import type { Run } from '@langchain/core/tracers/base';
import { describe, expect, it } from 'vitest';
import type { ModelCallRecord } from '../llm/model-call';
import { TURN_LIMITS } from './contract';
import {
  approxJsonChars,
  DEFAULT_ENCODE_LIMITS,
  encodeTurn,
  type CollectedTurn,
  type EncodeLimits,
} from './payload';
import { gunzip, record, validTurn } from './test-helpers';

let seq = 0;
function uuid(): string {
  seq += 1;
  return `0192f5d8-0000-7000-8000-${seq.toString(16).padStart(12, '0')}`;
}

function run(
  fields: Partial<Run> & Pick<Run, 'name' | 'run_type'>,
  children: Run[] = [],
): Run {
  const start = 1_764_000_000_000 + seq;
  return {
    id: uuid(),
    start_time: start,
    end_time: start + 10,
    execution_order: 1,
    child_execution_order: 1,
    events: [{ name: 'start', time: new Date(start).toISOString() }],
    inputs: {},
    child_runs: children,
    ...fields,
  };
}

/** A fixed-seed pseudo-random string: gzip cannot shrink it much. */
function noise(chars: number, seed = 7): string {
  let x = seed;
  let out = '';
  while (out.length < chars) {
    x = (x * 1103515245 + 12345) & 0x7fffffff;
    out += x.toString(36);
  }
  return out.slice(0, chars);
}

/** root → [model_request (chain) → llm, tool] with payloads of the given sizes. */
function bigTurn(sizes: {
  llmExtra: number;
  llmInputs: number;
  chain: number;
  tool: number;
}) {
  const llm = run({
    name: 'ChatOpenAICompletions',
    run_type: 'llm',
    inputs: {
      messages: [[{ role: 'user', content: noise(sizes.llmInputs, 1) }]],
    },
    outputs: { generations: [[{ text: 'ok' }]] },
    extra: {
      invocation_params: { tools: noise(sizes.llmExtra, 2) },
      metadata: {
        ls_model_name: 'openai/gpt-5.6-luna',
        oracle_model_role: 'main',
      },
    },
  });
  const chain = run(
    {
      name: 'model_request',
      run_type: 'chain',
      inputs: { state: noise(sizes.chain, 3) },
    },
    [llm],
  );
  const toolRun = run({
    name: 'lookup',
    run_type: 'tool',
    inputs: { input: '{"q":"x"}' },
    outputs: { output: noise(sizes.tool, 4) },
  });
  const root = run(
    {
      name: 'Yo! Agent',
      run_type: 'chain',
      inputs: { messages: [{ type: 'human', content: 'hi' }] },
      outputs: { messages: [{ type: 'ai', content: 'hello back' }] },
      extra: {
        metadata: { user_did: 'did:ixo:ixo1testuser', thread_id: '$t' },
      },
    },
    [chain, toolRun],
  );
  for (const child of [chain, toolRun]) child.parent_run_id = root.id;
  llm.parent_run_id = chain.id;
  const records = new Map<string, ModelCallRecord>([[llm.id, record()]]);
  return { root, llm, chain, toolRun, records };
}

function collected(
  root: Run,
  records = new Map<string, ModelCallRecord>(),
): CollectedTurn {
  return {
    root,
    status: 'success',
    error: null,
    endTime: (root.end_time ?? root.start_time) + 1,
    records,
    firstTokens: new Map(),
    context: {
      threadId: '$t',
      userId: 'did:ixo:ixo1testuser',
      userText: 'hi',
      metadata: { oracle_did: 'did:ixo:ixo1oracle', network: 'devnet' },
    },
  };
}

async function decode(bytes: Uint8Array) {
  return validTurn(JSON.parse(await gunzip(bytes)));
}

const limits = (overrides: Partial<EncodeLimits>): EncodeLimits => ({
  ...DEFAULT_ENCODE_LIMITS,
  ...overrides,
});

describe('encodeTurn: size limits', () => {
  it('sends a turn that fits whole, unmarked', async () => {
    const t = bigTurn({
      llmExtra: 1000,
      llmInputs: 1000,
      chain: 1000,
      tool: 1000,
    });
    const encoded = await encodeTurn(collected(t.root, t.records));
    expect(encoded?.droppedPayloads).toBe(0);
    const turn = await decode(encoded!.bytes);
    expect(turn.metadata.truncated).toBeUndefined();
    expect(turn.runs).toHaveLength(4);
  });

  it('drops the model call’s invocation params first, keeping its metadata', async () => {
    const t = bigTurn({
      llmExtra: 60_000,
      llmInputs: 20_000,
      chain: 20_000,
      tool: 20_000,
    });
    const encoded = await encodeTurn(
      collected(t.root, t.records),
      limits({ rawBudgetChars: 90_000 }),
    );
    const turn = await decode(encoded!.bytes);
    expect(turn.metadata).toMatchObject({
      truncated: 'true',
      truncated_payloads: '1',
    });
    const llm = turn.runs.find((r) => r.run_type === 'llm')!;
    expect(llm.extra).toEqual({
      metadata: expect.objectContaining({
        ls_model_name: 'openai/gpt-5.6-luna',
        served_model: 'openai/gpt-5.6-luna-20260709',
        fallback: false,
      }),
      _truncated: { chars: expect.any(Number) },
    });
    // The prompt is still there.
    expect(JSON.stringify(llm.inputs).length).toBeGreaterThan(20_000);
  });

  it('then the prompts, then the graph state, then tool results; the root last', async () => {
    const t = bigTurn({
      llmExtra: 30_000,
      llmInputs: 30_000,
      chain: 30_000,
      tool: 30_000,
    });
    const encoded = await encodeTurn(
      collected(t.root, t.records),
      limits({ rawBudgetChars: 40_000 }),
    );
    const turn = await decode(encoded!.bytes);
    const byName = new Map(turn.runs.map((r) => [r.name, r]));
    const truncated = (v: unknown) =>
      typeof v === 'object' && v !== null && '_truncated' in v;
    expect(truncated(byName.get('ChatOpenAICompletions')!.inputs)).toBe(true);
    expect(truncated(byName.get('model_request')!.inputs)).toBe(true);
    // Not needed to fit: the tool result and the root stay whole.
    expect(truncated(byName.get('lookup')!.outputs)).toBe(false);
    expect(byName.get('Yo! Agent')!.outputs).toEqual({
      messages: [{ type: 'ai', content: 'hello back' }],
    });
    expect(turn.reply_text).toBe('hello back');
  });

  it('fits the compressed limit with payloads that do not compress', async () => {
    const t = bigTurn({
      llmExtra: 200_000,
      llmInputs: 200_000,
      chain: 200_000,
      tool: 200_000,
    });
    const maxCompressedBytes = 300_000;
    const encoded = await encodeTurn(
      collected(t.root, t.records),
      limits({ maxCompressedBytes }),
    );
    expect(encoded!.bytes.byteLength).toBeLessThanOrEqual(maxCompressedBytes);
    expect(encoded!.droppedPayloads).toBeGreaterThan(0);
    const turn = await decode(encoded!.bytes);
    expect(turn.metadata.truncated).toBe('true');
    expect(turn.runs).toHaveLength(4);
  });

  it('never serializes a payload over the per-payload cap', async () => {
    const t = bigTurn({ llmExtra: 10, llmInputs: 10, chain: 10, tool: 50_000 });
    const encoded = await encodeTurn(
      collected(t.root, t.records),
      limits({ maxPayloadChars: 10_000 }),
    );
    const turn = await decode(encoded!.bytes);
    expect(turn.runs.find((r) => r.name === 'lookup')!.outputs).toEqual({
      _truncated: { chars: expect.any(Number) },
    });
    expect(turn.metadata.truncated).toBe('true');
  });

  it('keeps the first runs past the run cap, parents always before children', async () => {
    const children = Array.from({ length: 30 }, () =>
      run({ name: 'step', run_type: 'chain' }),
    );
    const root = run({ name: 'Yo! Agent', run_type: 'chain' }, children);
    for (const child of children) child.parent_run_id = root.id;
    const encoded = await encodeTurn(collected(root), limits({ maxRuns: 10 }));
    const turn = await decode(encoded!.bytes);
    expect(turn.runs).toHaveLength(10);
    expect(turn.metadata).toMatchObject({
      truncated: 'true',
      omitted_runs: '21',
    });
  });

  it('keeps every field inside the contract limits', async () => {
    const root = run({
      name: 'x'.repeat(400),
      run_type: 'weird-type',
      error: 'e'.repeat(TURN_LIMITS.maxErrorLength + 100),
      tags: [
        ...Array.from({ length: 40 }, (_, i) => `tag-${i}`),
        'y'.repeat(200),
      ],
      extra: {
        metadata: {
          'bad key!': 'dropped',
          long_value: 'v'.repeat(2_000),
          nested: { not: 'a string' },
          count: 3,
          ...Object.fromEntries(
            Array.from({ length: 80 }, (_, i) => [`k${i}`, 'v']),
          ),
        },
      },
      events: Array.from({ length: TURN_LIMITS.maxEventsPerRun + 5 }, () => ({
        name: 'text',
        time: new Date().toISOString(),
      })),
    });
    const turn = collected(root);
    turn.status = 'error';
    turn.error = 'boom';
    const encoded = await encodeTurn(turn);
    const sent = await decode(encoded!.bytes);
    expect(sent.name).toHaveLength(TURN_LIMITS.maxNameLength);
    expect(sent.runs[0]!.run_type).toBe('chain');
    expect(sent.tags).toHaveLength(TURN_LIMITS.maxTags);
    expect(Object.keys(sent.metadata).length).toBeLessThanOrEqual(
      TURN_LIMITS.maxMetadataKeys,
    );
    expect(sent.metadata.oracle_did).toBe('did:ixo:ixo1oracle');
    expect(sent.metadata.count).toBe('3');
    expect(sent.metadata['bad key!']).toBeUndefined();
    expect(sent.metadata.long_value).toHaveLength(
      TURN_LIMITS.maxMetadataValueLength,
    );
  });
});

describe('approxJsonChars', () => {
  it('stops walking once past its limit', () => {
    const big = {
      a: 'x'.repeat(1_000),
      b: Array.from({ length: 1_000 }, () => 'y'.repeat(100)),
    };
    expect(approxJsonChars(big, 500)).toBeLessThan(5_000);
    expect(approxJsonChars(big, Number.MAX_SAFE_INTEGER)).toBeGreaterThan(
      100_000,
    );
  });

  it('survives cycles', () => {
    const a: Record<string, unknown> = { name: 'a' };
    a.self = a;
    expect(approxJsonChars(a, 1_000)).toBeLessThan(100);
  });
});

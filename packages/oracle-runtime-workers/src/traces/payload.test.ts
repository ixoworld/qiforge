import type { Run } from '@langchain/core/tracers/base';
import { describe, expect, it } from 'vitest';
import type { ModelCallRecord, ModelCallReport } from '../llm/model-call';
import { TURN_LIMITS } from './contract';
import {
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
      limits({ maxInflatedBytes: 90_000 }),
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
      limits({ maxInflatedBytes: 40_000 }),
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

/** A seeded generator (mulberry32): the property tests are reproducible. */
function prng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Text mixing ASCII, 2-, 3- and 4-byte UTF-8 and escapes; sliced from one pool. */
const MIXED_POOL = (() => {
  const rand = prng(99);
  const alphabet = [
    'a',
    'Z',
    '7',
    ' ',
    'é',
    'ж',
    '漢',
    '字',
    '😀',
    '"',
    '\\',
    '\n',
    '\u0001',
  ];
  const parts: string[] = [];
  for (let i = 0; i < 200_000; i += 1)
    parts.push(alphabet[Math.floor(rand() * alphabet.length)]!);
  return parts.join('');
})();

function mixedText(rand: () => number, chars: number): string {
  const n = Math.min(chars, MIXED_POOL.length);
  const start = Math.floor(rand() * (MIXED_POOL.length - n));
  return MIXED_POOL.slice(start, start + n);
}

/** A random run tree: nesting, fan-out, payload sizes and kinds all drawn from `rand`. */
function randomTree(
  rand: () => number,
  opts: { runs: number; maxPayload: number; maxDepth: number },
): { root: Run; records: Map<string, ModelCallRecord> } {
  const records = new Map<string, ModelCallRecord>();
  const types = ['chain', 'llm', 'tool', 'retriever'] as const;
  const root = run({ name: 'Yo! Agent', run_type: 'chain' });
  const all: Array<{ r: Run; depth: number }> = [{ r: root, depth: 0 }];
  for (let i = 1; i < opts.runs; i += 1) {
    const candidates = all.filter((x) => x.depth < opts.maxDepth);
    const parent = candidates[Math.floor(rand() * candidates.length)]!;
    const type = types[Math.floor(rand() * types.length)]!;
    const size = Math.floor(rand() ** 3 * opts.maxPayload);
    const child = run({
      name: `${type}-${i}`,
      run_type: type,
      parent_run_id: parent.r.id,
      inputs: { text: mixedText(rand, size) },
      outputs:
        rand() < 0.5 ? { output: mixedText(rand, size) } : { list: [size] },
      ...(rand() < 0.1 ? { error: mixedText(rand, 20_000) } : {}),
    });
    parent.r.child_runs.push(child);
    all.push({ r: child, depth: parent.depth + 1 });
    if (type === 'llm')
      records.set(
        child.id,
        record({
          promptTokens: Math.floor(rand() * 5_000),
          costUsd: rand() / 100,
        }),
      );
  }
  return { root, records };
}

async function decodeWhole(bytes: Uint8Array) {
  const text = await gunzip(bytes);
  return { text, turn: validTurn(JSON.parse(text)) };
}

describe('encodeTurn: always accepted', () => {
  const small: EncodeLimits = {
    maxCompressedBytes: 120_000,
    maxInflatedBytes: 400_000,
    maxPayloadChars: 60_000,
    maxRuns: 400,
  };

  it('fits every random turn under both caps and the contract (seeded property test)', async () => {
    for (let seed = 1; seed <= 40; seed += 1) {
      const rand = prng(seed);
      const { root, records } = randomTree(rand, {
        runs: 1 + Math.floor(rand() * 600),
        maxPayload: 80_000,
        maxDepth: 1 + Math.floor(rand() * 40),
      });
      const encoded = await encodeTurn(collected(root, records), small);
      expect(encoded, `seed ${seed}`).toBeDefined();
      expect(encoded!.bytes.byteLength).toBeLessThanOrEqual(
        small.maxCompressedBytes,
      );
      const { text, turn } = await decodeWhole(encoded!.bytes);
      // The service measures the inflated body in UTF-8 bytes.
      expect(new TextEncoder().encode(text).byteLength).toBe(encoded!.rawBytes);
      expect(encoded!.rawBytes).toBeLessThanOrEqual(small.maxInflatedBytes);
      // The usage always counts every model call of the tree, whatever was cut.
      expect(turn.usage.input_tokens).toBe(
        [...records.values()].reduce((s, r) => s + (r.promptTokens ?? 0), 0),
      );
      expect(turn.runs[0]!.id).toBe(root.id);
    }
  });

  it('cuts a turn of multi-byte text by its UTF-8 size, not its length', async () => {
    const tools = Array.from({ length: 6 }, () =>
      run({
        name: 'lookup',
        run_type: 'tool',
        outputs: { output: '漢'.repeat(100_000) },
      }),
    );
    const root = run({ name: 'Yo! Agent', run_type: 'chain' }, tools);
    for (const t of tools) t.parent_run_id = root.id;
    const encoded = await encodeTurn(
      collected(root),
      limits({ maxInflatedBytes: 1_000_000 }),
    );
    // 600k characters fit a 1 MB "length"; as UTF-8 they are 1.8 MB.
    expect(encoded!.rawBytes).toBeLessThanOrEqual(1_000_000);
    expect(encoded!.droppedPayloads).toBeGreaterThan(0);
    await decodeWhole(encoded!.bytes);
  });

  it('keeps a turn of huge tool outputs under the service’s 16 MiB with the default limits', async () => {
    const tools = Array.from({ length: 8 }, (_, i) =>
      run({
        name: 'big_tool',
        run_type: 'tool',
        outputs: { output: noise(3_900_000, i + 10) },
      }),
    );
    const root = run({ name: 'Yo! Agent', run_type: 'chain' }, tools);
    for (const t of tools) t.parent_run_id = root.id;
    const encoded = await encodeTurn(collected(root));
    expect(encoded!.rawBytes).toBeLessThanOrEqual(
      TURN_LIMITS.maxDecompressedBytes - 1024 * 1024,
    );
    expect(encoded!.bytes.byteLength).toBeLessThanOrEqual(
      TURN_LIMITS.maxCompressedBytes - 512 * 1024,
    );
    const { turn } = await decodeWhole(encoded!.bytes);
    expect(turn.runs).toHaveLength(9);
    expect(turn.metadata.truncated).toBe('true');
  });

  it('leaves out the last runs when the skeletons alone are too large, parents first', async () => {
    const children = Array.from({ length: 300 }, () =>
      run({ name: 'failing', run_type: 'tool', error: 'x'.repeat(16_000) }),
    );
    const root = run({ name: 'Yo! Agent', run_type: 'chain' }, children);
    for (const c of children) c.parent_run_id = root.id;
    const encoded = await encodeTurn(
      collected(root),
      limits({ maxInflatedBytes: 500_000, maxCompressedBytes: 200_000 }),
    );
    const { turn } = await decodeWhole(encoded!.bytes);
    expect(turn.runs.length).toBeLessThan(301);
    expect(Number(turn.metadata.omitted_runs)).toBe(301 - turn.runs.length);
  });

  it('sends a deep nesting of runs and of payloads that the service accepts', async () => {
    // 400 nested runs: the dotted order would pass 8 KiB.
    const runs: Run[] = [run({ name: 'Yo! Agent', run_type: 'chain' })];
    for (let i = 1; i < 400; i += 1) {
      const child = run({
        name: `level-${i}`,
        run_type: 'chain',
        parent_run_id: runs[i - 1]!.id,
      });
      runs[i - 1]!.child_runs.push(child);
      runs.push(child);
    }
    // A payload nested 500 levels deep.
    let deep: Record<string, unknown> = { leaf: true };
    for (let i = 0; i < 500; i += 1) deep = { next: deep };
    runs[1]!.outputs = deep;
    const encoded = await encodeTurn(collected(runs[0]!));
    const { turn } = await decodeWhole(encoded!.bytes);
    expect(turn.runs.length).toBeGreaterThan(100);
    expect(turn.runs.length).toBeLessThan(400);
    expect(JSON.stringify(turn.runs[1]!.outputs)).toContain('"_truncated"');
  });
});

describe('encodeTurn: robust to any value', () => {
  it('sends a valid turn whatever the payloads hold', async () => {
    const circular: Record<string, unknown> = { name: 'loop' };
    circular.self = circular;
    const revoked = Proxy.revocable({}, {});
    revoked.revoke();
    const throwingGetter = {
      get boom(): string {
        throw new Error('getter');
      },
      fine: 1,
    };
    const error = Object.assign(new Error('D1_ERROR: overloaded'), {
      code: 'SQLITE_BUSY',
    });
    const tool = run({
      name: 'odd',
      run_type: 'tool',
      inputs: {
        big: 12345678901234567890n,
        when: new Date(1_764_000_000_000),
        never: new Date(Number.NaN),
        missing: undefined,
        fn: () => 1,
        sym: Symbol('s'),
        circular,
        bytes: new Uint8Array(1024),
        buffer: new ArrayBuffer(16),
        view: new DataView(new ArrayBuffer(8)),
        error,
        map: new Map<unknown, unknown>([
          ['a', 1],
          [2, 'b'],
        ]),
        objectKeys: new Map<unknown, unknown>([[{ k: 1 }, 'v']]),
        set: new Set([1, 2, 2]),
        list: [undefined, () => 1, Number.NaN, Infinity, -0],
        throwingGetter,
        badToJSON: {
          toJSON() {
            throw new Error('nope');
          },
        },
        revoked: revoked.proxy,
        $blob: 'reserved by the service',
      },
    });
    // What LangChain types as objects, handed over as something else.
    Reflect.set(tool, 'outputs', ['an', 'array']);
    Reflect.set(tool, 'events', ['not an object']);
    const root = run({ name: 'Yo! Agent', run_type: 'chain' }, [tool]);
    tool.parent_run_id = root.id;
    const encoded = await encodeTurn(collected(root));
    const { turn } = await decodeWhole(encoded!.bytes);
    const inputs = turn.runs[1]!.inputs!;
    expect(inputs).toMatchObject({
      big: '12345678901234567890',
      when: new Date(1_764_000_000_000).toISOString(),
      never: null,
      circular: { name: 'loop', self: '[Circular]' },
      bytes: { _binary: { type: 'Uint8Array', bytes: 1024 } },
      buffer: { _binary: { type: 'ArrayBuffer', bytes: 16 } },
      view: { _binary: { type: 'DataView', bytes: 8 } },
      error: {
        name: 'Error',
        message: 'D1_ERROR: overloaded',
        code: 'SQLITE_BUSY',
      },
      map: { a: 1, '2': 'b' },
      objectKeys: [[{ k: 1 }, 'v']],
      set: [1, 2],
      list: [null, null, null, null, 0],
      throwingGetter: { boom: '[Unserializable]', fine: 1 },
      badToJSON: '[Unserializable]',
      _$blob: 'reserved by the service',
    });
    expect(inputs).not.toHaveProperty('missing');
    expect(inputs).not.toHaveProperty('fn');
    expect(inputs).not.toHaveProperty('sym');
    expect(turn.runs[1]!.outputs).toEqual({ value: ['an', 'array'] });
    expect(turn.runs[1]!.events).toEqual([{ value: 'not an object' }]);
  });

  it('sends finite, non-negative, whole token counts and bounded costs', async () => {
    const llm = run({ name: 'model', run_type: 'llm' });
    const other = run({ name: 'model', run_type: 'llm' });
    const root = run({ name: 'Yo! Agent', run_type: 'chain' }, [llm, other]);
    llm.parent_run_id = root.id;
    other.parent_run_id = root.id;
    const records = new Map<string, ModelCallRecord>([
      [
        llm.id,
        record({
          promptTokens: Number.NaN,
          cachedTokens: -5,
          outputTokens: 1e20,
          costUsd: Infinity,
        }),
      ],
      [other.id, record({ promptTokens: 1.6, outputTokens: 2, costUsd: -1 })],
    ]);
    const { turn } = await decodeWhole(
      (await encodeTurn(collected(root, records)))!.bytes,
    );
    expect(turn.usage).toEqual({
      input_tokens: 2,
      cached_tokens: 800,
      output_tokens: TURN_LIMITS.maxTokens,
      cost_usd: 0,
    });
    const sent = turn.runs.find((r) => r.id === llm.id)!;
    expect(sent).toMatchObject({
      prompt_tokens: 0,
      completion_tokens: TURN_LIMITS.maxTokens,
      total_cost: 0,
    });
  });

  it('sends valid times and ids whatever the runs and the context say', async () => {
    const odd = run({
      name: 'odd',
      run_type: 'tool',
      start_time: Number.NaN,
      end_time: Number.POSITIVE_INFINITY,
    });
    const root = run({ name: '', run_type: 'chain' }, [odd]);
    odd.parent_run_id = root.id;
    const turn = collected(root);
    turn.endTime = Number.NaN;
    turn.context = { ...turn.context, threadId: '', userId: '\u0000\u0007' };
    turn.firstTokens = new Map([[odd.id, Number.NaN]]);
    const { turn: sent } = await decodeWhole((await encodeTurn(turn))!.bytes);
    expect(sent.thread_id).toBe('unknown');
    expect(sent.user_id).toBe('unknown');
    expect(sent.name).toBe('chain');
  });

  it('never sends a run with an empty or missing id (nor its subtree)', async () => {
    const grandchild = run({ name: 'below', run_type: 'tool' });
    const empty = run({ name: 'empty-id', run_type: 'chain', id: '' }, [
      grandchild,
    ]);
    const missing = run({ name: 'missing-id', run_type: 'tool' });
    Reflect.deleteProperty(missing, 'id');
    const fine = run({ name: 'fine', run_type: 'tool' });
    const root = run({ name: 'Yo! Agent', run_type: 'chain' }, [
      empty,
      missing,
      fine,
    ]);
    for (const child of [empty, missing, fine]) child.parent_run_id = root.id;
    grandchild.parent_run_id = '';
    const { turn } = await decodeWhole(
      (await encodeTurn(collected(root)))!.bytes,
    );
    expect(turn.runs.map((r) => r.name)).toEqual(['Yo! Agent', 'fine']);
    expect(turn.runs.every((r) => r.id.length === 36)).toBe(true);
    expect(turn.metadata.omitted_runs).toBe('3');
  });

  it('never sends a turn whose trace id is empty', async () => {
    const root = run({ name: 'Yo! Agent', run_type: 'chain', id: '' });
    expect(await encodeTurn(collected(root))).toBeUndefined();
  });

  it('cannot send a root whose id is not a UUID (and never throws)', async () => {
    const root = run({
      name: 'Yo! Agent',
      run_type: 'chain',
      id: 'not-a-uuid',
    });
    expect(await encodeTurn(collected(root))).toBeUndefined();
  });
});

describe('encodeTurn: calls made outside the graph', () => {
  const report = (over: Partial<ModelCallReport>): ModelCallReport => ({
    ...record({
      promptTokens: 100,
      cachedTokens: 0,
      outputTokens: 5,
      costUsd: 0.001,
    }),
    purpose: 'routing',
    callId: crypto.randomUUID(),
    startedAt: 1_764_000_000_000,
    ...over,
  });

  it('counts each once in the usage and sends each as an llm run under the root', async () => {
    const t = bigTurn({ llmExtra: 10, llmInputs: 10, chain: 10, tool: 10 });
    const router = report({
      purpose: 'routing',
      requestedModel: 'router-model',
    });
    const summary = report({ purpose: 'summarization', costUsd: 0.002 });
    const turn = collected(t.root, t.records);
    // The same call twice, and a call that is a run of the tree: once each.
    turn.outsideCalls = [
      router,
      summary,
      router,
      report({ callId: t.llm.id, costUsd: 5 }),
    ];
    const { turn: sent } = await decodeWhole((await encodeTurn(turn))!.bytes);
    const tree = record();
    expect(sent.usage.cost_usd).toBeCloseTo(tree.costUsd! + 0.001 + 0.002, 10);
    expect(sent.usage.input_tokens).toBe(tree.promptTokens! + 200);
    const outside = sent.runs.filter((r) => r.tags?.includes('outside_graph'));
    expect(outside.map((r) => r.name).sort()).toEqual([
      'routing model call',
      'summarization model call',
    ]);
    for (const r of outside) {
      expect(r.parent_run_id).toBe(t.root.id);
      expect(r.run_type).toBe('llm');
    }
    expect(outside.find((r) => r.id === router.callId)).toMatchObject({
      prompt_tokens: 100,
      total_cost: 0.001,
      extra: {
        metadata: expect.objectContaining({ ls_model_name: 'router-model' }),
      },
    });
  });
});

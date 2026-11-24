/* eslint-disable no-console -- the measurements are this suite's output */
import { awaitAllCallbacks } from '@langchain/core/callbacks/promises';
import { RunnableLambda } from '@langchain/core/runnables';
import type { Run } from '@langchain/core/tracers/base';
import { describe, expect, it } from 'vitest';
import type { ModelCallRecord } from '../llm/model-call';
import { encodeTurn } from './payload';
import { record, tracerHarness } from './test-helpers';

/**
 * What the tracer costs a turn. Plain Node (workerd freezes the clock during
 * synchronous work, so timings are only meaningful here). The numbers are
 * logged; the bounds are generous so a slow CI machine does not fail them.
 */
describe('TurnTracer overhead', () => {
  it('does constant, tiny work per callback', async () => {
    const h = tracerHarness({ startMarker: false });
    const n = 5_000;
    const ids = Array.from(
      { length: n },
      (_, i) =>
        `0192f5d8-0000-7000-8000-${(i + 1).toString(16).padStart(12, '0')}`,
    );
    const rootId = '0192f5d8-0000-7000-8001-000000000000';
    const big = {
      messages: Array.from({ length: 200 }, () => ({
        content: 'x'.repeat(2_000),
      })),
    };
    await h.tracer.handleChainStart(
      { lc: 1, type: 'not_implemented', id: ['root'] },
      big,
      rootId,
      undefined,
      [],
      {},
      'chain',
      'root',
    );
    const started = performance.now();
    for (const id of ids) {
      // Large inputs and outputs cost nothing extra: only references are kept.
      await h.tracer.handleChainStart(
        { lc: 1, type: 'not_implemented', id: ['step'] },
        big,
        id,
        rootId,
        [],
        { k: 'v' },
        'chain',
        'step',
      );
      await h.tracer.handleChainEnd(big, id);
    }
    const perRunMs = (performance.now() - started) / n;
    console.log(
      `[overhead] start+end of one run: ${(perRunMs * 1000).toFixed(1)} µs (n=${n}, 400 KB payload each)`,
    );
    expect(perRunMs).toBeLessThan(0.5);

    const tokenRun = '0192f5d8-0000-7000-8002-000000000000';
    await h.tracer.handleChatModelStart(
      { lc: 1, type: 'not_implemented', id: ['model'] },
      [[]],
      tokenRun,
      rootId,
    );
    const tokens = 20_000;
    const tokenStart = performance.now();
    for (let i = 0; i < tokens; i += 1)
      await h.tracer.handleLLMNewToken(
        't',
        { prompt: 0, completion: 0 },
        tokenRun,
      );
    const perTokenUs = ((performance.now() - tokenStart) / tokens) * 1000;
    console.log(
      `[overhead] one streamed token: ${perTokenUs.toFixed(2)} µs (nothing kept)`,
    );
    expect(perTokenUs).toBeLessThan(100);
  });

  it('adds little to a graph of runnables', async () => {
    const steps = 300;
    const step = RunnableLambda.from(async (x: number) => x + 1).withConfig({
      runName: 'step',
    });
    const agent = RunnableLambda.from(async (x: number, config) => {
      let v = x;
      for (let i = 0; i < steps; i += 1) v = await step.invoke(v, config);
      return v;
    }).withConfig({ runName: 'Yo! Agent' });
    const time = async (callbacks: unknown[]) => {
      const started = performance.now();
      for (let i = 0; i < 5; i += 1) {
        await agent.invoke(0, {
          callbacks: callbacks.length
            ? [tracerHarness({ startMarker: false }).tracer]
            : [],
        });
        await awaitAllCallbacks();
      }
      return (performance.now() - started) / 5;
    };
    await time([]);
    const without = await time([]);
    const withTracer = await time([1]);
    console.log(
      `[overhead] ${steps}-run turn: ${without.toFixed(1)} ms without, ${withTracer.toFixed(1)} ms with the tracer (${(((withTracer - without) / steps) * 1000).toFixed(1)} µs per run)`,
    );
    expect((withTracer - without) / steps).toBeLessThan(0.5);
  });

  it('builds and gzips a realistic turn after the reply in milliseconds', async () => {
    // A Yo turn: 18 runs, 2 model calls with ~400 KB prompts and ~75 KB of tool schemas.
    const prompt = Array.from(
      { length: 400 },
      (_, i) => `line ${i}: ${'lorem ipsum dolor sit amet '.repeat(36)}`,
    ).join('\n');
    const schemas = JSON.stringify(
      Array.from({ length: 40 }, (_, i) => ({
        name: `tool_${i}`,
        description: 'd'.repeat(1_500),
        parameters: { type: 'object' },
      })),
    );
    let seq = 0;
    const id = () =>
      `0192f5d8-0000-7000-8003-${(++seq).toString(16).padStart(12, '0')}`;
    const mk = (
      name: string,
      run_type: string,
      fields: Partial<Run> = {},
    ): Run => ({
      id: id(),
      name,
      run_type,
      start_time: Date.now(),
      end_time: Date.now() + 5,
      execution_order: seq,
      child_execution_order: seq,
      events: [],
      inputs: {},
      child_runs: [],
      ...fields,
    });
    const root = mk('Yo! Agent', 'chain', {
      outputs: { messages: [{ type: 'ai', content: 'hi' }] },
    });
    const records = new Map<string, ModelCallRecord>();
    for (let i = 0; i < 16; i += 1) {
      const isModel = i === 3 || i === 10;
      const child = isModel
        ? mk('ChatOpenAICompletions', 'llm', {
            inputs: { messages: [[{ role: 'system', content: prompt }]] },
            outputs: { generations: [[{ text: 'ok' }]] },
            extra: {
              invocation_params: { tools: schemas },
              metadata: { ls_model_name: 'm' },
            },
          })
        : mk(
            i % 4 === 0 ? 'lookup' : 'RunnableLambda',
            i % 4 === 0 ? 'tool' : 'chain',
            {
              inputs: { input: 'x'.repeat(100) },
              outputs: { output: 'y'.repeat(1_100) },
            },
          );
      child.parent_run_id = root.id;
      root.child_runs.push(child);
      if (isModel) records.set(child.id, record());
    }
    const started = performance.now();
    const encoded = await encodeTurn({
      root,
      status: 'success',
      error: null,
      endTime: Date.now() + 10,
      records,
      firstTokens: new Map(),
      context: { threadId: 't', userId: 'u', metadata: {} },
    });
    const ms = performance.now() - started;
    console.log(
      `[overhead] build+gzip of a ${(encoded!.rawBytes / 1024).toFixed(0)} KiB turn: ${ms.toFixed(1)} ms → ${(encoded!.bytes.byteLength / 1024).toFixed(0)} KiB`,
    );
    expect(ms).toBeLessThan(1_000);
  });
});

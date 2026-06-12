import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import type { PluginTool } from '../../plugin-api/types.js';
import { makeRuntimeContext } from '../../registries/test-fixtures.js';
import { InMemoryBlueprintStore } from './blueprint-store.js';
import { createOrchestrationTools } from './orchestration-tools.js';
import { SPECIALISTS_FOR_STAGE, STAGE_ORDER } from './stage.js';

function byName(tools: PluginTool[], name: string): PluginTool {
  const found = tools.find((t) => t.name === name);
  if (!found) {
    throw new Error(`tool ${name} not found`);
  }
  return found;
}

const startShape = z.object({ started: z.boolean(), stage: z.string() });
const recordShape = z.object({
  recorded: z.string(),
  stage: z.string(),
  complete: z.boolean(),
  score: z.number(),
});
const readinessShape = z.object({
  complete: z.boolean(),
  stage: z.string(),
  score: z.number(),
  blockers: z.array(z.string()),
});
const assembleShape = z.object({
  assembled: z.boolean(),
  blueprint: z
    .object({
      threadId: z.string(),
      stages: z.record(z.string(), z.array(z.unknown())),
    })
    .optional(),
  blockers: z.array(z.string()).optional(),
});

describe('orchestration tools', () => {
  it('runs the full design lifecycle from start to assemble', async () => {
    const tools = createOrchestrationTools(new InMemoryBlueprintStore());
    const ctx = makeRuntimeContext();

    const start = startShape.parse(
      await byName(tools, 'start_pod_design').handler(
        { brief: 'Solar POD' },
        ctx,
      ),
    );
    expect(start.started).toBe(true);
    expect(start.stage).toBe('qualify');

    const record = byName(tools, 'record_blueprint_section');
    for (const stage of STAGE_ORDER) {
      for (const role of SPECIALISTS_FOR_STAGE[stage]) {
        await record.handler(
          { role, content: { ok: true }, verdict: 'pass' },
          ctx,
        );
      }
    }

    const readiness = readinessShape.parse(
      await byName(tools, 'compute_readiness').handler({}, ctx),
    );
    expect(readiness.complete).toBe(true);
    expect(readiness.score).toBe(1);

    const assembled = assembleShape.parse(
      await byName(tools, 'assemble_blueprint').handler({}, ctx),
    );
    expect(assembled.assembled).toBe(true);
    expect(assembled.blueprint?.threadId).toBe(ctx.session.id);
  });

  it('blocks assembly until the gate passes', async () => {
    const tools = createOrchestrationTools(new InMemoryBlueprintStore());
    const ctx = makeRuntimeContext();
    await byName(tools, 'start_pod_design').handler({ brief: 'x' }, ctx);

    const record = recordShape.parse(
      await byName(tools, 'record_blueprint_section').handler(
        { role: 'service_intent_scorer', content: { score: 0.8 } },
        ctx,
      ),
    );
    expect(record.recorded).toBe('service_intent_scorer');
    expect(record.complete).toBe(false);
    expect(record.stage).toBe('architect');

    const assembled = assembleShape.parse(
      await byName(tools, 'assemble_blueprint').handler({}, ctx),
    );
    expect(assembled.assembled).toBe(false);
    expect(assembled.blockers?.length ?? 0).toBeGreaterThan(0);
  });

  it('persists across a fresh RuntimeContext and rejects unknown roles', async () => {
    const store = new InMemoryBlueprintStore();
    const tools = createOrchestrationTools(store);
    await byName(tools, 'start_pod_design').handler(
      { brief: 'persist' },
      makeRuntimeContext(),
    );
    await byName(tools, 'record_blueprint_section').handler(
      { role: 'service_architect', content: { roles: [] } },
      makeRuntimeContext(),
    );

    // A brand-new context (same default session id) still sees the section,
    // proving the blueprint lives on the store, not in the RuntimeContext.
    const got = await byName(tools, 'get_blueprint').handler(
      {},
      makeRuntimeContext(),
    );
    const shape = z.object({
      started: z.boolean(),
      blueprint: z.object({ sections: z.record(z.string(), z.unknown()) }),
    });
    const parsed = shape.parse(got);
    expect(parsed.started).toBe(true);
    expect(Object.keys(parsed.blueprint.sections)).toContain(
      'service_architect',
    );

    await expect(
      byName(tools, 'record_blueprint_section').handler(
        { role: 'not_a_role', content: {} },
        makeRuntimeContext(),
      ),
    ).rejects.toThrow();
  });
});

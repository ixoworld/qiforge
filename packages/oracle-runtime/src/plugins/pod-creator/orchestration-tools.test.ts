import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import type { PluginTool } from '../../plugin-api/types.js';
import { makeRuntimeContext } from '../../registries/test-fixtures.js';
import { InMemoryBlueprintStore } from './blueprint-store.js';
import { DESIGN_POD_ROLES } from './design-pod-roles.js';
import { createOrchestrationTools } from './orchestration-tools.js';

const ISO = '2026-06-12T00:00:00.000Z';

function byName(tools: PluginTool[], name: string): PluginTool {
  const found = tools.find((t) => t.name === name);
  if (!found) {
    throw new Error(`tool ${name} not found`);
  }
  return found;
}

/** Seed sections the way production does — through the specialists' write path. */
async function seedRoles(
  store: InMemoryBlueprintStore,
  thread: string,
  roleIds: readonly string[],
): Promise<void> {
  for (const role of DESIGN_POD_ROLES) {
    if (!roleIds.includes(role.id)) {
      continue;
    }
    await store.putSection(thread, {
      role: role.id,
      stage: role.stage,
      content: { ok: true },
      recordedAt: ISO,
      verdict: 'pass',
    });
  }
}

const startShape = z.object({
  started: z.boolean(),
  stage: z.string(),
  brief: z.string().optional(),
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
const blueprintShape = z.object({
  started: z.boolean(),
  brief: z.string().optional(),
  readiness: readinessShape,
  sections: z.array(
    z.object({
      role: z.string(),
      stage: z.string(),
      recordedAt: z.string(),
      contentBytes: z.number(),
    }),
  ),
  content: z.record(z.string(), z.unknown()).optional(),
});

describe('orchestration tools', () => {
  it('gives the conductor no blueprint write path — sections come only from specialists', () => {
    const tools = createOrchestrationTools(new InMemoryBlueprintStore());
    expect(tools.map((t) => t.name).sort()).toEqual([
      'assemble_blueprint',
      'compute_readiness',
      'get_blueprint',
      'start_pod_design',
    ]);
  });

  it('runs the lifecycle from start to assemble once every specialist passed', async () => {
    const store = new InMemoryBlueprintStore();
    const tools = createOrchestrationTools(store);
    const ctx = makeRuntimeContext();

    const start = startShape.parse(
      await byName(tools, 'start_pod_design').handler(
        { brief: 'Solar POD' },
        ctx,
      ),
    );
    expect(start.started).toBe(true);
    expect(start.stage).toBe('qualify');

    await seedRoles(
      store,
      ctx.session.id,
      DESIGN_POD_ROLES.map((role) => role.id),
    );

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
    const store = new InMemoryBlueprintStore();
    const tools = createOrchestrationTools(store);
    const ctx = makeRuntimeContext();
    await byName(tools, 'start_pod_design').handler({ brief: 'x' }, ctx);
    await seedRoles(store, ctx.session.id, ['service_intent_scorer']);

    const assembled = assembleShape.parse(
      await byName(tools, 'assemble_blueprint').handler({}, ctx),
    );
    expect(assembled.assembled).toBe(false);
    expect(assembled.blockers?.length ?? 0).toBeGreaterThan(0);
  });

  it('get_blueprint returns a compact summary, with full content only for requested roles', async () => {
    const store = new InMemoryBlueprintStore();
    const tools = createOrchestrationTools(store);
    const ctx = makeRuntimeContext();
    await byName(tools, 'start_pod_design').handler({ brief: 'persist' }, ctx);
    await seedRoles(store, ctx.session.id, [
      'service_intent_scorer',
      'service_architect',
    ]);

    // A brand-new context (same default session id) still sees the sections,
    // proving the blueprint lives on the store, not in the RuntimeContext.
    const summary = blueprintShape.parse(
      await byName(tools, 'get_blueprint').handler({}, makeRuntimeContext()),
    );
    expect(summary.started).toBe(true);
    expect(summary.sections.map((s) => s.role).sort()).toEqual([
      'service_architect',
      'service_intent_scorer',
    ]);
    expect(summary.content).toBeUndefined();

    const detailed = blueprintShape.parse(
      await byName(tools, 'get_blueprint').handler(
        { roles: ['service_architect'] },
        makeRuntimeContext(),
      ),
    );
    expect(Object.keys(detailed.content ?? {})).toEqual(['service_architect']);
  });

  it('start_pod_design with restart discards the previous design', async () => {
    const store = new InMemoryBlueprintStore();
    const tools = createOrchestrationTools(store);
    const ctx = makeRuntimeContext();
    await byName(tools, 'start_pod_design').handler({ brief: 'first' }, ctx);
    await seedRoles(store, ctx.session.id, ['service_intent_scorer']);

    const restarted = startShape.parse(
      await byName(tools, 'start_pod_design').handler(
        { brief: 'second', restart: true },
        ctx,
      ),
    );
    expect(restarted.brief).toBe('second');
    expect(restarted.stage).toBe('qualify');

    const bp = blueprintShape.parse(
      await byName(tools, 'get_blueprint').handler({}, ctx),
    );
    expect(bp.brief).toBe('second');
    expect(bp.sections).toEqual([]);
  });
});

import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { makeRuntimeContext } from '../../core/test-fixtures';
import { createMemoryUserKv } from '../../core/user-kv';
import type { PluginTool } from '../../plugin-api/types';
import { KvBlueprintStore } from './blueprint-store';
import { KvCreateSessionStore } from './create-session-store';
import { createOrchestrationTools } from './orchestration-tools';
import { ALL_ROLE_IDS, byName, seedRoles, USER } from './test-fixtures';

function setup(): {
  store: KvBlueprintStore;
  sessions: KvCreateSessionStore;
  tools: PluginTool[];
} {
  const store = new KvBlueprintStore(createMemoryUserKv());
  const sessions = new KvCreateSessionStore(createMemoryUserKv());
  return {
    store,
    sessions,
    tools: createOrchestrationTools(
      () => store,
      () => sessions,
    ),
  };
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
    const { tools } = setup();
    expect(tools.map((t) => t.name).sort()).toEqual([
      'assemble_blueprint',
      'compute_readiness',
      'get_blueprint',
      'start_pod_design',
    ]);
  });

  it('runs the lifecycle from start to assemble once every specialist passed', async () => {
    const { store, tools } = setup();
    const ctx = makeRuntimeContext();

    const start = startShape.parse(
      await byName(tools, 'start_pod_design').handler(
        { brief: 'Solar POD' },
        ctx,
      ),
    );
    expect(start.started).toBe(true);
    expect(start.stage).toBe('qualify');

    await seedRoles(store, ctx.session.id, ALL_ROLE_IDS);

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
    const { store, tools } = setup();
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
    const { store, tools } = setup();
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
    const { store, tools } = setup();
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

  it('marks only the read-only tools as reads (a resumed turn may re-run them)', () => {
    const { tools } = setup();
    const reads = tools
      .filter((t) => t.effect === 'read')
      .map((t) => t.name)
      .sort();
    expect(reads).toEqual([
      'assemble_blueprint',
      'compute_readiness',
      'get_blueprint',
    ]);
  });

  it('start_pod_design with restart also discards a batch prepared or approved for the old design', async () => {
    const { sessions, tools } = setup();
    const ctx = makeRuntimeContext();
    await byName(tools, 'start_pod_design').handler({ brief: 'first' }, ctx);
    await sessions.prepared(USER, ctx.session.id, 'blob_a', 'req-prepare');
    expect(
      await sessions.approve(USER, ctx.session.id, 'blob_a', 'req-later'),
    ).toBe('approved');

    await byName(tools, 'start_pod_design').handler(
      { brief: 'second', restart: true },
      ctx,
    );

    expect(await sessions.consume(USER, ctx.session.id, 'blob_a')).toBe(false);
    expect(
      await sessions.approve(USER, ctx.session.id, 'blob_a', 'req-later'),
    ).toBe('not-prepared');
  });

  it('start_pod_design without restart leaves a prepared batch alone', async () => {
    const { sessions, tools } = setup();
    const ctx = makeRuntimeContext();
    await byName(tools, 'start_pod_design').handler({ brief: 'first' }, ctx);
    await sessions.prepared(USER, ctx.session.id, 'blob_a', 'req-prepare');
    await byName(tools, 'start_pod_design').handler({ brief: 'again' }, ctx);
    expect(
      await sessions.approve(USER, ctx.session.id, 'blob_a', 'req-later'),
    ).toBe('approved');
  });
});

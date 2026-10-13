import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { computeSubAgentToolName } from '../../core/subagent-as-tool';
import { makeRuntimeContext } from '../../core/test-fixtures';
import { createMemoryUserKv } from '../../core/user-kv';
import type { RuntimeContext } from '../../plugin-api/types';
import { KvBlueprintStore } from './blueprint-store';
import {
  CapsuleContentClient,
  type CapsuleContentFetcher,
} from './capsule-content-client';
import { DESIGN_POD_ROLES } from './design-pod-roles';
import { buildStageSubAgents } from './sub-agents';
import { ALL_ROLE_IDS, seedRoles, THREAD } from './test-fixtures';

const SKILL_MD = '# Service Intent Scorer\n\nScore the incoming intent.';

function clientWith(md: string): CapsuleContentClient {
  const fetcher: CapsuleContentFetcher = async () => md;
  return new CapsuleContentClient({ fetcher });
}

/** A client whose fetcher always fails — exercises the fallback path. */
function failingClient(): CapsuleContentClient {
  const fetcher: CapsuleContentFetcher = async () => {
    throw new Error('registry down');
  };
  return new CapsuleContentClient({ fetcher });
}

const freshStore = (): KvBlueprintStore =>
  new KvBlueprintStore(createMemoryUserKv());

/** A store whose default thread has an open design (`start_pod_design` ran). */
async function startedStore(): Promise<KvBlueprintStore> {
  const store = freshStore();
  await store.init(THREAD, 'Solar POD');
  return store;
}

describe('buildStageSubAgents', () => {
  it('builds nothing — no specialist, no registry request, no UCAN mint, no log — for a thread without a design', async () => {
    const store = freshStore();
    const fetcher = vi.fn<CapsuleContentFetcher>(async () => SKILL_MD);
    const resolveServiceDid = vi.fn(async () => 'did:web:capsules.example');
    const mintInvocation = vi.fn(async () => 'token');
    const warn = vi.fn();
    const base = makeRuntimeContext();
    const rt: RuntimeContext = {
      ...base,
      logger: { log: vi.fn(), error: vi.fn(), warn },
      ucan: { ...base.ucan, resolveServiceDid, mintInvocation },
    };

    const subs = await buildStageSubAgents(
      rt,
      () => store,
      new CapsuleContentClient({ fetcher }),
    );

    expect(subs).toEqual([]);
    expect(fetcher).not.toHaveBeenCalled();
    expect(resolveServiceDid).not.toHaveBeenCalled();
    expect(mintInvocation).not.toHaveBeenCalled();
    expect(warn).not.toHaveBeenCalled();
  });

  it('returns only the qualify specialist with the registry prompt once a design is open', async () => {
    const store = await startedStore();
    const subs = await buildStageSubAgents(
      makeRuntimeContext(),
      () => store,
      clientWith(SKILL_MD),
    );

    expect(subs.map((s) => s.name)).toEqual(['service_intent_scorer']);
    // The runtime wraps the raw name into the callable specialist tool.
    expect(subs[0] ? computeSubAgentToolName(subs[0].name) : undefined).toBe(
      'call_service_intent_scorer_agent',
    );
    expect(subs[0]?.model).toBe('subagent');
    expect(subs[0]?.forwardTools).toBe(true);

    const prompt = subs[0]?.systemPrompt;
    if (typeof prompt !== 'string') {
      throw new Error('expected a string systemPrompt');
    }
    expect(prompt).toContain('Score the incoming intent');
    expect(prompt).toContain('service_intent_scorer');
  });

  it('advances to the three architect specialists once qualify is recorded', async () => {
    const store = freshStore();
    await seedRoles(store, THREAD, ['service_intent_scorer']);

    const subs = await buildStageSubAgents(
      makeRuntimeContext(),
      () => store,
      clientWith(SKILL_MD),
    );
    expect(subs.map((s) => s.name).sort()).toEqual([
      'claims_architect',
      'service_architect',
      'ucan_rights_architect',
    ]);
  });

  it('reaches the launch-readiness gate once every earlier stage passed', async () => {
    const store = freshStore();
    await seedRoles(
      store,
      THREAD,
      DESIGN_POD_ROLES.filter((role) => role.stage !== 'gate').map(
        (role) => role.id,
      ),
    );

    const subs = await buildStageSubAgents(
      makeRuntimeContext(),
      () => store,
      clientWith(SKILL_MD),
    );
    expect(subs.map((s) => s.name)).toEqual(['qa_launch_readiness_oracle']);
  });

  it('a failed evaluate verdict reopens the evaluate stage', async () => {
    const store = freshStore();
    await seedRoles(store, THREAD, ALL_ROLE_IDS, ['governance_risk_oracle']);

    const subs = await buildStageSubAgents(
      makeRuntimeContext(),
      () => store,
      clientWith(SKILL_MD),
    );
    expect(subs.map((s) => s.name).sort()).toEqual([
      'automation_feasibility_oracle',
      'governance_risk_oracle',
      'outcome_contract_oracle',
    ]);
  });

  it('falls back to a built-in prompt when the registry is unavailable', async () => {
    const store = await startedStore();
    const subs = await buildStageSubAgents(
      makeRuntimeContext(),
      () => store,
      failingClient(),
    );
    const prompt = subs[0]?.systemPrompt;
    if (typeof prompt !== 'string') {
      throw new Error('expected a string systemPrompt');
    }
    expect(prompt).toContain('built-in summary');
    expect(prompt).toContain('service_intent_scorer');
    // The fallback carries real stage duties, not just the one-line description.
    expect(prompt).toContain('go / no-go');
  });

  it("submit_section records the specialist's section, read_blueprint summarises it back", async () => {
    const store = await startedStore();
    const [sub] = await buildStageSubAgents(
      makeRuntimeContext(),
      () => store,
      clientWith(SKILL_MD),
    );
    const tools = Array.isArray(sub?.tools) ? sub.tools : [];
    const submit = tools.find((t) => t.name === 'submit_section');
    const read = tools.find((t) => t.name === 'read_blueprint');
    if (!submit || !read) {
      throw new Error('expected submit_section and read_blueprint tools');
    }

    await submit.handler({ content: { score: 0.9 } }, makeRuntimeContext());

    const bp = await store.get(THREAD);
    expect(bp?.sections.service_intent_scorer?.content).toEqual({
      score: 0.9,
    });

    const summaryShape = z.object({
      sections: z.array(z.object({ role: z.string() })),
      content: z.record(z.string(), z.unknown()).optional(),
    });
    const summary = summaryShape.parse(
      await read.handler({}, makeRuntimeContext()),
    );
    expect(summary.sections.map((s) => s.role)).toContain(
      'service_intent_scorer',
    );
    expect(summary.content).toBeUndefined();

    const detailed = summaryShape.parse(
      await read.handler(
        { roles: ['service_intent_scorer'] },
        makeRuntimeContext(),
      ),
    );
    expect(detailed.content?.service_intent_scorer).toEqual({ score: 0.9 });
  });

  it("resolves the store from each tool call's own context, not the build context", async () => {
    const store = await startedStore();
    const seen: string[] = [];
    const [sub] = await buildStageSubAgents(
      makeRuntimeContext(),
      (ctx) => {
        seen.push(ctx.session.requestId);
        return store;
      },
      clientWith(SKILL_MD),
    );
    const tools = Array.isArray(sub?.tools) ? sub.tools : [];
    const submit = tools.find((t) => t.name === 'submit_section');
    if (!submit) {
      throw new Error('expected submit_section');
    }
    expect(tools.find((t) => t.name === 'read_blueprint')?.effect).toBe('read');

    const later = makeRuntimeContext();
    await submit.handler(
      { content: { score: 1 } },
      { ...later, session: { ...later.session, requestId: 'req-later' } },
    );

    expect(seen).toEqual(['req-1', 'req-later']);
  });
});

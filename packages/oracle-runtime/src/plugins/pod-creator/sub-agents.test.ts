import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { computeSubAgentToolName } from '../../graph/subagent-as-tool.js';
import { makeRuntimeContext } from '../../registries/test-fixtures.js';
import { InMemoryBlueprintStore } from './blueprint-store.js';
import {
  CapsuleContentClient,
  type CapsuleContentFetcher,
} from './capsule-content-client.js';
import { DESIGN_POD_ROLES } from './design-pod-roles.js';
import { buildStageSubAgents } from './sub-agents.js';

const ISO = '2026-06-12T00:00:00.000Z';
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

/** Seed passing sections for the given roles on the default test thread. */
async function seedPassing(
  store: InMemoryBlueprintStore,
  roleIds: readonly string[],
  failing: string[] = [],
): Promise<void> {
  for (const role of DESIGN_POD_ROLES) {
    if (!roleIds.includes(role.id)) {
      continue;
    }
    await store.putSection('session-1', {
      role: role.id,
      stage: role.stage,
      content: {},
      recordedAt: ISO,
      verdict: failing.includes(role.id) ? 'fail' : 'pass',
    });
  }
}

describe('buildStageSubAgents', () => {
  it('returns only the qualify specialist with the registry prompt for a fresh session', async () => {
    const store = new InMemoryBlueprintStore();
    const subs = await buildStageSubAgents(
      makeRuntimeContext(),
      store,
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
    const store = new InMemoryBlueprintStore();
    await seedPassing(store, ['service_intent_scorer']);

    const subs = await buildStageSubAgents(
      makeRuntimeContext(),
      store,
      clientWith(SKILL_MD),
    );
    expect(subs.map((s) => s.name).sort()).toEqual([
      'claims_architect',
      'service_architect',
      'ucan_rights_architect',
    ]);
  });

  it('reaches the launch-readiness gate once every earlier stage passed', async () => {
    const store = new InMemoryBlueprintStore();
    await seedPassing(
      store,
      DESIGN_POD_ROLES.filter((role) => role.stage !== 'gate').map(
        (role) => role.id,
      ),
    );

    const subs = await buildStageSubAgents(
      makeRuntimeContext(),
      store,
      clientWith(SKILL_MD),
    );
    expect(subs.map((s) => s.name)).toEqual(['qa_launch_readiness_oracle']);
  });

  it('a failed evaluate verdict reopens the evaluate stage', async () => {
    const store = new InMemoryBlueprintStore();
    await seedPassing(
      store,
      DESIGN_POD_ROLES.map((role) => role.id),
      ['governance_risk_oracle'],
    );

    const subs = await buildStageSubAgents(
      makeRuntimeContext(),
      store,
      clientWith(SKILL_MD),
    );
    expect(subs.map((s) => s.name).sort()).toEqual([
      'automation_feasibility_oracle',
      'governance_risk_oracle',
      'outcome_contract_oracle',
    ]);
  });

  it('falls back to a built-in prompt when the registry is unavailable', async () => {
    const store = new InMemoryBlueprintStore();
    const subs = await buildStageSubAgents(
      makeRuntimeContext(),
      store,
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
    const store = new InMemoryBlueprintStore();
    const [sub] = await buildStageSubAgents(
      makeRuntimeContext(),
      store,
      clientWith(SKILL_MD),
    );
    const tools = Array.isArray(sub?.tools) ? sub.tools : [];
    const submit = tools.find((t) => t.name === 'submit_section');
    const read = tools.find((t) => t.name === 'read_blueprint');
    if (!submit || !read) {
      throw new Error('expected submit_section and read_blueprint tools');
    }

    await submit.handler({ content: { score: 0.9 } }, makeRuntimeContext());

    const bp = await store.get('session-1');
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
});

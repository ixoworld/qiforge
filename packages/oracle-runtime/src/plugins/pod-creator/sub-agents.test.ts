import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { makeRuntimeContext } from '../../registries/test-fixtures.js';
import { InMemoryBlueprintStore } from './blueprint-store.js';
import {
  CapsuleContentClient,
  type CapsuleContentFetcher,
} from './capsule-content-client.js';
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

describe('buildStageSubAgents', () => {
  it('returns only the qualify specialist with the registry prompt for a fresh session', async () => {
    const store = new InMemoryBlueprintStore();
    const subs = await buildStageSubAgents(
      makeRuntimeContext(),
      store,
      clientWith(SKILL_MD),
    );

    expect(subs.map((s) => s.name)).toEqual(['call_service_intent_scorer']);
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
    await store.putSection('session-1', {
      role: 'service_intent_scorer',
      stage: 'qualify',
      content: {},
      recordedAt: ISO,
      verdict: 'pass',
    });

    const subs = await buildStageSubAgents(
      makeRuntimeContext(),
      store,
      clientWith(SKILL_MD),
    );
    expect(subs.map((s) => s.name).sort()).toEqual([
      'call_claims_architect',
      'call_service_architect',
      'call_ucan_rights_architect',
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
  });

  it("submit_section records the specialist's section, read_blueprint reads it back", async () => {
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
    expect(bp?.sections.service_intent_scorer?.content).toEqual({ score: 0.9 });

    const readOut = await read.handler({}, makeRuntimeContext());
    const shape = z.object({ sections: z.record(z.string(), z.unknown()) });
    expect(Object.keys(shape.parse(readOut).sections)).toContain(
      'service_intent_scorer',
    );
  });
});

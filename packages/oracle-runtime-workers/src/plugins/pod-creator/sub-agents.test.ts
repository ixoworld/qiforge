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
import {
  AIMessage,
  HumanMessage,
  ToolMessage,
  type BaseMessage,
} from '@langchain/core/messages';
import {
  buildSpecialistSubAgents,
  buildStageSubAgents,
  createSpecialistStageMiddleware,
} from './sub-agents';
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
    expect(subs[0]?.forwardTools).toEqual(['submit_section']);

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

  it('a specialist of a stage already passed refuses to record again; the result tells the conductor not to call it again', async () => {
    const store = await startedStore();
    const [scorer] = await buildStageSubAgents(
      makeRuntimeContext(),
      () => store,
      clientWith(SKILL_MD),
    );
    const tools = Array.isArray(scorer?.tools) ? scorer.tools : [];
    const submit = tools.find((t) => t.name === 'submit_section');
    if (!submit) throw new Error('expected submit_section');

    // First record: the qualify stage passes, the architect stage is next.
    const recorded = z
      .object({ submitted: z.string(), message: z.string() })
      .parse(
        await submit.handler({ content: { score: 0.9 } }, makeRuntimeContext()),
      );
    expect(recorded.submitted).toBe('service_intent_scorer');
    expect(recorded.message).toMatch(
      /^Section recorded: this specialist is done, do not call it again/,
    );
    expect(recorded.message).toContain(
      'Next: the architect stage, run by call_service_architect_agent, call_claims_architect_agent, call_ucan_rights_architect_agent.',
    );
    expect(recorded.message).toMatch(
      /send a message \(for example "continue"\)/,
    );

    // Called again (in the same turn it is still the only specialist offered).
    await expect(
      submit.handler(
        { content: { note: 'submit to the architect stage' } },
        makeRuntimeContext(),
      ),
    ).resolves.toEqual({
      submitted: false,
      message:
        'The qualify stage is already complete; this specialist has nothing to do. Stop and tell the user to continue.',
    });
    expect(
      (await store.get(THREAD))?.sections.service_intent_scorer?.content,
    ).toEqual({
      score: 0.9,
    });
  });

  it('a failed gate verdict can be re-recorded by its specialist', async () => {
    const store = freshStore();
    await seedRoles(store, THREAD, ALL_ROLE_IDS, ['governance_risk_oracle']);
    const subs = await buildStageSubAgents(
      makeRuntimeContext(),
      () => store,
      clientWith(SKILL_MD),
    );
    const oracle = subs.find((sub) => sub.name === 'governance_risk_oracle');
    const tools = Array.isArray(oracle?.tools) ? oracle.tools : [];
    const submit = tools.find((t) => t.name === 'submit_section');
    if (!submit) throw new Error('expected submit_section');
    await expect(
      submit.handler(
        { content: { ok: true }, verdict: 'pass' },
        makeRuntimeContext(),
      ),
    ).resolves.toMatchObject({ submitted: 'governance_risk_oracle' });
    expect(
      (await store.get(THREAD))?.sections.governance_risk_oracle?.verdict,
    ).toBe('pass');
  });
});

/** The role ids of one stage, and the specialist tool names the model sees for them. */
const rolesOf = (stage: string): string[] =>
  DESIGN_POD_ROLES.filter((role) => role.stage === stage).map(
    (role) => role.id,
  );
const toolsOf = (stage: string): string[] =>
  rolesOf(stage).map((id) => computeSubAgentToolName(id));
const BEFORE_EVALUATE = [
  ...rolesOf('qualify'),
  ...rolesOf('architect'),
  ...rolesOf('build'),
];

describe('buildSpecialistSubAgents', () => {
  it('builds nothing for a thread without a design', async () => {
    const fetcher = vi.fn<CapsuleContentFetcher>(async () => SKILL_MD);
    const store = freshStore();
    expect(
      await buildSpecialistSubAgents(
        makeRuntimeContext(),
        () => store,
        new CapsuleContentClient({ fetcher }),
      ),
    ).toEqual([]);
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('builds every specialist once a design is open, whatever its stage', async () => {
    const store = await startedStore();
    const subs = await buildSpecialistSubAgents(
      makeRuntimeContext(),
      () => store,
      clientWith(SKILL_MD),
    );
    expect(subs.map((s) => s.name)).toEqual(ALL_ROLE_IDS);
  });
});

describe('createSpecialistStageMiddleware', () => {
  const asTool = (name: string) => ({ name, description: name });
  const ALL_TOOLS = [
    asTool('compute_readiness'),
    ...DESIGN_POD_ROLES.map((role) => asTool(computeSubAgentToolName(role.id))),
  ];

  function setup(store: KvBlueprintStore) {
    const mw = createSpecialistStageMiddleware(
      makeRuntimeContext(),
      () => store,
    );
    const { wrapModelCall, wrapToolCall } = mw;
    if (!wrapModelCall || !wrapToolCall) throw new Error('hooks missing');
    /** The tool names the model is shown on one model call. */
    const shown = async (): Promise<string[]> => {
      const handler = vi.fn(async () => ({ ok: true }));
      await wrapModelCall(
        { tools: ALL_TOOLS, messages: [], state: {} } as never,
        handler as never,
      );
      const sent = handler.mock.calls[0] as unknown as [
        { tools: Array<{ name: string }> },
      ];
      return sent[0].tools.map((t) => t.name);
    };
    /**
     * Runs a tool call through the middleware; says whether it ran. `effect`
     * is what the tool does when it runs (a specialist recording its section).
     */
    const call = async (
      name: string,
      opts: {
        args?: object;
        effect?: () => Promise<void>;
        messages?: BaseMessage[];
      } = {},
    ) => {
      const ran = new ToolMessage({ content: 'ran', tool_call_id: 'c1' });
      const handler = vi.fn(async () => {
        await opts.effect?.();
        return ran;
      });
      const out = await wrapToolCall(
        {
          toolCall: { id: 'c1', name, args: opts.args ?? {} },
          state: { messages: opts.messages ?? [] },
        } as never,
        handler as never,
      );
      return { ran: handler.mock.calls.length === 1, out: out as ToolMessage };
    };
    return { shown, call };
  }

  it("shows only the current stage's specialists, and the next stage's on the next model call once a stage passes", async () => {
    const store = freshStore();
    await seedRoles(store, THREAD, BEFORE_EVALUATE);
    const { shown, call } = setup(store);
    expect(await shown()).toEqual([
      'compute_readiness',
      ...toolsOf('evaluate'),
    ]);

    // The evaluate specialists record their passes during the same turn
    // (the last one's call records them all here).
    const [lastEvaluator] = toolsOf('evaluate').slice(-1);
    if (!lastEvaluator) throw new Error('expected an evaluate specialist');
    await call(lastEvaluator, {
      effect: () =>
        seedRoles(store, THREAD, [...BEFORE_EVALUATE, ...rolesOf('evaluate')]),
    });
    expect(await shown()).toEqual(['compute_readiness', ...toolsOf('package')]);
  });

  it("refuses a call to another stage's specialist with the next step, and runs the current stage's", async () => {
    const store = freshStore();
    await seedRoles(store, THREAD, BEFORE_EVALUATE);
    const { call } = setup(store);

    const [packager] = toolsOf('package');
    if (!packager) throw new Error('expected a package specialist');
    const refused = await call(packager);
    expect(refused.ran).toBe(false);
    expect(refused.out.status).toBe('error');
    expect(String(refused.out.content)).toContain(
      `${packager} was not run: it belongs to the package stage, and the design is at the evaluate stage. Next: the evaluate stage`,
    );

    const [evaluator] = toolsOf('evaluate');
    if (!evaluator) throw new Error('expected an evaluate specialist');
    expect((await call(evaluator)).ran).toBe(true);
    // Not a specialist: untouched.
    expect((await call('compute_readiness')).ran).toBe(true);
  });

  it('does not show or run again, in the same turn, a gate specialist that failed in it; the next turn runs it again', async () => {
    const store = freshStore();
    await seedRoles(store, THREAD, BEFORE_EVALUATE);
    const [failing, other] = rolesOf('evaluate');
    if (!failing || !other) throw new Error('expected evaluate specialists');
    const failingTool = computeSubAgentToolName(failing);
    const turn = setup(store);

    const first = await turn.call(failingTool, {
      effect: () => seedRoles(store, THREAD, [failing], [failing]),
    });
    expect(first.ran).toBe(true);
    expect(await turn.shown()).not.toContain(failingTool);
    expect(await turn.shown()).toContain(computeSubAgentToolName(other));
    const again = await turn.call(failingTool);
    expect(again.ran).toBe(false);
    expect(String(again.out.content)).toContain(
      `${failingTool} was not run again: it failed its check in this turn`,
    );

    // The user's next message is a new turn (a new middleware instance).
    const next = setup(store);
    expect(await next.shown()).toContain(failingTool);
    expect((await next.call(failingTool)).ran).toBe(true);
  });

  it("refuses a restart once a specialist answered in the turn's messages, and allows one before", async () => {
    const store = freshStore();
    await seedRoles(store, THREAD, BEFORE_EVALUATE);
    const [evaluator] = toolsOf('evaluate');
    if (!evaluator) throw new Error('expected an evaluate specialist');
    const restart = { brief: 'again', restart: true };
    const asked = new HumanMessage('run the evaluate stage');
    const called = new AIMessage({
      content: '',
      tool_calls: [{ id: 'e1', name: evaluator, args: {}, type: 'tool_call' }],
    });
    const answered = new ToolMessage({
      tool_call_id: 'e1',
      name: evaluator,
      content: 'PASS, recorded',
    });

    // Before any specialist in this turn (one in an earlier turn does not count).
    expect(
      (
        await setup(store).call('start_pod_design', {
          args: restart,
          messages: [asked, called, answered, new HumanMessage('start over')],
        })
      ).ran,
    ).toBe(true);

    // A fresh instance (a recovered attempt) still sees the answer in the turn.
    const refused = await setup(store).call('start_pod_design', {
      args: restart,
      messages: [asked, called, answered],
    });
    expect(refused.ran).toBe(false);
    expect(String(refused.out.content)).toContain('Not restarted');
    // Opening a design without a restart is not affected.
    expect(
      (
        await setup(store).call('start_pod_design', {
          args: { brief: 'x' },
          messages: [asked, called, answered],
        })
      ).ran,
    ).toBe(true);
  });

  it('does not count a fail recorded in an earlier turn when the re-run records nothing', async () => {
    const store = freshStore();
    const [failing] = rolesOf('evaluate');
    if (!failing) throw new Error('expected an evaluate specialist');
    await seedRoles(store, THREAD, [...BEFORE_EVALUATE, failing], [failing]);
    const failingTool = computeSubAgentToolName(failing);
    const turn = setup(store);
    // The re-run ends without recording (an error, a spent budget).
    expect((await turn.call(failingTool)).ran).toBe(true);
    expect(await turn.shown()).toContain(failingTool);
    expect((await turn.call(failingTool)).ran).toBe(true);
  });

  it('reads the blueprint once between calls that can change it', async () => {
    const store = freshStore();
    await seedRoles(store, THREAD, BEFORE_EVALUATE);
    const get = vi.spyOn(store, 'get');
    const turn = setup(store);
    await turn.shown();
    await turn.shown();
    await turn.call('compute_readiness');
    await turn.shown();
    expect(get).toHaveBeenCalledTimes(1);
    const [evaluator] = toolsOf('evaluate');
    if (!evaluator) throw new Error('expected an evaluate specialist');
    await turn.call(evaluator);
    await turn.shown();
    // One re-read after the specialist (a gate role's verdict check), which
    // the next model call reuses.
    expect(get).toHaveBeenCalledTimes(2);
  });

  it('shows and runs no specialist when the thread has no design', async () => {
    const { shown, call } = setup(freshStore());
    expect(await shown()).toEqual(['compute_readiness']);
    const [scorer] = toolsOf('qualify');
    if (!scorer) throw new Error('expected a qualify specialist');
    const refused = await call(scorer);
    expect(refused.ran).toBe(false);
    expect(String(refused.out.content)).toContain(
      'Call start_pod_design first.',
    );
  });
});

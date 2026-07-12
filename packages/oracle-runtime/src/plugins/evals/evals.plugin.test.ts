import { afterEach, describe, expect, it, vi } from 'vitest';
import { createTestRuntime } from '../../testing/create-test-runtime.js';
import { validateManifest } from '../../manifest/validator.js';
import type {
  PluginContext,
  PluginSubAgent,
  PluginTool,
  RuntimeContext,
} from '../../plugin-api/types.js';
import {
  makeBuildCtx,
  makeRuntimeContext,
} from '../../registries/test-fixtures.js';
import { EvalsPlugin } from './evals.plugin.js';
import { EvalsEngineClient } from './evals-client.js';

const BASE_URL = 'https://evals.test';
const AUTH_TOKEN = 'test-bearer-secret';

const TOOL_NAMES = [
  'evaluate_claim',
  'get_evaluation_status',
  'get_evaluation_udid',
  'get_evaluation_audit',
  'get_evaluation_maturity',
  'list_evaluation_reviews',
  'list_evaluation_rubrics',
];

const VALID_EVALUATE_ARGS = {
  deed: { id: 'deed-1', aud: 'did:example:aud' },
  claim: {
    id: 'claim-1',
    cap: 'urn:cap:test',
    jti: 'jti-1',
    automatedAgent: false,
    proposedPatch: { status: 'done' },
  },
  rubric: {
    rubricVersionId: 'rubric-v1',
    thresholdBps: 7000,
    mode: 'fail_any_dimension',
    patchAllowlist: ['status'],
    requireTraceForAutomated: false,
  },
};

const COMPLETED_JOB = {
  id: 'job-1',
  claimId: 'claim-1',
  status: 'completed',
  error: null,
  attempts: 1,
  lockedAt: null,
  lastError: null,
  resultSummary: {
    claimId: 'claim-1',
    rubricVersionId: 'rubric-v1',
    res: { outcome: 1, reason: 'approve', patch: { status: 'done' } },
    evaluationReport: {
      gateReason: 'approve',
      finalOutcome: 1,
      dimensions: { quality: { scoreBps: 9000, pass: true, applied: [] } },
      appliedPenaltyCodes: [],
      capAuthorized: true,
    },
    applyResult: { accepted: true, manualReview: false },
    compactJws: 'eyJhbGciOi.payload.sig',
  },
  createdAt: 1,
  updatedAt: 2,
};

function ctxWithUrl(token?: string): PluginContext {
  return makeBuildCtx({
    config: {
      EVALS_ENGINE_URL: BASE_URL,
      ...(token ? { EVALS_ENGINE_AUTH_TOKEN: token } : {}),
    },
  });
}

function subAgentFor(plugin: EvalsPlugin, ctx: PluginContext): PluginSubAgent {
  const [first] = plugin.getSubAgents(ctx);
  if (!first) throw new Error('expected one sub-agent');
  return first;
}

function toolsOf(subAgent: PluginSubAgent, ctx: PluginContext): PluginTool[] {
  return typeof subAgent.tools === 'function'
    ? subAgent.tools(ctx)
    : subAgent.tools;
}

function toolNamed(
  plugin: EvalsPlugin,
  ctx: PluginContext,
  name: string,
): PluginTool {
  const found = toolsOf(subAgentFor(plugin, ctx), ctx).find(
    (t) => t.name === name,
  );
  if (!found) throw new Error(`expected tool ${name}`);
  return found;
}

function runtimeCtx(): RuntimeContext {
  return makeRuntimeContext();
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status });
}

describe('EvalsPlugin', () => {
  const fetchSpy = vi.spyOn(globalThis, 'fetch');

  afterEach(() => {
    fetchSpy.mockReset();
  });

  it('has the expected name, version, and manifest', () => {
    const plugin = new EvalsPlugin();
    expect(plugin.name).toBe('evals');
    expect(plugin.version).toBe('1.0.0');
    expect(plugin.manifest.title).toBe('Evals Engine');
    expect(plugin.manifest.visibility).toBe('on-demand');
    expect(plugin.manifest.stability).toBe('beta');
    expect(plugin.manifest.category).toBe('integration');
    expect(plugin.manifest.whenToUse.length).toBeGreaterThan(0);
    expect(plugin.manifest.whenNotToUse?.length).toBeGreaterThan(0);
  });

  it('manifest passes validateManifest', () => {
    const plugin = new EvalsPlugin();
    const result = validateManifest(plugin.manifest, plugin.name);
    expect(result.errors).toEqual([]);
    expect(result.valid).toBe(true);
  });

  it('auto-detects on EVALS_ENGINE_URL presence', () => {
    const plugin = new EvalsPlugin();
    expect(plugin.autoDetect({ EVALS_ENGINE_URL: BASE_URL })).toBe(true);
    expect(plugin.autoDetect({})).toBe(false);
    expect(plugin.autoDetectHint).toBe('EVALS_ENGINE_URL');
  });

  it('exposes a Zod configSchema requiring a valid EVALS_ENGINE_URL', () => {
    const plugin = new EvalsPlugin();
    expect(plugin.configSchema).toBeDefined();
    expect(plugin.configSchema.safeParse({}).success).toBe(false);
    expect(
      plugin.configSchema.safeParse({ EVALS_ENGINE_URL: BASE_URL }).success,
    ).toBe(true);
    expect(
      plugin.configSchema.safeParse({
        EVALS_ENGINE_URL: BASE_URL,
        EVALS_ENGINE_AUTH_TOKEN: AUTH_TOKEN,
      }).success,
    ).toBe(true);
    expect(
      plugin.configSchema.safeParse({ EVALS_ENGINE_URL: 'not-a-url' }).success,
    ).toBe(false);
  });

  it('throws a helpful error when the engine URL is missing at build time', () => {
    const plugin = new EvalsPlugin();
    expect(() => plugin.getSubAgents(makeBuildCtx({ config: {} }))).toThrow(
      /EVALS_ENGINE_URL/,
    );
  });

  it('loads via createTestRuntime when EVALS_ENGINE_URL is provided', async () => {
    const rt = await createTestRuntime({
      plugins: [new EvalsPlugin()],
      config: { EVALS_ENGINE_URL: BASE_URL },
    });

    rt.assertNoCollisions();
    rt.assertManifestValid();
    const listing = rt.listCapabilities().find((c) => c.name === 'evals');
    expect(listing).toBeDefined();
    expect(listing?.visibility).toBe('on-demand');
    expect(listing?.loaded).toBe(false);
    await rt.close();
  });

  it('registers an Evals Agent sub-agent exposing the seven engine tools', async () => {
    const rt = await createTestRuntime({
      plugins: [new EvalsPlugin()],
      config: { EVALS_ENGINE_URL: BASE_URL },
      mocks: { llm: { respondWith: 'mocked reply' } },
    });

    const reply = await rt.invokeSubAgent(
      'Evals Agent',
      'Evaluate the restocking claim',
    );
    const parsed = JSON.parse(reply) as {
      plugin: string;
      subAgent: string;
      toolNames: string[];
      reply: string;
    };
    expect(parsed.plugin).toBe('evals');
    expect(parsed.subAgent).toBe('Evals Agent');
    expect(parsed.toolNames).toEqual(TOOL_NAMES);
    expect(parsed.reply).toBe('mocked reply');
    await rt.close();
  });

  it('sub-agent system prompt embeds tool docs and discipline rules', () => {
    const plugin = new EvalsPlugin();
    const ctx = ctxWithUrl();
    const subAgent = subAgentFor(plugin, ctx);
    const prompt =
      typeof subAgent.systemPrompt === 'function'
        ? subAgent.systemPrompt(ctx)
        : subAgent.systemPrompt;
    expect(prompt).toContain('Evals Agent');
    for (const name of TOOL_NAMES) {
      expect(prompt).toContain(name);
    }
    expect(prompt).toContain('STOP');
    expect(subAgent.model).toBe('subagent');
  });

  describe('evaluate_claim tool', () => {
    it('submits the claim and returns the summarized verdict when the engine completes inline', async () => {
      fetchSpy
        .mockResolvedValueOnce(
          jsonResponse(
            { jobId: 'job-1', claimId: 'claim-1', status: 'completed' },
            202,
          ),
        )
        .mockResolvedValueOnce(jsonResponse(COMPLETED_JOB));
      const plugin = new EvalsPlugin();
      const evaluate = toolNamed(
        plugin,
        ctxWithUrl(AUTH_TOKEN),
        'evaluate_claim',
      );

      const result = await evaluate.handler(VALID_EVALUATE_ARGS, runtimeCtx());

      expect(result).toEqual({
        claimId: 'claim-1',
        jobId: 'job-1',
        status: 'completed',
        outcome: 1,
        outcomeLabel: 'approved',
        reason: 'approve',
        gateReason: 'approve',
        dimensions: { quality: { scoreBps: 9000, pass: true, applied: [] } },
        appliedPenaltyCodes: [],
        applyResult: { accepted: true, manualReview: false },
        udidIssued: true,
      });

      expect(fetchSpy).toHaveBeenCalledTimes(2);
      const [submitUrl, submitInit] = fetchSpy.mock.calls[0]!;
      expect(String(submitUrl)).toBe(`${BASE_URL}/v1/claims/evaluate`);
      expect(submitInit?.method).toBe('POST');
      const headers = submitInit?.headers as Record<string, string>;
      expect(headers.authorization).toBe(`Bearer ${AUTH_TOKEN}`);
      expect(headers['content-type']).toBe('application/json');
      const sentBody = JSON.parse(String(submitInit?.body)) as Record<
        string,
        unknown
      >;
      expect(sentBody).toEqual(VALID_EVALUATE_ARGS);
      expect(sentBody).not.toHaveProperty('waitSeconds');
      const [jobUrl] = fetchSpy.mock.calls[1]!;
      expect(String(jobUrl)).toBe(`${BASE_URL}/v1/jobs/job-1`);
    });

    it('returns a pending handle with guidance when the wait budget expires', async () => {
      fetchSpy
        .mockResolvedValueOnce(
          jsonResponse(
            { jobId: 'job-1', claimId: 'claim-1', status: 'pending' },
            202,
          ),
        )
        .mockResolvedValueOnce(
          jsonResponse({
            ...COMPLETED_JOB,
            status: 'pending',
            resultSummary: null,
          }),
        );
      const plugin = new EvalsPlugin();
      const evaluate = toolNamed(plugin, ctxWithUrl(), 'evaluate_claim');

      const result = await evaluate.handler(
        { ...VALID_EVALUATE_ARGS, waitSeconds: 0 },
        runtimeCtx(),
      );

      expect(result).toMatchObject({
        claimId: 'claim-1',
        jobId: 'job-1',
        status: 'pending',
      });
      expect((result as { guidance: string }).guidance).toContain(
        'get_evaluation_status',
      );
      expect(fetchSpy).toHaveBeenCalledTimes(2);
    });

    it('returns the engine error object on a 409 conflict (e.g. replayed jti)', async () => {
      fetchSpy.mockResolvedValueOnce(
        jsonResponse({ error: 'claim_jti_already_submitted' }, 409),
      );
      const plugin = new EvalsPlugin();
      const evaluate = toolNamed(plugin, ctxWithUrl(), 'evaluate_claim');
      const result = await evaluate.handler(VALID_EVALUATE_ARGS, runtimeCtx());
      expect(result).toEqual({ error: 'claim_jti_already_submitted' });
    });

    it('rejects incomplete rubrics via the Zod schema before any network call', async () => {
      const plugin = new EvalsPlugin();
      const evaluate = toolNamed(plugin, ctxWithUrl(), 'evaluate_claim');
      await expect(
        evaluate.handler(
          {
            ...VALID_EVALUATE_ARGS,
            rubric: { rubricVersionId: 'rubric-v1' },
          },
          runtimeCtx(),
        ),
      ).rejects.toThrow();
      expect(fetchSpy).not.toHaveBeenCalled();
    });

    it('sends no authorization header when no token is configured', async () => {
      fetchSpy
        .mockResolvedValueOnce(
          jsonResponse(
            { jobId: 'job-1', claimId: 'claim-1', status: 'completed' },
            202,
          ),
        )
        .mockResolvedValueOnce(jsonResponse(COMPLETED_JOB));
      const plugin = new EvalsPlugin();
      const evaluate = toolNamed(plugin, ctxWithUrl(), 'evaluate_claim');
      await evaluate.handler(VALID_EVALUATE_ARGS, runtimeCtx());
      const headers = fetchSpy.mock.calls[0]![1]?.headers as Record<
        string,
        string
      >;
      expect(headers.authorization).toBeUndefined();
    });

    it('throws an operator-facing error on 401', async () => {
      fetchSpy.mockResolvedValueOnce(
        new Response('', { status: 401, statusText: 'Unauthorized' }),
      );
      const plugin = new EvalsPlugin();
      const evaluate = toolNamed(plugin, ctxWithUrl(), 'evaluate_claim');
      await expect(
        evaluate.handler(VALID_EVALUATE_ARGS, runtimeCtx()),
      ).rejects.toThrow(/EVALS_ENGINE_AUTH_TOKEN/);
    });

    it('throws on 5xx responses', async () => {
      fetchSpy.mockResolvedValueOnce(
        new Response('', { status: 503, statusText: 'Down' }),
      );
      const plugin = new EvalsPlugin();
      const evaluate = toolNamed(plugin, ctxWithUrl(), 'evaluate_claim');
      await expect(
        evaluate.handler(VALID_EVALUATE_ARGS, runtimeCtx()),
      ).rejects.toThrow(/503/);
    });
  });

  describe('EvalsEngineClient.waitForJob', () => {
    it('polls until the job leaves pending/processing', async () => {
      fetchSpy
        .mockResolvedValueOnce(
          jsonResponse({ ...COMPLETED_JOB, status: 'pending' }),
        )
        .mockResolvedValueOnce(
          jsonResponse({ ...COMPLETED_JOB, status: 'processing' }),
        )
        .mockResolvedValueOnce(jsonResponse(COMPLETED_JOB));
      const client = new EvalsEngineClient({
        baseUrl: BASE_URL,
        pollIntervalMs: 1,
      });
      const job = await client.waitForJob('job-1', 5);
      expect(job).toMatchObject({ id: 'job-1', status: 'completed' });
      expect(fetchSpy).toHaveBeenCalledTimes(3);
    });
  });

  describe('get_evaluation_status tool', () => {
    it('summarizes the latest job and surfaces the manual-review flag', async () => {
      const { claimId: _claimId, ...jobSansClaim } = COMPLETED_JOB;
      fetchSpy.mockResolvedValueOnce(
        jsonResponse({
          claimId: 'claim-1',
          job: jobSansClaim,
          manualReviewQueue: true,
        }),
      );
      const plugin = new EvalsPlugin();
      const status = toolNamed(plugin, ctxWithUrl(), 'get_evaluation_status');
      const result = await status.handler({ claimId: 'claim-1' }, runtimeCtx());
      expect(result).toMatchObject({
        claimId: 'claim-1',
        jobId: 'job-1',
        status: 'completed',
        outcome: 1,
        outcomeLabel: 'approved',
        manualReviewQueue: true,
        udidIssued: true,
      });
      const [url] = fetchSpy.mock.calls[0]!;
      expect(String(url)).toBe(`${BASE_URL}/v1/claims/claim-1/status`);
    });

    it('returns the engine error object for unknown claims', async () => {
      fetchSpy.mockResolvedValueOnce(
        jsonResponse({ error: 'claim_job_not_found' }, 404),
      );
      const plugin = new EvalsPlugin();
      const status = toolNamed(plugin, ctxWithUrl(), 'get_evaluation_status');
      const result = await status.handler({ claimId: 'nope' }, runtimeCtx());
      expect(result).toEqual({ error: 'claim_job_not_found' });
    });
  });

  describe('get_evaluation_udid tool', () => {
    it('returns the signed receipt', async () => {
      const receipt = {
        claimId: 'claim-1',
        compactJws: 'eyJhbGciOi.payload.sig',
        payload: { iss: 'did:web:evals.test', res: { outcome: 1 } },
      };
      fetchSpy.mockResolvedValueOnce(jsonResponse(receipt));
      const plugin = new EvalsPlugin();
      const udid = toolNamed(plugin, ctxWithUrl(), 'get_evaluation_udid');
      const result = await udid.handler({ claimId: 'claim-1' }, runtimeCtx());
      expect(result).toEqual(receipt);
      const [url] = fetchSpy.mock.calls[0]!;
      expect(String(url)).toBe(`${BASE_URL}/v1/claims/claim-1/udid`);
    });

    it('returns the not-issued error object instead of throwing', async () => {
      fetchSpy.mockResolvedValueOnce(
        jsonResponse({ error: 'udid_not_issued', claimId: 'claim-1' }, 404),
      );
      const plugin = new EvalsPlugin();
      const udid = toolNamed(plugin, ctxWithUrl(), 'get_evaluation_udid');
      const result = await udid.handler({ claimId: 'claim-1' }, runtimeCtx());
      expect(result).toEqual({ error: 'udid_not_issued', claimId: 'claim-1' });
    });
  });

  describe('get_evaluation_audit tool', () => {
    const bundle = {
      schema: 'oracle.evaluation-audit.v1',
      claimId: 'claim-1',
      machine: { res: { outcome: 1 } },
      steps: [
        { id: 1, tsSec: 100, type: 'submitted', payload: { big: 'blob' } },
        { id: 2, tsSec: 101, type: 'evaluated', payload: { big: 'blob' } },
      ],
    };

    it('strips step payloads by default', async () => {
      fetchSpy.mockResolvedValueOnce(jsonResponse(bundle));
      const plugin = new EvalsPlugin();
      const audit = toolNamed(plugin, ctxWithUrl(), 'get_evaluation_audit');
      const result = await audit.handler({ claimId: 'claim-1' }, runtimeCtx());
      expect(result).toEqual({
        ...bundle,
        steps: [
          { id: 1, tsSec: 100, type: 'submitted' },
          { id: 2, tsSec: 101, type: 'evaluated' },
        ],
      });
      const [url] = fetchSpy.mock.calls[0]!;
      expect(String(url)).toBe(`${BASE_URL}/v1/claims/claim-1/audit`);
    });

    it('keeps step payloads when includeStepPayloads is true', async () => {
      fetchSpy.mockResolvedValueOnce(jsonResponse(bundle));
      const plugin = new EvalsPlugin();
      const audit = toolNamed(plugin, ctxWithUrl(), 'get_evaluation_audit');
      const result = await audit.handler(
        { claimId: 'claim-1', includeStepPayloads: true },
        runtimeCtx(),
      );
      expect(result).toEqual(bundle);
    });
  });

  describe('get_evaluation_maturity tool', () => {
    it('fetches the full ladder when no claimType is given', async () => {
      fetchSpy.mockResolvedValueOnce(jsonResponse({ ladder: [] }));
      const plugin = new EvalsPlugin();
      const maturity = toolNamed(
        plugin,
        ctxWithUrl(),
        'get_evaluation_maturity',
      );
      const result = await maturity.handler({}, runtimeCtx());
      expect(result).toEqual({ ladder: [] });
      const [url] = fetchSpy.mock.calls[0]!;
      expect(String(url)).toBe(`${BASE_URL}/v1/governance/maturity`);
    });

    it('fetches a single claim type rung', async () => {
      const rung = {
        claimType: 'coding.task',
        rung: 'assisted',
        registered: true,
        gatePolicyId: 'gate-1',
        records: [],
      };
      fetchSpy.mockResolvedValueOnce(jsonResponse(rung));
      const plugin = new EvalsPlugin();
      const maturity = toolNamed(
        plugin,
        ctxWithUrl(),
        'get_evaluation_maturity',
      );
      const result = await maturity.handler(
        { claimType: 'coding.task' },
        runtimeCtx(),
      );
      expect(result).toEqual(rung);
      const [url] = fetchSpy.mock.calls[0]!;
      expect(String(url)).toBe(
        `${BASE_URL}/v1/governance/maturity/coding.task`,
      );
    });
  });

  describe('list_evaluation_rubrics tool', () => {
    it('lists rubrics, optionally filtered by claimType', async () => {
      const listing = {
        rubrics: [
          {
            rubricVersionId: 'rubric-v1',
            contentCid: 'bafk-cid',
            thresholdBps: 7000,
            mode: 'fail_any_dimension',
            claimTypes: ['coding_task.completed'],
            governedCollections: ['collection-1'],
          },
        ],
        governedCollections: [],
      };
      fetchSpy
        .mockResolvedValueOnce(jsonResponse(listing))
        .mockResolvedValueOnce(jsonResponse(listing));
      const plugin = new EvalsPlugin();
      const rubrics = toolNamed(
        plugin,
        ctxWithUrl(),
        'list_evaluation_rubrics',
      );

      const all = await rubrics.handler({}, runtimeCtx());
      expect(all).toEqual(listing);
      expect(String(fetchSpy.mock.calls[0]![0])).toBe(`${BASE_URL}/v1/rubrics`);

      await rubrics.handler(
        { claimType: 'coding_task.completed' },
        runtimeCtx(),
      );
      expect(String(fetchSpy.mock.calls[1]![0])).toBe(
        `${BASE_URL}/v1/rubrics?claimType=coding_task.completed`,
      );
    });

    it('fetches one rubric by id and passes through not-found errors', async () => {
      fetchSpy
        .mockResolvedValueOnce(
          jsonResponse({
            rubricVersionId: 'rubric-v1',
            rubric: { thresholdBps: 7000 },
          }),
        )
        .mockResolvedValueOnce(
          jsonResponse(
            { error: 'rubric_not_found', rubricVersionId: 'nope' },
            404,
          ),
        );
      const plugin = new EvalsPlugin();
      const rubrics = toolNamed(
        plugin,
        ctxWithUrl(),
        'list_evaluation_rubrics',
      );

      const detail = await rubrics.handler(
        { rubricVersionId: 'rubric-v1' },
        runtimeCtx(),
      );
      expect(detail).toMatchObject({ rubricVersionId: 'rubric-v1' });
      expect(String(fetchSpy.mock.calls[0]![0])).toBe(
        `${BASE_URL}/v1/rubrics/rubric-v1`,
      );

      const missing = await rubrics.handler(
        { rubricVersionId: 'nope' },
        runtimeCtx(),
      );
      expect(missing).toEqual({
        error: 'rubric_not_found',
        rubricVersionId: 'nope',
      });
    });
  });

  describe('list_evaluation_reviews tool', () => {
    it('lists pending manual-review cases', async () => {
      const body = {
        claimIds: ['claim-9'],
        cases: [{ caseId: 'case-1', sub: 'claim-9', initialOutcome: 5 }],
      };
      fetchSpy.mockResolvedValueOnce(jsonResponse(body));
      const plugin = new EvalsPlugin();
      const reviews = toolNamed(
        plugin,
        ctxWithUrl(),
        'list_evaluation_reviews',
      );
      const result = await reviews.handler({}, runtimeCtx());
      expect(result).toEqual(body);
      const [url] = fetchSpy.mock.calls[0]!;
      expect(String(url)).toBe(`${BASE_URL}/v1/manual-review`);
    });
  });
});

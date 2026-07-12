import { describe, expect, it } from 'vitest';
import { AIMessage, HumanMessage, ToolMessage } from '@langchain/core/messages';
import type { BaseMessage } from '@langchain/core/messages';
import { canonicalJsonString, cidV1RawSha256Utf8 } from './content-cid.js';
import type {
  EvalsApiResult,
  EvaluationAccepted,
  EvaluationJob,
} from './evals-client.js';
import { TRACE_EVENT_KEY } from './evals-trace.js';
import {
  createVerifiedWorkGateFromEnv,
  createVerifiedWorkSubmitterFromEnv,
  resolveVerifiedWorkSettings,
  VerifiedWorkGate,
  VerifiedWorkLedger,
  VerifiedWorkSubmitter,
  type CompletedTaskRun,
  type VerifiedWorkClient,
  type VerifiedWorkPoster,
  type VerifiedWorkRedis,
  type VerifiedWorkSettings,
} from './verified-work.js';

const NOOP_LOGGER = {
  log: () => undefined,
  warn: () => undefined,
  error: () => undefined,
};

function fakeRedis(): VerifiedWorkRedis {
  const data = new Map<string, Map<string, string>>();
  return {
    async hset(key, field, value) {
      const hash = data.get(key) ?? new Map<string, string>();
      hash.set(field, value);
      data.set(key, hash);
      return 1;
    },
    async hdel(key, ...fields) {
      const hash = data.get(key);
      let removed = 0;
      for (const field of fields) {
        if (hash?.delete(field)) removed += 1;
      }
      return removed;
    },
    async hgetall(key) {
      return Object.fromEntries(data.get(key) ?? new Map<string, string>());
    },
  };
}

const GOVERNED_RUBRIC = {
  rubricVersionId: 'rubric-v1',
  thresholdBps: 7000,
  mode: 'fail_any_dimension',
  patchAllowlist: ['status'],
  requireTraceForAutomated: true,
};

function job(
  status: EvaluationJob['status'],
  resultSummary: unknown = null,
): EvaluationJob {
  return {
    id: 'job-1',
    status,
    error: null,
    attempts: 1,
    lastError: null,
    resultSummary,
    createdAt: 1,
    updatedAt: 2,
  };
}

const APPROVED_SUMMARY = {
  res: { outcome: 1, reason: 'meets rubric' },
  compactJws: 'aaa.bbb.ccc',
};
const REJECTED_SUMMARY = { res: { outcome: 2, reason: 'output too thin' } };

interface FakeClientScript {
  rubric?: EvalsApiResult<Record<string, unknown>>;
  accepted?: EvalsApiResult<EvaluationAccepted>;
  job?: EvalsApiResult<EvaluationJob>;
  status?: EvalsApiResult<{
    claimId: string;
    job: Omit<EvaluationJob, 'claimId'>;
    manualReviewQueue: boolean;
  }>;
  throwOn?: 'evaluateClaim' | 'getClaimStatus';
}

function fakeClient(script: FakeClientScript): VerifiedWorkClient & {
  calls: { method: string; body?: Record<string, unknown> }[];
} {
  const calls: { method: string; body?: Record<string, unknown> }[] = [];
  return {
    calls,
    async getRubric() {
      calls.push({ method: 'getRubric' });
      return (
        script.rubric ?? {
          rubricVersionId: 'rubric-v1',
          contentCid: 'bafy',
          rubric: GOVERNED_RUBRIC,
        }
      );
    },
    async evaluateClaim(body) {
      calls.push({ method: 'evaluateClaim', body });
      if (script.throwOn === 'evaluateClaim') {
        throw new Error('engine down');
      }
      return (
        script.accepted ?? {
          jobId: 'job-1',
          claimId: 'unused',
          status: 'pending',
        }
      );
    },
    async waitForJob() {
      calls.push({ method: 'waitForJob' });
      return script.job ?? job('pending');
    },
    async getClaimStatus(claimId) {
      calls.push({ method: 'getClaimStatus' });
      if (script.throwOn === 'getClaimStatus') {
        throw new Error('engine down');
      }
      const value = script.status;
      if (!value) throw new Error('no status scripted');
      return isErrorLike(value) ? value : { ...value, claimId };
    },
  };
}

function isErrorLike(value: unknown): value is { error: string } {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as { error?: unknown }).error === 'string'
  );
}

function fakePoster(): VerifiedWorkPoster & {
  texts: { roomId: string; text: string }[];
  events: { roomId: string; content: Record<string, unknown> }[];
} {
  const texts: { roomId: string; text: string }[] = [];
  const events: { roomId: string; content: Record<string, unknown> }[] = [];
  return {
    texts,
    events,
    async postText(roomId, text) {
      texts.push({ roomId, text });
      return '$text-event';
    },
    async postEvent(roomId, content) {
      events.push({ roomId, content });
      return '$trace-event';
    },
  };
}

const SETTINGS: VerifiedWorkSettings = {
  baseUrl: 'https://engine.test',
  rubricVersionId: 'rubric-v1',
  claimType: 'oracle.task_completion',
  capability: 'urn:ixo:oracle:cap:task-completion',
  waitSeconds: 0,
};

function runMessages(): BaseMessage[] {
  return [
    new HumanMessage('Summarize the news'),
    new AIMessage({
      content: '',
      tool_calls: [{ id: 'call-1', name: 'search', args: { q: 'news' } }],
    }),
    new ToolMessage({
      content: 'headlines',
      tool_call_id: 'call-1',
      name: 'search',
    }),
    new AIMessage('All done'),
  ];
}

function completedRun(): CompletedTaskRun {
  return {
    taskId: 'task-1',
    owner: 'did:ixo:user1',
    title: 'Daily digest',
    output: 'All done',
    roomId: '!room:ixo.world',
    deliveredEventId: '$delivered',
    sessionId: '$sess-1',
    requestId: 'run-9',
    messages: runMessages(),
  };
}

function makeSubmitter(script: FakeClientScript) {
  const client = fakeClient(script);
  const poster = fakePoster();
  const ledger = new VerifiedWorkLedger(fakeRedis());
  const submitter = new VerifiedWorkSubmitter({
    client,
    ledger,
    settings: SETTINGS,
    poster,
    submitterDid: 'did:ixo:oracle:qiforge',
    logger: NOOP_LOGGER,
  });
  return { client, poster, ledger, submitter };
}

describe('resolveVerifiedWorkSettings', () => {
  const env = (vars: Record<string, string>) => ({
    get: (key: string) => vars[key],
  });

  it('is null when the loop is not enabled', () => {
    expect(resolveVerifiedWorkSettings(env({}))).toBeNull();
    expect(
      resolveVerifiedWorkSettings(env({ EVALS_VERIFIED_WORK: 'false' })),
    ).toBeNull();
  });

  it('fails the boot when enabled without engine URL or rubric', () => {
    expect(() =>
      resolveVerifiedWorkSettings(env({ EVALS_VERIFIED_WORK: 'true' })),
    ).toThrow(/EVALS_ENGINE_URL/);
    expect(() =>
      resolveVerifiedWorkSettings(
        env({
          EVALS_VERIFIED_WORK: 'true',
          EVALS_ENGINE_URL: 'https://engine.test',
        }),
      ),
    ).toThrow(/EVALS_TASK_RUBRIC_ID/);
  });

  it('applies defaults and validates the wait budget', () => {
    const base = {
      EVALS_VERIFIED_WORK: 'true',
      EVALS_ENGINE_URL: 'https://engine.test',
      EVALS_TASK_RUBRIC_ID: 'rubric-v1',
    };
    const settings = resolveVerifiedWorkSettings(env(base));
    expect(settings).toMatchObject({
      claimType: 'oracle.task_completion',
      capability: 'urn:ixo:oracle:cap:task-completion',
      waitSeconds: 45,
    });
    expect(
      resolveVerifiedWorkSettings(
        env({ ...base, EVALS_VERIFIED_WORK_WAIT_SECONDS: '120' }),
      )?.waitSeconds,
    ).toBe(120);
    expect(() =>
      resolveVerifiedWorkSettings(
        env({ ...base, EVALS_VERIFIED_WORK_WAIT_SECONDS: 'soon' }),
      ),
    ).toThrow(/WAIT_SECONDS/);
  });

  it('factories return null when disabled and fail fast when incoherent', () => {
    expect(
      createVerifiedWorkSubmitterFromEnv({
        env: env({}),
        redis: fakeRedis(),
        logger: NOOP_LOGGER,
      }),
    ).toBeNull();
    expect(
      createVerifiedWorkGateFromEnv({
        env: env({}),
        redis: fakeRedis(),
        logger: NOOP_LOGGER,
      }),
    ).toBeNull();
    expect(() =>
      createVerifiedWorkSubmitterFromEnv({
        env: env({
          EVALS_VERIFIED_WORK: 'true',
          EVALS_ENGINE_URL: 'https://engine.test',
          EVALS_TASK_RUBRIC_ID: 'rubric-v1',
        }),
        redis: fakeRedis(),
        logger: NOOP_LOGGER,
      }),
    ).toThrow(/ORACLE_DID/);
  });
});

describe('VerifiedWorkLedger', () => {
  it('records, lists, and resolves entries per owner', async () => {
    const ledger = new VerifiedWorkLedger(fakeRedis());
    await ledger.record('did:a', {
      claimId: 'claim-1',
      taskId: 'task-1',
      status: 'pending',
      updatedAt: 'now',
    });
    await ledger.record('did:b', {
      claimId: 'claim-2',
      taskId: 'task-2',
      status: 'rejected',
      updatedAt: 'now',
    });
    expect(await ledger.list('did:a')).toHaveLength(1);
    expect(await ledger.list('did:b')).toMatchObject([{ status: 'rejected' }]);
    await ledger.resolve('did:a', 'claim-1');
    expect(await ledger.list('did:a')).toEqual([]);
  });

  it('skips corrupt rows instead of crashing or unblocking', async () => {
    const redis = fakeRedis();
    await redis.hset('evals:verified-work:v1:did:a', 'bad', 'not json');
    const ledger = new VerifiedWorkLedger(redis);
    expect(await ledger.list('did:a')).toEqual([]);
  });
});

describe('VerifiedWorkSubmitter', () => {
  it('submits claim + evidence + trace and clears the ledger on approval', async () => {
    const { client, poster, ledger, submitter } = makeSubmitter({
      job: job('completed', APPROVED_SUMMARY),
    });

    await submitter.submitCompletedTask(completedRun());

    // The claim body carries the governed rubric, bound evidence, and trace.
    const evaluate = client.calls.find((c) => c.method === 'evaluateClaim');
    const body = evaluate?.body as {
      deed: { id: string; aud: string };
      claim: {
        id: string;
        jti: string;
        automatedAgent: boolean;
        claimType: string;
        proposedPatch: Record<string, unknown>;
        trace?: { uri: string; cid: string };
      };
      rubric: unknown;
      evidence: { packet: { claimId: string }; envelope: unknown };
    };
    expect(body.deed).toEqual({
      id: 'urn:ixo:oracle:task:task-1',
      aud: 'did:ixo:user1',
    });
    expect(body.claim.automatedAgent).toBe(true);
    expect(body.claim.claimType).toBe('oracle.task_completion');
    expect(body.claim.proposedPatch).toEqual({ status: 'completed' });
    expect(body.rubric).toEqual(GOVERNED_RUBRIC);
    expect(body.evidence.packet.claimId).toBe(body.claim.id);

    // The trace posted to the room recomputes to the CID the claim carries.
    expect(body.claim.trace?.uri).toBe(
      'matrix:roomid/room%3Aixo.world/e/trace-event',
    );
    const traceEvent = poster.events[0]!.content[TRACE_EVENT_KEY] as {
      cid: string;
      document: unknown;
    };
    expect(cidV1RawSha256Utf8(canonicalJsonString(traceEvent.document))).toBe(
      body.claim.trace?.cid,
    );

    // Approved: nothing blocks settlement, and the user sees the verdict.
    expect(await ledger.list('did:ixo:user1')).toEqual([]);
    expect(poster.texts[0]?.text).toContain('Work verified');
    expect(poster.texts[0]?.text).toContain('UDID');
  });

  it('fetches the governed rubric once across submissions', async () => {
    const { client, submitter } = makeSubmitter({
      job: job('completed', APPROVED_SUMMARY),
    });
    await submitter.submitCompletedTask(completedRun());
    await submitter.submitCompletedTask({
      ...completedRun(),
      taskId: 'task-2',
    });
    expect(client.calls.filter((c) => c.method === 'getRubric')).toHaveLength(
      1,
    );
    const jtis = client.calls
      .filter((c) => c.method === 'evaluateClaim')
      .map((c) => (c.body as { claim: { jti: string } }).claim.jti);
    expect(new Set(jtis).size).toBe(2);
  });

  it('holds a rejected verdict in the ledger and tells the room', async () => {
    const { poster, ledger, submitter } = makeSubmitter({
      job: job('completed', REJECTED_SUMMARY),
    });
    await submitter.submitCompletedTask(completedRun());
    expect(await ledger.list('did:ixo:user1')).toMatchObject([
      { status: 'rejected', outcome: 2, reason: 'output too thin' },
    ]);
    expect(poster.texts[0]?.text).toContain('rejected');
    expect(poster.texts[0]?.text).toContain('on hold');
  });

  it('leaves a slow evaluation pending for the gate to refresh', async () => {
    const { poster, ledger, submitter } = makeSubmitter({
      job: job('processing'),
    });
    await submitter.submitCompletedTask(completedRun());
    expect(await ledger.list('did:ixo:user1')).toMatchObject([
      { status: 'pending' },
    ]);
    expect(poster.texts).toEqual([]); // no user-facing noise for a slow queue
  });

  it('records a failed entry when the engine rejects the submission', async () => {
    const { ledger, submitter } = makeSubmitter({
      accepted: { error: 'invalid_claim' },
    });
    await submitter.submitCompletedTask(completedRun());
    expect(await ledger.list('did:ixo:user1')).toMatchObject([
      { status: 'failed', reason: expect.stringContaining('invalid_claim') },
    ]);
  });

  it('never throws into the worker — engine outages become failed entries', async () => {
    const { ledger, submitter } = makeSubmitter({ throwOn: 'evaluateClaim' });
    await expect(
      submitter.submitCompletedTask(completedRun()),
    ).resolves.toBeUndefined();
    expect(await ledger.list('did:ixo:user1')).toMatchObject([
      { status: 'failed', reason: expect.stringContaining('engine down') },
    ]);
  });

  it('submits without a trace when the run thread is unavailable', async () => {
    const { client, poster, submitter } = makeSubmitter({
      job: job('completed', APPROVED_SUMMARY),
    });
    await submitter.submitCompletedTask({
      ...completedRun(),
      messages: undefined,
    });
    const body = client.calls.find((c) => c.method === 'evaluateClaim')
      ?.body as { claim: { trace?: unknown } };
    expect(body.claim.trace).toBeUndefined();
    expect(poster.events).toEqual([]);
  });
});

describe('VerifiedWorkGate', () => {
  function makeGate(script: FakeClientScript) {
    const client = fakeClient(script);
    const ledger = new VerifiedWorkLedger(fakeRedis());
    const gate = new VerifiedWorkGate({ client, ledger, logger: NOOP_LOGGER });
    return { client, ledger, gate };
  }

  const pendingEntry = {
    claimId: 'claim-1',
    taskId: 'task-1',
    status: 'pending' as const,
    updatedAt: 'now',
  };

  it('settles when the owner has no outstanding claims', async () => {
    const { gate } = makeGate({});
    expect(await gate.check('did:ixo:user1')).toEqual({ settle: true });
  });

  it('resolves freshly approved claims and settles', async () => {
    const { ledger, gate } = makeGate({
      status: {
        claimId: 'claim-1',
        job: job('completed', APPROVED_SUMMARY),
        manualReviewQueue: false,
      },
    });
    await ledger.record('did:ixo:user1', pendingEntry);
    expect(await gate.check('did:ixo:user1')).toEqual({ settle: true });
    expect(await ledger.list('did:ixo:user1')).toEqual([]);
  });

  it('holds while a claim is still pending, noting human review', async () => {
    const { ledger, gate } = makeGate({
      status: {
        claimId: 'claim-1',
        job: job('processing'),
        manualReviewQueue: true,
      },
    });
    await ledger.record('did:ixo:user1', pendingEntry);
    const verdict = await gate.check('did:ixo:user1');
    expect(verdict).toMatchObject({
      settle: false,
      reason: expect.stringContaining('held for human review'),
    });
  });

  it('marks rejected verdicts and holds settlement', async () => {
    const { ledger, gate } = makeGate({
      status: {
        claimId: 'claim-1',
        job: job('completed', REJECTED_SUMMARY),
        manualReviewQueue: false,
      },
    });
    await ledger.record('did:ixo:user1', pendingEntry);
    const verdict = await gate.check('did:ixo:user1');
    expect(verdict).toMatchObject({
      settle: false,
      reason: expect.stringContaining('rejected'),
    });
    expect(await ledger.list('did:ixo:user1')).toMatchObject([{ outcome: 2 }]);
  });

  it('fails closed when the engine is unreachable', async () => {
    const { ledger, gate } = makeGate({ throwOn: 'getClaimStatus' });
    await ledger.record('did:ixo:user1', pendingEntry);
    const verdict = await gate.check('did:ixo:user1');
    expect(verdict).toMatchObject({
      settle: false,
      reason: expect.stringContaining('engine unreachable'),
    });
  });

  it('lets an adjudication that flipped a rejection unblock settlement', async () => {
    const { ledger, gate } = makeGate({
      status: {
        claimId: 'claim-1',
        job: job('completed', APPROVED_SUMMARY),
        manualReviewQueue: false,
      },
    });
    await ledger.record('did:ixo:user1', {
      ...pendingEntry,
      status: 'rejected',
      outcome: 2,
    });
    expect(await gate.check('did:ixo:user1')).toEqual({ settle: true });
    expect(await ledger.list('did:ixo:user1')).toEqual([]);
  });
});

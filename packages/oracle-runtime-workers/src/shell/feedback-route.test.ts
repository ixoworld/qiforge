/**
 * `POST /messages/:sessionId/:messageId/feedback` through the real shell:
 * UCAN auth, the real reservation and markers over DO SQLite
 * (`FeedbackTestDO`), and an injected sink — a recording fake, or the real
 * Linear sink over a fake `fetch`. Nothing here calls Linear.
 */
import { env } from 'cloudflare:test';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  createDelegation,
  createInvocation,
  serializeDelegation,
  serializeInvocation,
  signerFromMnemonic,
} from '@ixo/ucan';
import { createShell } from './app';
import type { FeedbackConfig } from '../feedback/config';
import type {
  FeedbackDelivery,
  FeedbackIssue,
  FeedbackSink,
} from '../feedback/contract';
import { LinearFeedbackSink } from '../feedback/linear-sink';
import { FEEDBACK_PENDING_STALE_MS } from '../feedback/reservation';
import type { FeedbackTestDO, SeedMessage } from '../feedback/test-do';

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace -- augmenting the ambient `Cloudflare.Env` needs namespace syntax
  namespace Cloudflare {
    interface Env {
      FEEDBACK_TEST: DurableObjectNamespace<FeedbackTestDO>;
    }
  }
}

const { did: oracleDid } = await signerFromMnemonic(
  'legal winner thank year wave sausage worth useful legal winner thank yellow',
);
const ALICE =
  'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';
const BOB = 'zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo wrong';

async function signIn(mnemonic: string) {
  const { signer, did } = await signerFromMnemonic(mnemonic);
  const invocation = await serializeInvocation(
    await createInvocation({
      issuer: signer,
      audience: oracleDid,
      capability: { can: '*', with: 'ixo:oracle' },
      expiration: Math.floor(Date.now() / 1000) + 300,
    }),
  );
  return {
    did,
    headers: {
      authorization: `Bearer ${invocation}`,
      'x-auth-type': 'ucan',
      'content-type': 'application/json',
    },
  };
}

const SESSION = '$thread-root:ixo.test';
const HUMAN = '0b6f7c5e-4a63-4d6e-9d55-000000000001';
const replies = Array.from(
  { length: 5 },
  (_, i) => `0b6f7c5e-4a63-4d6e-9d55-${String(100 + i).padStart(12, '0')}`,
);
const AI = replies[0]!;
const transcript: SeedMessage[] = [
  { id: HUMAN, type: 'human', content: 'Explain staking' },
  ...replies.flatMap((id, i): SeedMessage[] => [
    { id, type: 'ai', content: `Staking answer ${i}` },
    {
      id: `0b6f7c5e-4a63-4d6e-9d55-${String(200 + i).padStart(12, '0')}`,
      type: 'human',
      content: `follow-up ${i}`,
    },
  ]),
];
const FEEDBACK = 'The staking answer skipped the unbonding period entirely.';
const context = {
  surface: 'workspace',
  locale: 'en-GB',
  theme: 'dark',
  deviceClass: 'desktop',
  viewportBucket: 'wide',
  network: 'testnet',
  portalBuildVersion: '4f2ea36',
} as const;
const sub = (n: number) =>
  `8103aeac-96e5-441b-9f87-${String(n).padStart(12, '0')}`;
const body = (n: number, feedback = `  ${FEEDBACK}  `) =>
  JSON.stringify({ submissionId: sub(n), feedback, context });
const path = (messageId = AI, sessionId = SESSION) =>
  `/messages/${encodeURIComponent(sessionId)}/${messageId}/feedback`;

const config: FeedbackConfig = {
  hmacSecret: 'route-test-secret-of-at-least-32-characters',
  linear: {
    apiUrl: 'https://linear.invalid/graphql',
    apiKey: 'lin_api_test',
    teamId: 'c781a53a-d432-469f-9c9c-2345a0f8243b',
    projectId: '6c1474a9-620c-4e3c-b443-0263992f3b55',
    labelIds: [],
  },
  agent: {
    did: 'did:ixo:oracle-entity',
    name: 'Agent',
    model: 'provider/model',
    provider: 'openrouter',
    runtimeBuildVersion: 'test',
  },
};

/** Cloudflare's rate-limit binding, per key, `limit` calls then refusals. */
function fakeRateLimit(limit: number) {
  const counts = new Map<string, number>();
  return {
    keys: counts,
    limit: vi.fn(async ({ key }: { key: string }) => {
      const n = (counts.get(key) ?? 0) + 1;
      counts.set(key, n);
      return { success: n <= limit };
    }),
  };
}

function recordingSink() {
  const issues: FeedbackIssue[] = [];
  const sink: FeedbackSink & { submit: ReturnType<typeof vi.fn> } = {
    submit: vi.fn(async (issue: FeedbackIssue): Promise<FeedbackDelivery> => {
      issues.push(issue);
      return 'created';
    }),
  };
  return { sink, issues };
}

/** The shell over per-user `FeedbackTestDO`s; `name` isolates one test's objects. */
async function fixture(
  name: string,
  sink: FeedbackSink,
  opts: { feedback?: boolean; ipLimit?: number } = {},
) {
  const objects = (userName: string) =>
    env.FEEDBACK_TEST.get(env.FEEDBACK_TEST.idFromName(`${name}/${userName}`));
  const idFromName = vi.fn((userName: string) => userName);
  const get = vi.fn((userName: string) => objects(userName));
  const rateLimit = fakeRateLimit(opts.ipLimit ?? 1000);
  const app = createShell(
    opts.feedback === false ? {} : { feedback: { config, sink } },
  );
  const bindings = {
    ORACLE_DID: oracleDid,
    BLOCKSYNC_GRAPHQL_URL: 'https://unused.example.com',
    USER_ORACLE: { idFromName, get },
    FEEDBACK_RATE_LIMIT: rateLimit,
  };
  const userObject = async (did: string) => {
    const stub = objects(`${oracleDid}::${did}`);
    await stub.seed(SESSION, transcript);
    return stub;
  };
  const post = (
    headers: Record<string, string>,
    payload: string,
    target = path(),
    ip = '198.51.100.7',
  ) =>
    app.request(
      target,
      {
        method: 'POST',
        headers: {
          ...headers,
          'cf-connecting-ip': ip,
          'user-agent': 'Mozilla/5.0 (Macintosh) PrivateBrowser/1.2.3',
        },
        body: payload,
      },
      bindings,
    );
  return { app, bindings, get, idFromName, rateLimit, userObject, post };
}

afterEach(() => vi.restoreAllMocks());

describe('POST /messages/:sessionId/:messageId/feedback', () => {
  it('rejects a request without authentication before touching any user object', async () => {
    const { sink } = recordingSink();
    const f = await fixture('no-auth', sink);
    const res = await f.app.request(
      path(),
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: body(1),
      },
      f.bindings,
    );
    expect(res.status).toBe(401);
    expect(f.get).not.toHaveBeenCalled();
    expect(sink.submit).not.toHaveBeenCalled();
  });

  it('answers 404 while the feature is not configured', async () => {
    const { sink } = recordingSink();
    const alice = await signIn(ALICE);
    const f = await fixture('disabled', sink, { feedback: false });
    const res = await f.post(alice.headers, body(1));
    expect(res.status).toBe(404);
    expect(await res.json()).toMatchObject({
      code: 'FEEDBACK_DISABLED',
      retryable: false,
    });
    expect(f.get).not.toHaveBeenCalled();
  });

  it('delivers one issue with pseudonyms and allowlisted context only, for the signed caller', async () => {
    const { sink, issues } = recordingSink();
    const alice = await signIn(ALICE);
    const f = await fixture('happy', sink);
    const user = await f.userObject(alice.did);

    const res = await f.post(alice.headers, body(1));
    expect(res.status).toBe(200);
    const answer = await res.json<{
      submissionId: string;
      status: string;
      submittedAt: string;
    }>();
    expect(answer).toEqual({
      submissionId: sub(1),
      status: 'submitted',
      submittedAt: expect.stringMatching(/^\d{4}-\d\d-\d\dT/),
    });
    expect(f.idFromName).toHaveBeenCalledWith(`${oracleDid}::${alice.did}`);
    expect(await user.callerDids()).toEqual([alice.did, alice.did]);
    expect(await user.markerStatus(SESSION, AI)).toBe('delivered');

    expect(issues).toHaveLength(1);
    const issue = issues[0]!;
    expect(issue.feedback).toBe(FEEDBACK);
    expect(issue.context).toEqual(context);
    expect(issue.agent).toEqual(config.agent);
    expect(issue.submittedAt).toBe(answer.submittedAt);
    expect(issue.userPseudonym).toMatch(/^user_[a-f0-9]{64}$/);
    expect(issue.sessionFingerprint).toMatch(/^session_[a-f0-9]{64}$/);
    expect(issue.messageFingerprint).toMatch(/^message_[a-f0-9]{64}$/);
    const serialized = JSON.stringify(issue);
    for (const leaked of [
      alice.did,
      SESSION,
      AI,
      '198.51.100.7',
      'PrivateBrowser',
      'Explain staking',
      'Staking answer',
      config.hmacSecret,
    ])
      expect(serialized).not.toContain(leaked);
  });

  it('ignores anything outside the allowlisted body: unknown fields are a 400, not forwarded', async () => {
    const { sink } = recordingSink();
    const alice = await signIn(ALICE);
    const f = await fixture('allowlist', sink);
    await f.userObject(alice.did);
    for (const payload of [
      JSON.stringify({
        submissionId: sub(1),
        feedback: FEEDBACK,
        context,
        prompt: 'Explain staking',
      }),
      JSON.stringify({
        submissionId: sub(1),
        feedback: FEEDBACK,
        context: { ...context, location: 'Tbilisi' },
      }),
      JSON.stringify({
        submissionId: 'not-a-uuid',
        feedback: FEEDBACK,
        context,
      }),
      JSON.stringify({ submissionId: sub(1), feedback: '', context }),
      JSON.stringify({ submissionId: sub(1), feedback: '   ', context }),
      JSON.stringify({
        submissionId: sub(1),
        feedback: 'x'.repeat(2001),
        context,
      }),
      'not json',
    ]) {
      const res = await f.post(alice.headers, payload);
      expect(res.status).toBe(400);
    }
    const tooLarge = await f.post(alice.headers, 'x'.repeat(16 * 1024 + 1));
    expect(tooLarge.status).toBe(413);
    expect(sink.submit).not.toHaveBeenCalled();
  });

  it('answers 404 for an unknown session, an unknown message, a user message and the reply of a running turn', async () => {
    const { sink } = recordingSink();
    const alice = await signIn(ALICE);
    const f = await fixture('not-found', sink);
    const user = await f.userObject(alice.did);
    for (const target of [
      path(AI, '$other-thread:ixo.test'),
      path('0b6f7c5e-4a63-4d6e-9d55-999999999999'),
      path(HUMAN),
    ]) {
      const res = await f.post(alice.headers, body(1), target);
      expect(res.status).toBe(404);
      expect(await res.json()).toMatchObject({
        code: 'FEEDBACK_TARGET_NOT_FOUND',
      });
    }

    // The last reply belongs to the turn still running: not complete yet.
    const lastReply = replies[replies.length - 1]!;
    await user.seed(
      SESSION,
      transcript.slice(0, transcript.findIndex((m) => m.id === lastReply) + 1),
    );
    await user.setRunning(SESSION, true);
    expect((await f.post(alice.headers, body(1), path(lastReply))).status).toBe(
      404,
    );
    expect(sink.submit).not.toHaveBeenCalled();
  });

  it('cannot reach another user’s messages: the target is looked up in the caller’s own database', async () => {
    const { sink } = recordingSink();
    const alice = await signIn(ALICE);
    const bob = await signIn(BOB);
    const f = await fixture('cross-user', sink);
    await f.userObject(alice.did); // only Alice has the session
    const res = await f.post(bob.headers, body(1));
    expect(res.status).toBe(404);
    expect(sink.submit).not.toHaveBeenCalled();
  });

  it('rejects direct identifiers and secrets with 422 before reserving anything', async () => {
    const { sink } = recordingSink();
    const alice = await signIn(ALICE);
    const f = await fixture('screening', sink);
    const user = await f.userObject(alice.did);
    for (const feedback of [
      'Reach me at person@example.com',
      `My DID is ${alice.did}`,
      'My key is api_key=sk-live-123',
      'Call +27 82 555 0123',
    ]) {
      const res = await f.post(alice.headers, body(1, feedback));
      expect(res.status).toBe(422);
      const answer = await res.json<{ code: string; message: string }>();
      expect(answer).toMatchObject({
        code: 'FEEDBACK_CONTAINS_PERSONAL_DATA',
        retryable: false,
      });
      expect(JSON.stringify(answer)).not.toContain(feedback);
    }
    expect(sink.submit).not.toHaveBeenCalled();
    expect(await user.callerDids()).toEqual([]);
  });

  it('answers a duplicate submission with the same outcome and no second issue; other feedback for the message is a conflict', async () => {
    const { sink } = recordingSink();
    const alice = await signIn(ALICE);
    const f = await fixture('idempotent', sink);
    await f.userObject(alice.did);

    const first = await f.post(alice.headers, body(1));
    const again = await f.post(alice.headers, body(1));
    expect(first.status).toBe(200);
    expect(again.status).toBe(200);
    expect(await again.json()).toEqual(await first.json());
    expect(sink.submit).toHaveBeenCalledTimes(1);

    const other = await f.post(alice.headers, body(2, 'A different note.'));
    expect(other.status).toBe(409);
    expect(await other.json()).toMatchObject({
      code: 'FEEDBACK_ALREADY_SUBMITTED',
      retryable: false,
    });
    expect(sink.submit).toHaveBeenCalledTimes(1);
  });

  it('tells a client retrying a submission still being delivered to retry, and other feedback that it is too late', async () => {
    const { sink } = recordingSink();
    const alice = await signIn(ALICE);
    const f = await fixture('in-flight', sink);
    const user = await f.userObject(alice.did);
    // Another request (another isolate) holds the reservation for sub(1).
    await user.reserveMessageFeedback(
      { userDid: alice.did },
      { sessionId: SESSION, messageId: AI, submissionId: sub(1) },
    );

    const retry = await f.post(alice.headers, body(1));
    expect(retry.status).toBe(409);
    expect(await retry.json()).toMatchObject({
      code: 'FEEDBACK_IN_FLIGHT',
      retryable: true,
    });
    const other = await f.post(alice.headers, body(2, 'A different note.'));
    expect(other.status).toBe(409);
    expect(await other.json()).toMatchObject({
      code: 'FEEDBACK_ALREADY_SUBMITTED',
      retryable: false,
    });
    expect(sink.submit).not.toHaveBeenCalled();
  });

  it('never answers 200 for text that was not sent: a takeover of a crashed submission whose issue exists is a 409', async () => {
    const issues: FeedbackIssue[] = [];
    // Linear already holds the first submission's issue for this message.
    const sink: FeedbackSink = {
      submit: vi.fn(async (issue: FeedbackIssue): Promise<FeedbackDelivery> => {
        issues.push(issue);
        return 'existing';
      }),
    };
    const alice = await signIn(ALICE);
    const f = await fixture('superseded', sink);
    const user = await f.userObject(alice.did);
    // The first submission reserved, created the issue, and its isolate died
    // before settling; the reservation goes stale.
    await user.reserveMessageFeedback(
      { userDid: alice.did },
      { sessionId: SESSION, messageId: AI, submissionId: sub(1) },
    );
    await user.advance(FEEDBACK_PENDING_STALE_MS);

    const second = await f.post(alice.headers, body(2, 'A different note.'));
    expect(second.status).toBe(409);
    expect(await second.json()).toMatchObject({
      code: 'FEEDBACK_ALREADY_SUBMITTED',
    });
    expect(issues).toHaveLength(1);
    expect(await user.markerStatus(SESSION, AI)).toBe('delivered');
    // The marker is the first submission's: a retry of the second stays a 409.
    expect(
      (await f.post(alice.headers, body(2, 'A different note.'))).status,
    ).toBe(409);
    expect(issues).toHaveLength(1);
  });

  it('answers 200 when the same submission takes over its own stale reservation and finds its issue', async () => {
    const sink: FeedbackSink = {
      submit: vi.fn(async (): Promise<FeedbackDelivery> => 'existing'),
    };
    const alice = await signIn(ALICE);
    const f = await fixture('stale-self', sink);
    const user = await f.userObject(alice.did);
    await user.reserveMessageFeedback(
      { userDid: alice.did },
      { sessionId: SESSION, messageId: AI, submissionId: sub(1) },
    );
    await user.advance(FEEDBACK_PENDING_STALE_MS);
    const res = await f.post(alice.headers, body(1));
    expect(res.status).toBe(200);
    expect(await user.markerStatus(SESSION, AI)).toBe('delivered');
  });

  it('limits one user to three submissions a minute, whatever IP they come from', async () => {
    const { sink } = recordingSink();
    const alice = await signIn(ALICE);
    const f = await fixture('did-limit', sink);
    await f.userObject(alice.did);
    for (let i = 0; i < 3; i += 1)
      expect(
        (await f.post(alice.headers, body(i), path(replies[i]), `192.0.2.${i}`))
          .status,
      ).toBe(200);
    const res = await f.post(
      alice.headers,
      body(3),
      path(replies[3]),
      '203.0.113.50',
    );
    expect(res.status).toBe(429);
    expect(await res.json()).toMatchObject({
      code: 'FEEDBACK_RATE_LIMITED',
      retryable: true,
    });
    expect(sink.submit).toHaveBeenCalledTimes(3);
  });

  it('limits one IP across users, keyed by a pseudonym of the address', async () => {
    const { sink } = recordingSink();
    const alice = await signIn(ALICE);
    const bob = await signIn(BOB);
    const f = await fixture('ip-limit', sink, { ipLimit: 3 });
    await f.userObject(alice.did);
    await f.userObject(bob.did);
    const ip = '198.51.100.7';
    for (let i = 0; i < 2; i += 1)
      expect(
        (await f.post(alice.headers, body(i), path(replies[i]), ip)).status,
      ).toBe(200);
    expect(
      (await f.post(bob.headers, body(2), path(replies[0]), ip)).status,
    ).toBe(200);
    // Bob's own limit is untouched; the shared address is spent.
    expect(
      (await f.post(bob.headers, body(3), path(replies[1]), ip)).status,
    ).toBe(429);
    expect(
      (await f.post(bob.headers, body(3), path(replies[1]), '203.0.113.9'))
        .status,
    ).toBe(200);
    expect(sink.submit).toHaveBeenCalledTimes(4);
    for (const key of f.rateLimit.keys.keys()) {
      expect(key).toMatch(/^feedback:ip_[a-f0-9]{64}$/);
      expect(key).not.toContain(ip);
    }
  });

  it('retries a failing Linear a bounded number of times, then answers 502 and releases the reservation', async () => {
    const calls: string[] = [];
    let linearDown = true;
    const fakeLinear = vi.fn(
      async (_url: RequestInfo | URL, init?: RequestInit) => {
        const sent = JSON.parse(String(init?.body)) as { query: string };
        const op = sent.query.includes('issueCreate') ? 'create' : 'find';
        calls.push(op);
        // Linear sends its hour-window reset on every response; a 503 must
        // still be retried with backoff, not abandoned as "wait an hour".
        const headers = {
          'x-ratelimit-requests-reset': String(Date.now() + 45 * 60_000),
        };
        if (op === 'find')
          return Response.json(
            { data: { issues: { nodes: [] } } },
            { headers },
          );
        return linearDown
          ? Response.json({}, { status: 503, headers })
          : Response.json(
              { data: { issueCreate: { success: true, issue: { id: 'i' } } } },
              { headers },
            );
      },
    );
    const sink = new LinearFeedbackSink(config.linear, {
      fetch: fakeLinear,
      sleep: async () => undefined,
    });
    const alice = await signIn(ALICE);
    const f = await fixture('sink-failure', sink);
    const user = await f.userObject(alice.did);

    const res = await f.post(alice.headers, body(1));
    expect(res.status).toBe(502);
    expect(await res.json()).toMatchObject({
      statusCode: 502,
      code: 'FEEDBACK_DELIVERY_FAILED',
      retryable: true,
    });
    expect(calls).toEqual([
      'find',
      'create',
      'find',
      'create',
      'find',
      'create',
    ]);
    expect(await user.markerStatus(SESSION, AI)).toBeNull();
    expect((await user.dump()).text).not.toContain('unbonding');

    linearDown = false;
    expect((await f.post(alice.headers, body(1))).status).toBe(200);
    expect(await user.markerStatus(SESSION, AI)).toBe('delivered');
  });

  it('never writes the feedback text to a log line or a stored row', async () => {
    const logged: unknown[][] = [];
    for (const level of ['log', 'info', 'warn', 'error', 'debug'] as const)
      vi.spyOn(console, level).mockImplementation((...args: unknown[]) => {
        logged.push(args);
      });
    let fail = true;
    const sink: FeedbackSink = {
      submit: async (issue) => {
        if (fail) {
          fail = false;
          // A sink that leaks the issue into its error must not leak it further.
          throw new Error(`upstream rejected: ${issue.feedback}`);
        }
        return 'created';
      },
    };
    const alice = await signIn(ALICE);
    const f = await fixture('no-text-anywhere', sink);
    const user = await f.userObject(alice.did);

    expect((await f.post(alice.headers, body(1))).status).toBe(502);
    expect((await f.post(alice.headers, body(1))).status).toBe(200);
    expect(
      (
        await f.post(
          alice.headers,
          body(2, `${FEEDBACK} me@example.com`),
          path(replies[1]),
        )
      ).status,
    ).toBe(422);

    expect(logged.length).toBeGreaterThan(0); // the failure and the delivery were logged
    const text = JSON.stringify(logged);
    expect(text).not.toContain('unbonding');
    expect(text).not.toContain('me@example.com');
    expect(text).not.toContain(alice.did);
    const db = (await user.dump()).text;
    expect(db).toContain(sub(1)); // the marker is there…
    expect(db).not.toContain('unbonding'); // …the text is not
    expect(db).not.toContain('me@example.com');
  });
});

describe('shell log lines on the feedback route', () => {
  it('name the route pattern, never the path with its session and message ids', async () => {
    const lines: string[] = [];
    for (const level of ['warn', 'error'] as const)
      vi.spyOn(console, level).mockImplementation((...args: unknown[]) => {
        lines.push(args.map(String).join(' '));
      });
    const { signer, did } = await signerFromMnemonic(ALICE);
    const delegation = await serializeDelegation(
      await createDelegation({
        issuer: signer,
        audience: oracleDid,
        capabilities: [{ can: '*', with: 'ixo:oracle' }],
        expiration: Math.floor(Date.now() / 1000) + 300,
      }),
    );
    const { sink } = recordingSink();
    const app = createShell({ feedback: { config, sink } });
    // The user object fails, so the shell's error handler logs too.
    const failing = {
      reserveMessageFeedback: async () => {
        throw new Error('object unavailable');
      },
    };
    const res = await app.request(
      path(),
      {
        method: 'POST',
        headers: {
          'x-ucan-delegation': delegation,
          'content-type': 'application/json',
        },
        body: body(1),
      },
      {
        ORACLE_DID: oracleDid,
        BLOCKSYNC_GRAPHQL_URL: 'https://unused.example.com',
        UCAN_ALLOW_BARE_DELEGATION_AUTH: 'true',
        USER_ORACLE: { idFromName: (n: string) => n, get: () => failing },
      },
    );
    expect(res.status).toBe(500);
    const auth = lines.find((line) => line.startsWith('[auth]'));
    const failure = lines.find((line) => line.startsWith('[shell]'));
    expect(auth).toContain('POST /messages/:sessionId/:messageId/feedback');
    expect(auth).toContain(did); // the warning is about this caller…
    expect(failure).toContain('POST /messages/:sessionId/:messageId/feedback');
    for (const line of lines) {
      // …but no line ties the caller to the conversation.
      expect(line).not.toContain(AI);
      expect(line).not.toContain(SESSION);
      expect(line).not.toContain(encodeURIComponent(SESSION));
    }
  });
});

describe('capability advertisement', () => {
  function listingFixture(feedback: boolean) {
    const user = {
      listMessages: vi.fn(
        async () => '[{"id":"m1","type":"ai","content":"hi"}]',
      ),
      listMessagesPage: vi.fn(async () => ({
        ok: true as const,
        json: '{"messages":[],"prevCursor":null,"nextCursor":null,"hasOlder":false,"hasNewer":false}',
      })),
    };
    const { sink } = recordingSink();
    return {
      app: createShell(feedback ? { feedback: { config, sink } } : {}),
      bindings: {
        ORACLE_DID: oracleDid,
        BLOCKSYNC_GRAPHQL_URL: 'https://unused.example.com',
        USER_ORACLE: { idFromName: (n: string) => n, get: () => user },
      },
    };
  }

  it('advertises anonymousMessageFeedback on both transcript routes only when configured', async () => {
    const alice = await signIn(ALICE);
    for (const enabled of [true, false]) {
      const f = listingFixture(enabled);
      const legacy = await (
        await f.app.request(
          `/messages/${encodeURIComponent(SESSION)}`,
          { headers: alice.headers },
          f.bindings,
        )
      ).json<Record<string, unknown>>();
      const paged = await (
        await f.app.request(
          `/sessions/${encodeURIComponent(SESSION)}/messages`,
          { headers: alice.headers },
          f.bindings,
        )
      ).json<Record<string, unknown>>();
      expect(legacy.messages).toEqual([
        { id: 'm1', type: 'ai', content: 'hi' },
      ]);
      expect(paged.hasOlder).toBe(false);
      const expected = enabled ? { anonymousMessageFeedback: true } : undefined;
      expect(legacy.capabilities).toEqual(expected);
      expect(paged.capabilities).toEqual(expected);
      expect('capabilities' in legacy).toBe(enabled);
      expect('capabilities' in paged).toBe(enabled);
    }
  });
});

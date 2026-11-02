/**
 * `GET /runs/active` at the shell: it reaches only the caller's own user
 * object (chosen from the DID the UCAN invocation proves), answers
 * `{ runs }`, is not taken for a run id by `GET /runs/:runId`, and spends
 * the `poll` rate-limit budget, not the one the user's messages spend. What
 * the object answers is tested on the real object
 * (`src/do/user-object-lifecycle.test.ts`).
 */
import {
  createDelegation,
  createInvocation,
  generateKeypair,
  serializeDelegation,
  serializeInvocation,
  type Signer,
} from '@ixo/ucan';
import { describe, expect, it } from 'vitest';
import { withActiveRuns } from '../do/active-runs';
import {
  userObjectName,
  type RunSummary,
  type SessionSummary,
  type TurnIdentity,
} from '../do/contracts';
import type { RunRecord } from '../do/run-store';
import { createShell, rateLimitKey } from './app';

// did:key throughout, oracle included: the validator resolves every DID in
// the invocation, and did:key resolves locally — Blocksync is never asked.
const ORACLE_DID = (await generateKeypair()).did;

async function authHeaders(
  signer: Signer,
  audience = ORACLE_DID,
): Promise<Record<string, string>> {
  const invocation = await createInvocation({
    issuer: signer,
    audience,
    capability: { can: '*', with: 'ixo:oracle' },
    proofs: [],
    expiration: Math.floor(Date.now() / 1000) + 300,
  });
  return {
    authorization: `Bearer ${await serializeInvocation(invocation)}`,
    'x-auth-type': 'ucan',
  };
}

/** The user's delegation to the oracle, as the Portal sends it. */
async function delegationOf(signer: Signer): Promise<string> {
  return serializeDelegation(
    await createDelegation({
      issuer: signer,
      audience: ORACLE_DID,
      capabilities: [{ can: '*', with: 'ixo:oracle' }],
    }),
  );
}

/**
 * A `USER_ORACLE` namespace whose objects answer `activeRuns` and
 * `listSessions` from fixed data. It records every object lookup
 * (`idFromName`, `get`) and every call with the identity it carried. It has
 * no `fetch`: a request routed to `GET /runs/:runId` fails.
 */
function userObjects(o: {
  runs?: Record<string, RunSummary[]>;
  sessions?: SessionSummary[];
}) {
  const lookups: string[] = [];
  const calls: Array<{
    object: string;
    method: string;
    identity: TurnIdentity;
  }> = [];
  const USER_ORACLE = {
    idFromName: (name: string) => {
      lookups.push(`idFromName ${name}`);
      return name;
    },
    get: (object: string) => {
      lookups.push(`get ${object}`);
      return {
        activeRuns: async (identity: TurnIdentity) => {
          calls.push({ object, method: 'activeRuns', identity });
          return o.runs?.[object] ?? [];
        },
        listSessions: async (identity: TurnIdentity) => {
          calls.push({ object, method: 'listSessions', identity });
          const sessions = o.sessions ?? [];
          return { sessions, total: sessions.length };
        },
      };
    },
  };
  const limiterKeys: string[] = [];
  /** Refuses the keys in `refused` (a user at that budget's limit). */
  const refused = new Set<string>();
  const env = {
    ORACLE_DID,
    BLOCKSYNC_GRAPHQL_URL: 'https://blocksync.invalid/graphql',
    USER_ORACLE,
    RATE_LIMIT: {
      limit: async ({ key }: { key: string }) => {
        limiterKeys.push(key);
        return { success: !refused.has(key) };
      },
    },
  };
  return { env, calls, lookups, limiterKeys, refused };
}

const T = '2026-10-21T10:00:00.000Z';

function runRecord(runId: string, sessionId: string): RunRecord {
  return {
    runId,
    sessionId,
    requestId: `req-${runId}`,
    client: 'matrix',
    status: 'running',
    startedAt: T,
    updatedAt: T,
    request: '{}',
    attempts: 0,
    generation: 0,
    nextAttemptAt: null,
    checkpointId: null,
    startCheckpointId: null,
    startRecorded: true,
    lastSeq: 0,
    partialText: 'reply so far',
    messageId: null,
    error: null,
    taskRunId: null,
    instanceId: 'i1',
    usage: null,
  };
}

describe('GET /runs/active', () => {
  it("answers { runs: [] } for a user with nothing running, from the caller's own object", async () => {
    const alice = await generateKeypair();
    const { env, calls } = userObjects({});
    const res = await createShell().request(
      '/runs/active',
      { headers: await authHeaders(alice.signer) },
      env,
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ runs: [] });
    expect(calls).toMatchObject([
      {
        object: userObjectName(alice.did, ORACLE_DID),
        method: 'activeRuns',
        identity: { userDid: alice.did },
      },
    ]);
  });

  it("returns the caller's runs and never another user's: Bob's invocation reaches Bob's object even with Alice's delegation attached", async () => {
    const alice = await generateKeypair();
    const bob = await generateKeypair();
    const aliceRun: RunSummary = {
      runId: 'r1',
      sessionId: 's-alice',
      requestId: 'req-1',
      client: 'portal',
      status: 'running',
      startedAt: T,
      updatedAt: T,
      lastSeq: 0,
    };
    const { env, calls } = userObjects({
      runs: { [userObjectName(alice.did, ORACLE_DID)]: [aliceRun] },
    });
    const app = createShell();
    const asAlice = await app.request(
      '/runs/active',
      { headers: await authHeaders(alice.signer) },
      env,
    );
    expect(await asAlice.json()).toEqual({ runs: [aliceRun] });
    // Bob sends his own invocation with Alice's delegation: the invocation
    // proves who calls, a delegation of another user is never paired with it.
    const asBob = await app.request(
      '/runs/active',
      {
        headers: {
          ...(await authHeaders(bob.signer)),
          'x-ucan-delegation': await delegationOf(alice.signer),
        },
      },
      env,
    );
    expect(asBob.status).toBe(200);
    expect(await asBob.json()).toEqual({ runs: [] });
    expect(calls[1]?.object).toBe(userObjectName(bob.did, ORACLE_DID));
    expect(calls[1]?.identity.userDid).toBe(bob.did);
    expect(calls[1]?.identity.ucanDelegation).toBeUndefined();
  });

  it('refuses an unauthenticated caller, or an invocation addressed to another oracle, before any user object is looked up', async () => {
    const alice = await generateKeypair();
    const otherOracle = (await generateKeypair()).did;
    const { env, calls, lookups } = userObjects({});
    const app = createShell();
    const anonymous = await app.request('/runs/active', {}, env);
    expect(anonymous.status).toBe(401);
    const elsewhere = await app.request(
      '/runs/active',
      { headers: await authHeaders(alice.signer, otherOracle) },
      env,
    );
    expect(elsewhere.status).toBe(401);
    expect(lookups).toEqual([]);
    expect(calls).toEqual([]);
  });

  it("spends the poll budget, apart from the one the user's messages spend: a user at the message limit can still poll", async () => {
    const alice = await generateKeypair();
    const { env, limiterKeys, refused } = userObjects({});
    const messageKey = rateLimitKey(env, 'user', alice.did);
    const pollKey = rateLimitKey(env, 'poll', alice.did);
    expect(pollKey).not.toBe(messageKey);
    refused.add(messageKey);
    const app = createShell();
    const poll = await app.request(
      '/runs/active',
      { headers: await authHeaders(alice.signer) },
      env,
    );
    expect(poll.status).toBe(200);
    expect(limiterKeys).toEqual([pollKey]);
    // Any other route spends the message budget, refused here.
    const sessions = await app.request(
      '/sessions',
      { headers: await authHeaders(alice.signer) },
      env,
    );
    expect(sessions.status).toBe(429);
    expect(limiterKeys).toEqual([pollKey, messageKey]);
    // And a user at the poll limit is refused only the poll.
    refused.clear();
    refused.add(pollKey);
    const refusedPoll = await app.request(
      '/runs/active',
      { headers: await authHeaders(alice.signer) },
      env,
    );
    expect(refusedPoll.status).toBe(429);
  });
});

describe('GET /sessions rows on the wire', () => {
  it('carry activeRun as the object returned it; a row without one has no key', async () => {
    const alice = await generateKeypair();
    const rows: SessionSummary[] = [
      { sessionId: 'busy', title: 'Busy', createdAt: T, lastUpdatedAt: T },
      { sessionId: 'idle', title: 'Idle', createdAt: T, lastUpdatedAt: T },
    ];
    const { env } = userObjects({
      sessions: withActiveRuns(rows, [runRecord('r1', 'busy')]),
    });
    const res = await createShell().request(
      '/sessions',
      { headers: await authHeaders(alice.signer) },
      env,
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      sessions: Array<Record<string, unknown>>;
      total: number;
    };
    expect(body.sessions[0]?.activeRun).toEqual({
      runId: 'r1',
      sessionId: 'busy',
      requestId: 'req-r1',
      client: 'matrix',
      status: 'running',
      startedAt: T,
      updatedAt: T,
      lastSeq: 0,
    });
    expect(Object.keys(body.sessions[1]!)).not.toContain('activeRun');
  });
});

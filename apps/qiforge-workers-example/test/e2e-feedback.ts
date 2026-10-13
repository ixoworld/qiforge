/**
 * Anonymous Agent-response feedback, end to end against the local harness.
 *
 *   pnpm test:e2e:feedback                       # boots wrangler dev
 *   STEP_FILTER='^deliver' pnpm test:e2e:feedback
 *
 * Local only: Linear is replaced by a fake GraphQL server on 127.0.0.1 that
 * the oracle reaches through `FEEDBACK_LINEAR_API_URL`, so the real Linear
 * sink, the user object's reservation and the shell route run unchanged and
 * nothing is sent to Linear. A deployed oracle cannot reach the fake.
 *
 * What it proves: the transcript routes advertise the capability; the route
 * answers 401 / 404 / 422 / 409 / 502 as documented; a completed reply's
 * feedback becomes exactly one issue (find, then create) whose body holds
 * the text and pseudonyms but no raw DID, session id or message id; a
 * duplicate is answered again without a second issue; a Linear outage
 * releases the reservation so a retry succeeds.
 */
import assert from 'node:assert/strict';
import { createServer, type IncomingMessage } from 'node:http';
import type { AddressInfo } from 'node:net';
import { randomUUID } from 'node:crypto';
import { ChatClient } from './lib/chat-client';
import {
  STATIC_ACCOUNTS,
  mintAuthInvocation,
  mintDelegation,
  type HarnessAccount,
} from './lib/harness';
import { ORACLE_DID, provisionDevVars, startOracle } from './lib/oracle';

const ONLY = process.env.STEP_FILTER
  ? new RegExp(process.env.STEP_FILTER)
  : null;
const LINEAR_KEY = 'lin_api_e2e_fake';
const PROJECT_ID = '6c1474a9-620c-4e3c-b443-0263992f3b55';

const results: Array<{
  name: string;
  ok: boolean;
  ms: number;
  detail?: string;
}> = [];

async function step<T>(
  name: string,
  fn: () => Promise<T>,
): Promise<T | undefined> {
  if (ONLY && !ONLY.test(name)) {
    console.log(`▷ ${name} … skipped (STEP_FILTER)`);
    return undefined;
  }
  const start = Date.now();
  process.stdout.write(`▶ ${name} … `);
  try {
    const out = await fn();
    results.push({ name, ok: true, ms: Date.now() - start });
    console.log(`ok (${Date.now() - start} ms)`);
    return out;
  } catch (err) {
    results.push({
      name,
      ok: false,
      ms: Date.now() - start,
      detail: err instanceof Error ? err.message : String(err),
    });
    console.log(`FAILED (${Date.now() - start} ms)`);
    console.log(`   ${err instanceof Error ? err.stack : String(err)}`);
    return undefined;
  }
}

interface LinearCall {
  op: 'find' | 'create';
  authorization: string | undefined;
  variables: Record<string, unknown>;
}

/** A Linear GraphQL stand-in: finds by description marker, creates issues, or fails on demand. */
async function startFakeLinear() {
  const calls: LinearCall[] = [];
  const issues: Array<{ projectId: string; description: string }> = [];
  let down = false;
  const read = (req: IncomingMessage) =>
    new Promise<string>((resolve, reject) => {
      let data = '';
      req.on('data', (chunk: Buffer) => (data += chunk.toString('utf8')));
      req.on('end', () => resolve(data));
      req.on('error', reject);
    });
  const server = createServer((req, res) => {
    void (async () => {
      const { query, variables } = JSON.parse(await read(req)) as {
        query: string;
        variables: Record<string, unknown>;
      };
      const op = query.includes('issueCreate') ? 'create' : 'find';
      calls.push({ op, authorization: req.headers.authorization, variables });
      res.setHeader('content-type', 'application/json');
      // Like Linear, every response carries the hour window's reset, a 503
      // included: the sink must still back off and retry, not give up.
      res.setHeader('x-ratelimit-requests-limit', '5000');
      res.setHeader('x-ratelimit-requests-remaining', '4990');
      res.setHeader(
        'x-ratelimit-requests-reset',
        String(Date.now() + 45 * 60_000),
      );
      if (op === 'find') {
        const marker = String(variables.marker);
        const nodes = issues
          .filter(
            (i) =>
              i.projectId === variables.projectId &&
              i.description.includes(marker),
          )
          .map((_, n) => ({ id: `issue-${n}` }));
        res.end(JSON.stringify({ data: { issues: { nodes } } }));
        return;
      }
      if (down) {
        res.statusCode = 503;
        res.end('{}');
        return;
      }
      const input = variables.input as {
        projectId: string;
        description: string;
      };
      issues.push(input);
      res.end(
        JSON.stringify({
          data: {
            issueCreate: {
              success: true,
              issue: { id: `issue-${issues.length}` },
            },
          },
        }),
      );
    })();
  });
  await new Promise<void>((resolve) =>
    server.listen(0, '127.0.0.1', () => resolve()),
  );
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}/graphql`,
    calls,
    issues,
    setDown: (value: boolean) => {
      down = value;
    },
    stop: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

const context = {
  surface: 'workspace',
  locale: 'en',
  theme: 'light',
  deviceClass: 'desktop',
  viewportBucket: 'wide',
  network: 'devnet',
} as const;

async function main(): Promise<void> {
  if (process.env.ORACLE_URL)
    throw new Error(
      'e2e-feedback runs against the local harness only (the fake Linear is on 127.0.0.1)',
    );
  const linear = await startFakeLinear();
  await provisionDevVars({
    extra: {
      FEEDBACK_LINEAR_API_KEY: LINEAR_KEY,
      FEEDBACK_HMAC_SECRET: randomUUID() + randomUUID(),
      FEEDBACK_LINEAR_PROJECT_ID: PROJECT_ID,
      FEEDBACK_LINEAR_API_URL: linear.url,
    },
  });
  const oracle = await startOracle();
  console.log(`oracle at ${oracle.url}, fake Linear at ${linear.url}`);
  try {
    const alice = STATIC_ACCOUNTS[1] as HarnessAccount;
    const invocation = await mintAuthInvocation(alice, ORACLE_DID);
    const delegation = await mintDelegation(alice, ORACLE_DID, [
      { can: 'memory/*', with: 'ixo:memory' },
    ]);
    const client = new ChatClient(oracle.url, { invocation, delegation });
    const feedback = (
      sessionId: string,
      messageId: string,
      body: Record<string, unknown>,
      headers = client.headers(),
    ) =>
      fetch(
        `${oracle.url}/messages/${encodeURIComponent(sessionId)}/${encodeURIComponent(messageId)}/feedback`,
        { method: 'POST', headers, body: JSON.stringify(body) },
      );

    const seeded = await step(
      'seed: two completed turns in one session',
      async () => {
        const sessionId = await client.createSession();
        for (const ask of [
          'Reply with exactly: FEEDBACK ONE',
          'Reply with exactly: FEEDBACK TWO',
        ]) {
          const r = await client.stream(sessionId, ask);
          assert.equal(r.status, 200, r.text);
        }
        const res = await fetch(
          `${oracle.url}/messages/${encodeURIComponent(sessionId)}`,
          { headers: client.headers() },
        );
        assert.equal(res.status, 200);
        const listing: {
          messages: Array<{ id: string; type: string }>;
          capabilities?: Record<string, unknown>;
        } = await res.json();
        const replies = listing.messages.filter((m) => m.type === 'ai');
        const human = listing.messages.find((m) => m.type === 'human');
        assert.ok(replies.length >= 2 && human, 'expected two replies');
        return {
          sessionId,
          first: replies[0]!.id,
          second: replies[replies.length - 1]!.id,
          human: human.id,
          capabilities: listing.capabilities,
        };
      },
    );
    if (!seeded) throw new Error('seeding failed');
    const { sessionId } = seeded;

    await step('capability: both transcript routes advertise it', async () => {
      assert.deepEqual(seeded.capabilities, { anonymousMessageFeedback: true });
      const page = (await (
        await fetch(
          `${oracle.url}/sessions/${encodeURIComponent(sessionId)}/messages?limit=5`,
          { headers: client.headers() },
        )
      ).json()) as { capabilities?: unknown };
      assert.deepEqual(page.capabilities, { anonymousMessageFeedback: true });
    });

    await step(
      'refusals: 401, 404 on a user message, 422 on an identifier',
      async () => {
        const body = {
          submissionId: randomUUID(),
          feedback: 'Too long-winded.',
          context,
        };
        assert.equal(
          (
            await feedback(sessionId, seeded.first, body, {
              'content-type': 'application/json',
            })
          ).status,
          401,
        );
        assert.equal(
          (await feedback(sessionId, seeded.human, body)).status,
          404,
        );
        assert.equal(
          (
            await feedback(sessionId, seeded.first, {
              ...body,
              feedback: `Write to me at ${alice.matrixUserId}`,
            })
          ).status,
          422,
        );
        assert.equal(linear.calls.length, 0, 'no refusal may reach Linear');
      },
    );

    const text = 'The reply ignored the formatting I asked for.';
    const submissionId = randomUUID();
    const delivered = await step(
      'deliver: one issue with the text and pseudonyms, nothing raw',
      async () => {
        const res = await feedback(sessionId, seeded.first, {
          submissionId,
          feedback: text,
          context,
        });
        assert.equal(res.status, 200, await res.clone().text());
        const answer = (await res.json()) as { submittedAt: string };
        assert.deepEqual(
          linear.calls.map((c) => c.op),
          ['find', 'create'],
        );
        assert.ok(linear.calls.every((c) => c.authorization === LINEAR_KEY));
        assert.equal(linear.issues.length, 1);
        const description = linear.issues[0]!.description;
        assert.ok(description.includes(text));
        assert.match(description, /user_[a-f0-9]{64}/);
        for (const raw of [
          alice.did,
          sessionId,
          seeded.first,
          alice.matrixUserId,
        ])
          assert.ok(!description.includes(raw), `issue leaks ${raw}`);
        return answer;
      },
    );

    await step(
      'duplicate: same answer, no second issue; other feedback is 409',
      async () => {
        const again = await feedback(sessionId, seeded.first, {
          submissionId,
          feedback: text,
          context,
        });
        assert.equal(again.status, 200);
        assert.deepEqual(
          ((await again.json()) as { submittedAt: string }).submittedAt,
          delivered?.submittedAt,
        );
        const other = await feedback(sessionId, seeded.first, {
          submissionId: randomUUID(),
          feedback: 'Something else.',
          context,
        });
        assert.equal(other.status, 409);
        assert.deepEqual(
          ((await other.json()) as { code?: string }).code,
          'FEEDBACK_ALREADY_SUBMITTED',
        );
        assert.equal(linear.issues.length, 1);
        assert.equal(linear.calls.filter((c) => c.op === 'create').length, 1);
      },
    );

    await step(
      'outage: 502 after bounded retries, then a retry succeeds',
      async () => {
        const body = {
          submissionId: randomUUID(),
          feedback: 'The second answer was great.',
          context,
        };
        linear.setDown(true);
        const before = linear.calls.length;
        const failed = await feedback(sessionId, seeded.second, body);
        assert.equal(failed.status, 502);
        assert.deepEqual(
          linear.calls.slice(before).map((c) => c.op),
          ['find', 'create', 'find', 'create', 'find', 'create'],
        );
        linear.setDown(false);
        const retried = await feedback(sessionId, seeded.second, body);
        assert.equal(retried.status, 200);
        assert.equal(linear.issues.length, 2);
      },
    );
  } finally {
    await oracle.stop();
    await linear.stop();
  }

  console.log('\nResults:');
  for (const r of results)
    console.log(
      `  ${r.ok ? '✔' : '✖'} ${r.name} (${r.ms} ms)${r.detail ? ` — ${r.detail}` : ''}`,
    );
  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} passed`);
  if (failed.length > 0) process.exitCode = 1;
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

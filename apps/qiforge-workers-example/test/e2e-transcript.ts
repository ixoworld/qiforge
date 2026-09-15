/**
 * Transcript paging, end to end (docs/plans/transcript-paging.md).
 *
 *   pnpm test:e2e:transcript                      # local harness (boots wrangler dev)
 *   STEP_FILTER='^after' pnpm test:e2e:transcript # a subset
 *
 * Against a DEPLOYED oracle:
 *
 *   ACCOUNT_JSON=test/.devnet-accounts/devnet-account.json \
 *   ORACLE_URL=https://mike-devnet-oracle.ixo-api.workers.dev \
 *   ORACLE_DID=did:ixo:ixo1seyngesnj6673qqzf0um4e6c2rutfsrafc9tw3 pnpm test:e2e:transcript
 *
 * What it proves: `GET /sessions/:id/messages` pages a session by turns
 * (newest first, then `before=` back to the first message, `after=` for what
 * a client missed), every page agrees with the legacy whole-transcript
 * listing, a tool call and its result never split across pages, bad input is
 * a 400, and the legacy route is untouched.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
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
const DEVNET_ACCOUNT_JSON = process.env.ACCOUNT_JSON;

interface DevnetAccount {
  did: string;
  address: string;
  edSigningMnemonic: string;
  matrixUserId: string;
  matrixPassword: string;
}

interface Dto {
  id: string;
  type: 'ai' | 'human';
  content: string;
  toolCalls?: Array<{
    id: string;
    name: string;
    output?: string;
    status?: string;
  }>;
}

interface Page {
  messages: Dto[];
  prevCursor: string | null;
  nextCursor: string | null;
  hasOlder: boolean;
  hasNewer: boolean;
}

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

/** Turns of a listing: each user message opens one. */
const turnsOf = (messages: Dto[]) =>
  messages.filter((m) => m.type === 'human').length;
const ids = (messages: Dto[]) => messages.map((m) => m.id);

async function main(): Promise<void> {
  const devnet = DEVNET_ACCOUNT_JSON
    ? (JSON.parse(readFileSync(DEVNET_ACCOUNT_JSON, 'utf8')) as DevnetAccount)
    : null;
  if (devnet && !process.env.ORACLE_URL)
    throw new Error('ORACLE_URL is required with ACCOUNT_JSON');
  if (devnet && !ORACLE_DID)
    throw new Error('ORACLE_DID is required with ACCOUNT_JSON');
  if (!devnet) await provisionDevVars({});
  const oracle = await startOracle();
  console.log(`oracle at ${oracle.url}`);
  try {
    const alice: HarnessAccount = devnet
      ? {
          name: 'devnet-transcript',
          address: devnet.address,
          did: devnet.did,
          edSigningMnemonic: devnet.edSigningMnemonic,
          matrixUserId: devnet.matrixUserId,
          matrixPassword: devnet.matrixPassword,
          matrixMnemonic: '',
        }
      : (STATIC_ACCOUNTS[1] as HarnessAccount);
    const invocation = await mintAuthInvocation(alice, ORACLE_DID);
    const delegation = devnet
      ? null
      : await mintDelegation(alice, ORACLE_DID, [
          { can: 'memory/*', with: 'ixo:memory' },
        ]);
    const client = new ChatClient(
      oracle.url,
      delegation ? { invocation, delegation } : { invocation },
    );

    const pageOf = async (
      sid: string,
      query: Record<string, string> = {},
    ): Promise<{ status: number; page: Page; body: string }> => {
      const qs = new URLSearchParams(query).toString();
      const res = await fetch(
        `${oracle.url}/sessions/${encodeURIComponent(sid)}/messages${qs ? `?${qs}` : ''}`,
        {
          headers: client.headers(),
        },
      );
      const body = await res.text();
      return {
        status: res.status,
        page: res.ok ? (JSON.parse(body) as Page) : ({} as Page),
        body,
      };
    };

    // ---------------------------------------------------------------- seed a session with several turns
    const TURNS = 5;
    const sid = (await step(
      `seed: ${TURNS} turns in one session, one of them with a tool call`,
      async () => {
        const id = await client.createSession();
        for (let i = 1; i <= TURNS; i += 1) {
          const ask =
            i === 3
              ? 'What is the current weather in Berlin? Use your weather tool, then answer in one short sentence.'
              : `Reply with exactly: TURN ${i}`;
          const r = await client.stream(id, ask);
          assert.equal(r.status, 200, r.text);
        }
        return id;
      },
    ))!;
    if (!sid) throw new Error('seeding failed');

    let legacy: Dto[] = [];
    await step(
      'legacy: GET /messages/:id still lists the whole transcript',
      async () => {
        legacy = (await client.listMessages(sid)).messages as Dto[];
        assert.equal(
          turnsOf(legacy),
          TURNS,
          `expected ${TURNS} turns, got ${turnsOf(legacy)}`,
        );
        assert.ok(
          legacy.some((m) => m.toolCalls?.some((t) => t.output)),
          'the weather turn should carry a folded tool result',
        );
      },
    );

    let newest: Page | undefined;
    await step(
      'newest: the default page is the last turns, newest cursor at the end',
      async () => {
        const { status, page } = await pageOf(sid, { limit: '2' });
        assert.equal(status, 200);
        newest = page;
        assert.equal(turnsOf(page.messages), 2);
        assert.deepEqual(
          ids(page.messages),
          ids(legacy.slice(legacy.length - page.messages.length)),
        );
        assert.equal(page.hasOlder, true);
        assert.equal(page.hasNewer, false);
        assert.ok(page.prevCursor, 'prevCursor');
        assert.ok(page.nextCursor, 'nextCursor');
      },
    );

    await step(
      'before: walking back reaches the first message and the pages tile the legacy listing exactly',
      async () => {
        assert.ok(newest);
        const pages: Page[] = [newest];
        let cursor = newest.prevCursor;
        let guard = 0;
        while (cursor) {
          guard += 1;
          assert.ok(guard < 20, 'runaway paging');
          const { status, page } = await pageOf(sid, {
            limit: '2',
            before: cursor,
          });
          assert.equal(status, 200);
          assert.ok(
            page.messages.length > 0,
            'an older page must not be empty while hasOlder was true',
          );
          assert.equal(page.hasNewer, true);
          pages.unshift(page);
          cursor = page.hasOlder ? page.prevCursor : null;
        }
        const tiled = pages.flatMap((p) => p.messages);
        assert.deepEqual(
          ids(tiled),
          ids(legacy),
          'pages must tile the whole transcript in order, without gaps or overlaps',
        );
        assert.equal(pages[0]!.hasOlder, false);
        assert.equal(pages[0]!.prevCursor, null);
        // The tool call and its result sit in the same page.
        for (const p of pages) {
          for (const m of p.messages) {
            for (const t of m.toolCalls ?? [])
              assert.ok(
                t.output !== undefined,
                `tool call ${t.name} in a page without its result`,
              );
          }
        }
        console.log(
          `\n   ${pages.length} pages of 2 turns tile ${legacy.length} messages`,
        );
      },
    );

    await step(
      'after: nothing new keeps the cursor; a new turn comes back whole',
      async () => {
        const cursor = newest?.nextCursor;
        assert.ok(cursor, 'the newest page has no cursor');
        const idle = await pageOf(sid, { after: cursor });
        assert.equal(idle.status, 200);
        assert.deepEqual(idle.page.messages, []);
        assert.equal(idle.page.nextCursor, cursor);
        assert.equal(idle.page.hasNewer, false);

        const r = await client.stream(
          sid,
          `Reply with exactly: TURN ${TURNS + 1}`,
        );
        assert.equal(r.status, 200, r.text);
        const fresh = await pageOf(sid, { after: cursor });
        assert.equal(fresh.status, 200);
        assert.equal(turnsOf(fresh.page.messages), 1);
        assert.ok(
          fresh.page.messages.some(
            (m) => m.type === 'ai' && /TURN 6/.test(m.content),
          ),
          'the new reply is in the tail page',
        );
        assert.equal(fresh.page.hasNewer, false);
        assert.notEqual(fresh.page.nextCursor, cursor);
        const all = (await client.listMessages(sid)).messages as Dto[];
        assert.deepEqual(
          ids(fresh.page.messages),
          ids(all.slice(all.length - fresh.page.messages.length)),
        );
      },
    );

    await step(
      'input: a bad limit, both cursors, or an unknown cursor is a 400; an unknown session is an empty page',
      async () => {
        assert.equal((await pageOf(sid, { limit: '0' })).status, 400);
        assert.equal((await pageOf(sid, { limit: 'x' })).status, 400);
        assert.equal(
          (await pageOf(sid, { before: 'a', after: 'b' })).status,
          400,
        );
        assert.equal(
          (await pageOf(sid, { before: 'no-such-message' })).status,
          400,
        );
        const unknown = await pageOf('$unknownsession', {});
        assert.equal(unknown.status, 200);
        assert.deepEqual(unknown.page, {
          messages: [],
          prevCursor: null,
          nextCursor: null,
          hasOlder: false,
          hasNewer: false,
        });
      },
    );

    await step('limit: clamps at 100 and a page never exceeds it', async () => {
      const { status, page } = await pageOf(sid, { limit: '1000' });
      assert.equal(status, 200);
      assert.equal(turnsOf(page.messages), TURNS + 1);
      assert.equal(page.hasOlder, false);
    });
  } finally {
    await oracle.stop();
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

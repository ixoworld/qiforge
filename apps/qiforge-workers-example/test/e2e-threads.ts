/**
 * Room threads are sessions, end to end — the Node runtime's rule, ported
 * (`src/matrix/ingest.ts`, `src/matrix/reply-chain.ts`).
 *
 *   pnpm test:e2e:threads                        # local harness (boots wrangler dev)
 *   STEP_FILTER='^quote' pnpm test:e2e:threads   # a subset
 *
 * Against a DEPLOYED oracle, with the account's own Matrix login and room:
 *
 *   ACCOUNT_JSON=test/.devnet-accounts/devnet-account.json \
 *   ORACLE_URL=https://mike-devnet-oracle.ixo-api.workers.dev \
 *   ORACLE_DID=did:ixo:ixo1seyngesnj6673qqzf0um4e6c2rutfsrafc9tw3 pnpm test:e2e:threads
 *
 *   (`MATRIX_URL` defaults to https://<the account's homeserver>;
 *    `BOT_MATRIX_USER_ID` to the oracle DID's user on that homeserver.)
 *
 * What it proves: a bare room message opens a thread and is answered inside
 * it; that thread is a session whose id is the message's event id, listed by
 * `GET /sessions` and readable through the transcript route; a reply inside
 * the thread and a quote-reply to the bot's answer continue that session; a
 * new bare message is a new session with its own transcript; an HTTP turn on
 * a room-born session is mirrored into its thread; and a reply typed inside a
 * Portal session's thread continues the Portal session.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { ChatClient } from './lib/chat-client';
import {
  type HarnessAccount,
  MATRIX_BASE_URL,
  matrixLogin,
  mintAuthInvocation,
  mintDelegation,
  STATIC_ACCOUNTS,
  waitFor,
} from './lib/harness';
import {
  createE2eeClient,
  type E2eeClient,
  loginWithPassword,
  type MatrixLogin,
} from './lib/matrix-client';
import {
  didToAliasPart,
  ensureUserOracleRoom,
  grantPowerLevel,
  waitForMember,
} from './lib/matrix-room';
import {
  BOT_USER_ID,
  ORACLE_DID,
  provisionDevVars,
  startOracle,
  waitForMatrixGateway,
} from './lib/oracle';

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
  /** The account's user↔oracle room with the deployed oracle. */
  roomId?: string;
}

interface Dto {
  id: string;
  type: 'ai' | 'human';
  content: string;
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

const serverOf = (matrixUserId: string) =>
  matrixUserId.slice(matrixUserId.indexOf(':') + 1);
const pause = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function main(): Promise<void> {
  const devnet = DEVNET_ACCOUNT_JSON
    ? (JSON.parse(readFileSync(DEVNET_ACCOUNT_JSON, 'utf8')) as DevnetAccount)
    : null;
  if (devnet && !process.env.ORACLE_URL)
    throw new Error('ORACLE_URL is required with ACCOUNT_JSON');
  if (devnet && !ORACLE_DID)
    throw new Error('ORACLE_DID is required with ACCOUNT_JSON');
  if (devnet && !devnet.roomId)
    throw new Error('the account file has no roomId (its user↔oracle room)');
  if (!devnet) await provisionDevVars({});
  const oracle = await startOracle();
  console.log(`oracle at ${oracle.url}`);

  const user: HarnessAccount = devnet
    ? {
        name: 'devnet-threads',
        address: devnet.address,
        did: devnet.did,
        edSigningMnemonic: devnet.edSigningMnemonic,
        matrixUserId: devnet.matrixUserId,
        matrixPassword: devnet.matrixPassword,
        matrixMnemonic: '',
      }
    : (STATIC_ACCOUNTS[1] as HarnessAccount);
  const matrixUrl = devnet
    ? (process.env.MATRIX_URL ?? `https://${serverOf(devnet.matrixUserId)}`)
    : MATRIX_BASE_URL;
  const botUserId = devnet
    ? (process.env.BOT_MATRIX_USER_ID ??
      `@${didToAliasPart(ORACLE_DID)}:${serverOf(devnet.matrixUserId)}`)
    : BOT_USER_ID;

  let e2ee: E2eeClient | undefined;
  try {
    const invocation = await mintAuthInvocation(user, ORACLE_DID);
    const delegation = devnet
      ? null
      : await mintDelegation(user, ORACLE_DID, [
          { can: 'memory/*', with: 'ixo:memory' },
        ]);
    const client = new ChatClient(
      oracle.url,
      delegation ? { invocation, delegation } : { invocation },
    );

    // ---------------------------------------------------------------- the user's oracle room
    let login: MatrixLogin;
    let roomId: string;
    if (devnet) {
      login = await loginWithPassword(
        matrixUrl,
        devnet.matrixUserId,
        devnet.matrixPassword,
      );
      roomId = devnet.roomId!;
    } else {
      const session = await matrixLogin(user.matrixUserId, user.matrixPassword);
      login = session;
      roomId = await ensureUserOracleRoom({
        session,
        userDid: user.did,
        oracleDid: ORACLE_DID,
        botUserId,
        roomName: 'threads drill ↔ QiForge Workers',
      });
      await waitForMatrixGateway(oracle.url);
      await waitForMember(session, roomId, botUserId);
      await grantPowerLevel(session, roomId, botUserId, 50);
    }
    e2ee = await createE2eeClient(matrixUrl, login);
    const mx = e2ee;
    console.log(`room ${roomId}, bot ${botUserId}`);

    const listedIds = async (): Promise<string[]> => {
      const body = (await client.listSessions()) as {
        sessions?: Array<{ sessionId: string }>;
      };
      return (body.sessions ?? []).map((s) => s.sessionId);
    };
    const transcript = async (sid: string): Promise<Dto[]> =>
      (await client.listMessages(sid)).messages as Dto[];
    const humanTexts = (messages: Dto[]) =>
      messages.filter((m) => m.type === 'human').map((m) => m.content);

    // ---------------------------------------------------------------- a bare message opens a thread
    let rootId = '';
    let answerId = '';
    await step(
      'bare: a room message is answered inside a thread rooted at the message',
      async () => {
        const since = Date.now();
        rootId = await mx.send(
          roomId,
          'What is 6 times 7? Reply with only the number.',
        );
        const reply = await mx.waitForBotMessage(
          roomId,
          botUserId,
          since,
          /42/,
        );
        assert.equal(
          reply.threadRootId,
          rootId,
          `reply not threaded on the message: ${JSON.stringify(reply.relatesTo)}`,
        );
        answerId = reply.eventId;
      },
    );
    if (!rootId) throw new Error('no thread to continue');

    await step(
      'session: the thread is a session with the root event id, listed and with the turn in its transcript',
      async () => {
        await waitFor(
          async () => (await listedIds()).includes(rootId),
          30_000,
          `session ${rootId} in GET /sessions`,
          1_000,
        );
        const messages = await transcript(rootId);
        assert.ok(
          messages.length >= 2,
          `expected the turn in the transcript, got ${messages.length}`,
        );
        assert.ok(
          humanTexts(messages).some((t) => /6 times 7/.test(t)),
          `user message missing: ${JSON.stringify(humanTexts(messages))}`,
        );
        assert.ok(
          messages.some((m) => m.type === 'ai' && /42/.test(m.content)),
          'reply missing from the transcript',
        );
      },
    );

    await step(
      'thread: a reply inside the thread continues the session (the model remembers the turn)',
      async () => {
        const since = Date.now();
        await mx.sendInThread(
          roomId,
          rootId,
          'And what did I just ask you to multiply? Reply with only the two numbers.',
        );
        const reply = await mx.waitForBotMessage(
          roomId,
          botUserId,
          since,
          /6.*7|7.*6/,
        );
        assert.equal(reply.threadRootId, rootId, 'reply left the thread');
        const messages = await transcript(rootId);
        assert.ok(
          messages.length >= 4,
          `expected two turns in the transcript, got ${messages.length}`,
        );
      },
    );

    await step(
      "quote: a quote-reply to the bot's answer (no m.thread relation) lands in the same thread and session",
      async () => {
        assert.ok(answerId, 'no bot answer to quote');
        const since = Date.now();
        await mx.quoteReply(
          roomId,
          answerId,
          'Add the two numbers I asked you to multiply. Reply with only the sum.',
        );
        const reply = await mx.waitForBotMessage(
          roomId,
          botUserId,
          since,
          /13/,
        );
        assert.equal(
          reply.threadRootId,
          rootId,
          'quote-reply opened a new thread',
        );
        const messages = await transcript(rootId);
        assert.ok(
          messages.length >= 6,
          `expected three turns in the transcript, got ${messages.length}`,
        );
      },
    );

    await step(
      'new: another bare message is a new thread and a new session with its own transcript',
      async () => {
        const since = Date.now();
        const newId = await mx.send(
          roomId,
          'Reply with exactly the word SEPARATE.',
        );
        const reply = await mx.waitForBotMessage(
          roomId,
          botUserId,
          since,
          /SEPARATE/,
        );
        assert.equal(
          reply.threadRootId,
          newId,
          'reply not threaded on the new message',
        );
        assert.notEqual(newId, rootId);
        await waitFor(
          async () => (await listedIds()).includes(newId),
          30_000,
          `session ${newId} in GET /sessions`,
          1_000,
        );
        const ids = await listedIds();
        assert.ok(ids.includes(rootId), 'the first thread is still listed');
        const messages = await transcript(newId);
        assert.equal(
          messages.length,
          2,
          `a fresh session holds one turn, got ${messages.length}`,
        );
        assert.ok(
          !humanTexts(messages).some((t) => /multiply/.test(t)),
          'the new session leaked the other thread',
        );
        for (const id of [rootId, newId])
          assert.ok(id.startsWith('$'), `session id is not an event id: ${id}`);
      },
    );

    await step(
      'http: a turn sent over HTTP on a room-born session is mirrored into its thread',
      async () => {
        const marker = `MIRROR-${Math.random().toString(36).slice(2, 8).toUpperCase()}`;
        const r = await client.stream(
          rootId,
          `Reply with exactly ${marker} and nothing else.`,
        );
        assert.equal(r.status, 200, r.text);
        assert.match(r.text, new RegExp(marker));
        await waitFor(
          async () => {
            const bodies = await mx.threadBodies(roomId, botUserId, rootId);
            return (
              bodies.some(
                (b) => /\*\*You:\*\*/.test(b) && b.includes(marker),
              ) &&
              bodies.some((b) => !/\*\*You:\*\*/.test(b) && b.includes(marker))
            );
          },
          90_000,
          `both mirrors of the HTTP turn under ${rootId}`,
          2_000,
        );
      },
    );

    await step(
      "portal: a reply typed inside a Portal session's thread continues the Portal session",
      async () => {
        const sid = await client.createSession();
        assert.ok(sid.startsWith('$'), `session has no marker event: ${sid}`);
        const r = await client.stream(
          sid,
          'The code word is PINEAPPLE. Remember it and reply with exactly OK.',
        );
        assert.equal(r.status, 200, r.text);
        // The turn's mirrors land in the marker's thread first, so alice's
        // reply follows them in the thread the Portal user sees.
        await waitFor(
          async () =>
            (await mx.threadBodies(roomId, botUserId, sid)).length >= 2,
          90_000,
          `the HTTP turn mirrored under ${sid}`,
          2_000,
        );
        const since = Date.now();
        await mx.sendInThread(
          roomId,
          sid,
          'What is the code word? Reply with only the word.',
        );
        const reply = await mx.waitForBotMessage(
          roomId,
          botUserId,
          since,
          /PINEAPPLE/i,
        );
        assert.equal(reply.threadRootId, sid, 'reply left the Portal thread');
        const messages = await transcript(sid);
        assert.ok(
          humanTexts(messages).some((t) => /code word\?/.test(t)),
          `the room turn is not in the Portal session: ${JSON.stringify(humanTexts(messages))}`,
        );
        // Nothing was minted for the room turn: the thread IS the session.
        await pause(1_000);
        const ids = await listedIds();
        assert.ok(ids.includes(sid));
        assert.ok(
          !ids.some(
            (id) => id.startsWith('thread:') || id.startsWith('matrix:'),
          ),
          `legacy session ids in the list: ${ids.filter((id) => /^(thread|matrix):/.test(id)).join(', ')}`,
        );
      },
    );
  } finally {
    e2ee?.stop();
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

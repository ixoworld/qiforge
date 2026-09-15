/**
 * Matrix group rooms, end to end — the Node runtime's group-chat lane, ported
 * (`src/matrix/group-chat.ts`, `plugins/matrix-group-chats`).
 *
 *   pnpm test:e2e:group                         # local harness (boots wrangler dev)
 *   STEP_FILTER='^mention' pnpm test:e2e:group  # a subset
 *   GROUP_ROOMS=silent pnpm test:e2e:group      # the default policy: the bot never speaks there
 *
 * Locally the drill boots the oracle with `MATRIX_GROUP_ROOMS=gate` (the Node
 * lane) unless `GROUP_ROOMS=silent`, which boots the default and proves the
 * bot says nothing in a group room. Against a deployment the drill follows
 * the deployment's policy: pass `GROUP_ROOMS=silent` when the gateway runs
 * the default.
 *
 * Against a DEPLOYED oracle, with two accounts' Matrix logins (the second is
 * a passive member: it chats, it is never answered unless `MEMBER_CHATS=1`):
 *
 *   ACCOUNT_JSON=test/.devnet-accounts/devnet-account.json \
 *   MEMBER_JSON=test/.devnet-accounts/devnet-user-7.json \
 *   ORACLE_URL=https://mike-devnet-oracle.ixo-api.workers.dev \
 *   ORACLE_DID=did:ixo:ixo1seyngesnj6673qqzf0um4e6c2rutfsrafc9tw3 pnpm test:e2e:group
 *
 * What it proves, in a fresh E2EE room with two people and the bot: the bot
 * joins its invite; a message that does not mention it gets no reply; a
 * message that mentions it is answered inside a thread and the stored
 * message carries the `[DisplayName]: ` prefix; a follow-up in that thread
 * without a mention is answered (active thread); a quote-reply to the bot's
 * answer from the other member is answered; a bare message from the other
 * member is not; the channel-memory tools pin and recall a fact; the
 * messages nobody answered are compacted into a summary the bot can search.
 * The room is left (the bot kicked) at the end.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { MsgType } from 'matrix-js-sdk';
import { ChatClient } from './lib/chat-client';
import {
  type HarnessAccount,
  MATRIX_BASE_URL,
  mintAuthInvocation,
  mintDelegation,
  STATIC_ACCOUNTS,
  waitFor,
} from './lib/harness';
import {
  createE2eeClient,
  type E2eeClient,
  loginWithPassword,
} from './lib/matrix-client';
import { didToAliasPart } from './lib/matrix-room';
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
const MEMBER_JSON = process.env.MEMBER_JSON;
const SILENT = process.env.GROUP_ROOMS === 'silent';

interface AccountFile {
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
const tag = () => Math.random().toString(36).slice(2, 8).toUpperCase();

function accountOf(file: AccountFile, name: string): HarnessAccount {
  return {
    name,
    address: file.address,
    did: file.did,
    edSigningMnemonic: file.edSigningMnemonic,
    matrixUserId: file.matrixUserId,
    matrixPassword: file.matrixPassword,
    matrixMnemonic: '',
  };
}

async function main(): Promise<void> {
  const devnet = DEVNET_ACCOUNT_JSON
    ? (JSON.parse(readFileSync(DEVNET_ACCOUNT_JSON, 'utf8')) as AccountFile)
    : null;
  if (devnet && !process.env.ORACLE_URL)
    throw new Error('ORACLE_URL is required with ACCOUNT_JSON');
  if (devnet && !ORACLE_DID)
    throw new Error('ORACLE_DID is required with ACCOUNT_JSON');
  if (devnet && !MEMBER_JSON)
    throw new Error(
      'MEMBER_JSON (a second account) is required with ACCOUNT_JSON',
    );
  if (!devnet)
    await provisionDevVars({
      extra: { MATRIX_GROUP_ROOMS: SILENT ? 'silent' : 'gate' },
    });
  const oracle = await startOracle();
  console.log(`oracle at ${oracle.url}`);

  const alice = devnet
    ? accountOf(devnet, 'devnet-group-alice')
    : (STATIC_ACCOUNTS[1] as HarnessAccount);
  const bob = devnet
    ? accountOf(
        JSON.parse(readFileSync(MEMBER_JSON!, 'utf8')) as AccountFile,
        'devnet-group-bob',
      )
    : (STATIC_ACCOUNTS[2] as HarnessAccount);
  // The second member's own turns need a user object that can boot; on a
  // deployment that means a delegation, which a passive member may not have.
  const memberChats = !devnet || process.env.MEMBER_CHATS === '1';
  const matrixUrl = devnet
    ? (process.env.MATRIX_URL ?? `https://${serverOf(alice.matrixUserId)}`)
    : MATRIX_BASE_URL;
  const botUserId = devnet
    ? (process.env.BOT_MATRIX_USER_ID ??
      `@${didToAliasPart(ORACLE_DID)}:${serverOf(alice.matrixUserId)}`)
    : BOT_USER_ID;

  let mxA: E2eeClient | undefined;
  let mxB: E2eeClient | undefined;
  let roomId = '';
  try {
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
    if (!devnet) await waitForMatrixGateway(oracle.url);

    const loginA = await loginWithPassword(
      matrixUrl,
      alice.matrixUserId,
      alice.matrixPassword,
    );
    const loginB = await loginWithPassword(
      matrixUrl,
      bob.matrixUserId,
      bob.matrixPassword,
    );
    mxA = await createE2eeClient(matrixUrl, loginA);
    mxB = await createE2eeClient(matrixUrl, loginB);
    const a = mxA;
    const b = mxB;
    // Display names: the bot addresses people by them (`[Alice]: …`).
    await a.mx.setDisplayName('Alice').catch(() => undefined);
    await b.mx.setDisplayName('Bob').catch(() => undefined);

    const transcript = async (sid: string): Promise<Dto[]> =>
      (await client.listMessages(sid)).messages as Dto[];
    const botMessagesSince = async (since: number) => {
      const room = a.mx.getRoom(roomId);
      const out: Array<{ body: string; threadRootId?: string }> = [];
      for (const e of room?.getLiveTimeline().getEvents() ?? []) {
        if (e.getSender() !== botUserId || e.getTs() < since) continue;
        await a.mx.decryptEventIfNeeded(e);
        if (e.getType() !== 'm.room.message') continue;
        out.push({
          body: String(e.getContent().body ?? ''),
          ...(e.threadRootId ? { threadRootId: e.threadRootId } : {}),
        });
      }
      return out;
    };
    const gatewayStatus = async () => {
      const status: {
        groupChat?: { buffered: number; chunks: number; facts: number };
      } = await (await fetch(`${oracle.url}/matrix/status`)).json();
      return status;
    };
    const mention = (text: string) =>
      a.mx.sendMessage(roomId, {
        msgtype: MsgType.Text,
        body: `${botUserId} ${text}`,
        'm.mentions': { user_ids: [botUserId] },
      });

    // ---------------------------------------------------------------- the room
    await step(
      'room: alice creates an E2EE room with bob and the bot; the bot joins',
      async () => {
        const res = await a.mx.createRoom({
          name: `Group drill ${tag()}`,
          invite: [bob.matrixUserId, botUserId],
          initial_state: [
            {
              type: 'm.room.encryption',
              state_key: '',
              content: { algorithm: 'm.megolm.v1.aes-sha2' },
            },
          ],
        });
        roomId = res.room_id;
        await b.mx.joinRoom(roomId);
        await waitFor(
          async () => {
            const room = a.mx.getRoom(roomId);
            const joined = room?.getJoinedMembers().map((m) => m.userId) ?? [];
            return (
              joined.includes(botUserId) && joined.includes(bob.matrixUserId)
            );
          },
          60_000,
          'the bot and bob joined',
          1_000,
        );
        const room = a.mx.getRoom(roomId);
        assert.equal(room?.getJoinedMemberCount(), 3);
      },
    );
    if (!roomId) throw new Error('no room');

    if (SILENT) {
      await step(
        'silent (default policy): a mention, a bare message and a quote-reply get no reply and capture nothing',
        async () => {
          const before = (await gatewayStatus()).groupChat;
          assert.ok(before, 'the gateway status has no groupChat block');
          const since = Date.now();
          const sent = await mention(
            'Reply with exactly the word GROUPPONG and nothing else.',
          );
          await a.send(roomId, 'Bob, what do you think about the kiwi budget?');
          await b.quoteReply(
            roomId,
            sent.event_id,
            'And you, bot? Reply with exactly BOBPONG.',
          );
          await pause(25_000);
          assert.deepEqual(await botMessagesSince(since), []);
          const after = (await gatewayStatus()).groupChat;
          assert.deepEqual(
            after,
            before,
            'the silent policy captured something',
          );
        },
      );
      await step('silent: no bot message at all in the room', async () => {
        assert.deepEqual(await botMessagesSince(0), []);
      });
    } else {
      await step(
        'ignored: a message that does not mention the bot gets no reply',
        async () => {
          const since = Date.now();
          await a.send(roomId, 'Bob, what do you think about the kiwi budget?');
          await pause(20_000);
          assert.deepEqual(await botMessagesSince(since), []);
        },
      );

      let rootId = '';
      let answerId = '';
      await step(
        'mention: a message mentioning the bot is answered in its thread, with the speaker prefix stored',
        async () => {
          const since = Date.now();
          const sent = await mention(
            'Reply with exactly the word GROUPPONG and nothing else.',
          );
          rootId = sent.event_id;
          const reply = await a.waitForBotMessage(
            roomId,
            botUserId,
            since,
            /GROUPPONG/,
          );
          assert.equal(
            reply.threadRootId,
            rootId,
            'reply not threaded on the mention',
          );
          answerId = reply.eventId;
          const messages = await transcript(rootId);
          const human = messages.find((m) => m.type === 'human');
          assert.ok(human, 'no human message in the thread session');
          assert.match(
            human.content,
            /^\[Alice\]: /,
            `no speaker prefix: ${human.content.slice(0, 60)}`,
          );
          assert.match(
            human.content,
            /USER MENTIONED YOU @AI_AGENT/,
            'the bot id was not rewritten',
          );
        },
      );
      if (!rootId) throw new Error('no thread');

      await step(
        'active thread: a follow-up in the thread without a mention is answered',
        async () => {
          const since = Date.now();
          await a.sendInThread(
            roomId,
            rootId,
            'What word did I just ask you for? Reply with only the word.',
          );
          const reply = await a.waitForBotMessage(
            roomId,
            botUserId,
            since,
            /GROUPPONG/,
          );
          assert.equal(reply.threadRootId, rootId);
        },
      );

      if (memberChats)
        await step(
          "reply-to-bot: bob quote-replies the bot's answer (no thread relation) and is answered",
          async () => {
            const since = Date.now();
            await b.quoteReply(
              roomId,
              answerId,
              'Reply with exactly the word BOBPONG and nothing else.',
            );
            const reply = await b.waitForBotMessage(
              roomId,
              botUserId,
              since,
              /BOBPONG/,
            );
            assert.equal(
              reply.threadRootId,
              rootId,
              'the quote-reply left the thread',
            );
          },
        );

      await step(
        "silence: bob's bare messages are not answered but are captured",
        async () => {
          const before = (await gatewayStatus()).groupChat;
          assert.ok(before, 'the gateway status has no groupChat block');
          const since = Date.now();
          for (const line of [
            'We should buy 12 kiwis for the party.',
            'The kiwis come from the farm on Elm Street.',
            'Kiwi budget is 30 dollars, agreed?',
            'Alice can you pick the kiwis up on Thursday?',
            'Also we need paper plates.',
          ]) {
            await b.send(roomId, line);
            await pause(1_500);
          }
          await pause(12_000);
          assert.deepEqual(await botMessagesSince(since), []);
          const after = (await gatewayStatus()).groupChat!;
          assert.ok(
            after.buffered + after.chunks > before.buffered + before.chunks ||
              after.buffered >= 5,
            `nothing captured: ${JSON.stringify({ before, after })}`,
          );
        },
      );

      await step('tools: the bot pins a fact and recalls it', async () => {
        const since = Date.now();
        await mention(
          "Use the pin_room_fact tool to save exactly this fact: 'The launch is on Friday.' Then reply with exactly PINNED.",
        );
        const reply = await a.waitForBotMessage(
          roomId,
          botUserId,
          since,
          /PINNED/i,
        );
        const since2 = Date.now();
        await a.sendInThread(
          roomId,
          reply.threadRootId ?? '',
          'Use the recall_channel_memory tool and tell me the pinned facts word for word.',
        );
        const recalled = await a.waitForBotMessage(
          roomId,
          botUserId,
          since2,
          /Friday/i,
        );
        assert.match(recalled.body, /Friday/i);
        const status = (await gatewayStatus()).groupChat!;
        assert.ok(status.facts >= 1, JSON.stringify(status));
      });

      await step(
        'memory: the messages nobody answered were compacted and are searchable',
        async () => {
          // The bot's previous answers compacted the buffer just in time; wait
          // for the chunk to land (the summary is a model call).
          await waitFor(
            async () => ((await gatewayStatus()).groupChat?.chunks ?? 0) >= 1,
            120_000,
            'a channel-memory chunk',
            2_000,
          );
          const since = Date.now();
          await mention(
            "Use the search_channel_memory tool with the query 'kiwis' and tell me how many kiwis we should buy for the party. Reply with only the number.",
          );
          const reply = await a.waitForBotMessage(
            roomId,
            botUserId,
            since,
            /12/,
          );
          assert.match(reply.body, /12/);
        },
      );

      await step(
        'threads only: every bot message in the room is inside a thread',
        async () => {
          const all = await botMessagesSince(0);
          assert.ok(
            all.length >= 4,
            `expected several bot messages, got ${all.length}`,
          );
          const bare = all.filter((m) => !m.threadRootId);
          assert.deepEqual(bare, []);
        },
      );
    }
  } finally {
    if (roomId && mxA) {
      // Leave the room clean: kick the bot so it does not accumulate rooms.
      await mxA.mx
        .kick(roomId, botUserId, 'drill finished')
        .catch(() => undefined);
      await mxA.mx.leave(roomId).catch(() => undefined);
      await mxB?.mx.leave(roomId).catch(() => undefined);
    }
    mxA?.stop();
    mxB?.stop();
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

/**
 * End-to-end test of the Workers oracle against the local ixo harness.
 *
 *   pnpm test:e2e            # boots wrangler dev itself
 *   ORACLE_URL=http://127.0.0.1:8787 pnpm test:e2e   # attach to a running one
 *
 * Proves, with a real LLM (OpenRouter), a real Synapse (E2EE rooms) and real
 * UCAN auth against Blocksync:
 *   1. HTTP: UCAN-authenticated session + streaming turn + tool call + memory
 *      continuity across turns + transcript listing + abort.
 *   2. Storage: the working copy exports to the user's Matrix room as media,
 *      survives a working-copy reset (re-import), and the transcript is intact.
 *   3. Matrix: a user in an END-TO-END ENCRYPTED room talks to the bot and gets
 *      an encrypted reply from the SAME device across gateway restarts.
 */
import assert from 'node:assert/strict';
import { ChatClient } from './lib/chat-client';
import {
  APPSERVICE_BOT,
  MATRIX_BASE_URL,
  MATRIX_SERVER_NAME,
  STATIC_ACCOUNTS,
  appserviceRequest,
  matrixLogin,
  matrixRequest,
  mintAuthInvocation,
  mintDelegation,
  waitFor,
  type HarnessAccount,
} from './lib/harness';
import {
  BOT_USER_ID,
  ORACLE_DID,
  provisionDevVars,
  startOracle,
  waitForMatrixGateway,
} from './lib/oracle';

const results: Array<{
  name: string;
  ok: boolean;
  ms: number;
  detail?: string;
}> = [];
async function step<T>(name: string, fn: () => Promise<T>): Promise<T> {
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
    throw err;
  }
}

function didToAliasPart(did: string): string {
  return did.replace(/:/g, '-');
}

async function main(): Promise<void> {
  await provisionDevVars();
  const oracle = await startOracle();
  console.log(`oracle at ${oracle.url}`);
  try {
    const alice = STATIC_ACCOUNTS[1] as HarnessAccount;
    const invocation = await mintAuthInvocation(alice, ORACLE_DID);
    const delegation = await mintDelegation(alice, ORACLE_DID, [
      { can: 'memory/*', with: 'ixo:memory' },
    ]);
    const client = new ChatClient(oracle.url, { invocation, delegation });

    // ------------------------------------------------------------------ auth
    await step('unauthenticated request is rejected with 401', async () => {
      const res = await fetch(`${oracle.url}/sessions`, { method: 'POST' });
      assert.equal(res.status, 401);
    });
    await step('bad invocation is rejected with 401', async () => {
      const res = await fetch(`${oracle.url}/sessions`, {
        method: 'POST',
        headers: { authorization: 'Bearer not-a-ucan', 'x-auth-type': 'ucan' },
      });
      assert.equal(res.status, 401);
    });

    // ------------------------------------------------------------------ http chat
    const sessionId = await step('POST /sessions creates a session', () =>
      client.createSession(),
    );
    await step(
      'streaming turn answers a question (SSE: message + done)',
      async () => {
        const r = await client.stream(
          sessionId,
          'What is 17 + 25? Reply with only the number.',
        );
        assert.equal(r.status, 200, `status ${r.status}: ${r.text}`);
        assert.ok(r.requestId, 'x-request-id header');
        assert.ok(
          r.events.some((e) => e.event === 'message'),
          `no message events: ${JSON.stringify(r.events.slice(0, 5))}`,
        );
        assert.ok(
          r.events.at(-1)?.event === 'done',
          `last event ${r.events.at(-1)?.event}`,
        );
        assert.match(r.text, /42/, `expected 42 in "${r.text}"`);
      },
    );
    await step(
      'tool call is executed and surfaced (weather plugin)',
      async () => {
        const r = await client.stream(
          sessionId,
          'Use your weather tool to get the current temperature in Berlin and tell me the number in °C.',
        );
        assert.equal(r.status, 200, r.text);
        const tools = r.events.filter((e) => e.event === 'tool_call');
        assert.ok(
          tools.length >= 2,
          `expected isRunning+done tool_call events, got ${tools.length}: ${JSON.stringify(tools)}`,
        );
        assert.ok(
          tools.some((e) => e.data.status === 'done'),
          'tool_call done',
        );
        assert.match(r.text, /-?\d+(\.\d+)?/, `no temperature in "${r.text}"`);
      },
    );
    await step('memory continuity across turns (same thread)', async () => {
      const r = await client.stream(
        sessionId,
        'What was the sum I asked you to compute earlier in this conversation? Reply with only the number.',
      );
      assert.match(r.text, /42/, `expected 42 in "${r.text}"`);
    });
    await step(
      'GET /messages returns the transcript with tool calls',
      async () => {
        const { messages } = await client.listMessages(sessionId);
        assert.ok(
          messages.length >= 6,
          `transcript too short: ${messages.length}`,
        );
        assert.equal(messages[0]?.type, 'human');
        assert.ok(
          messages.some(
            (m) => m.type === 'ai' && (m.toolCalls?.length ?? 0) > 0,
          ),
          'an ai message with toolCalls',
        );
      },
    );
    await step('GET /sessions lists the session', async () => {
      const body = (await client.listSessions()) as {
        sessions: Array<{ sessionId: string }>;
      };
      assert.ok(
        body.sessions.some((s) => s.sessionId === sessionId),
        JSON.stringify(body),
      );
    });
    await step('abort mid-stream ends the stream cleanly', async () => {
      const controller = new AbortController();
      let abortReq: Promise<unknown> | undefined;
      const p = client.stream(
        sessionId,
        'Write a 600 word essay about the history of Berlin.',
        {
          signal: controller.signal,
          onEvent: (e) => {
            // Exactly ONE server-side abort. Firing one per message delta
            // leaves stragglers in flight after the stream ends — and an
            // abort landing during the NEXT turn aborts that turn (correct
            // API semantics, so the test must not race itself).
            if (e.event === 'message' && !abortReq)
              abortReq = client.abort(sessionId);
          },
        },
      );
      const r = await p.catch((err: unknown) => ({ error: err }));
      await abortReq?.catch(() => undefined);
      if ('error' in r) return; // client-side abort is acceptable
      assert.ok(r.events.some((e) => e.event === 'done'));
    });
    await step('non-streaming turn returns JSON', async () => {
      const r = await client.send(sessionId, 'Say the single word: pong');
      assert.equal(r.status, 200, JSON.stringify(r.body));
      // Node's `SendMessageResponse.message` is `{ type, content, id }`.
      const message = r.body.message;
      const content =
        typeof message === 'object' && message !== null && 'content' in message
          ? message.content
          : message;
      assert.match(String(content ?? ''), /pong/i, JSON.stringify(r.body));
    });

    // ------------------------------------------------------------------ matrix room for alice
    const aliceSession = await matrixLogin(
      alice.matrixUserId,
      alice.matrixPassword,
    );
    const aliasLocal = `${didToAliasPart(alice.did)}_${didToAliasPart(ORACLE_DID)}`;
    const roomId = await step(
      'alice creates an E2EE user↔oracle room and invites the bot',
      async () => {
        const existing = await fetch(
          `${MATRIX_BASE_URL}/_matrix/client/v3/directory/room/${encodeURIComponent(`#${aliasLocal}:ixo.test`)}`,
        );
        if (existing.ok) {
          const body = (await existing.json()) as { room_id: string };
          // make sure the bot is (re)invited if it left
          await matrixRequest(
            aliceSession,
            'POST',
            `/_matrix/client/v3/rooms/${encodeURIComponent(body.room_id)}/invite`,
            { user_id: BOT_USER_ID },
          ).catch(() => undefined);
          return body.room_id;
        }
        // `#did-ixo-*` aliases are an exclusive appservice namespace on ixo
        // homeservers — in production the rooms appservice creates user↔oracle
        // rooms. Mirror that: alice creates the room, the appservice bot joins
        // and publishes the alias, alice pins it as the canonical alias.
        const created = await matrixRequest<{ room_id: string }>(
          aliceSession,
          'POST',
          '/_matrix/client/v3/createRoom',
          {
            preset: 'private_chat',
            name: 'alice ↔ QiForge Workers',
            invite: [BOT_USER_ID, APPSERVICE_BOT],
            initial_state: [
              {
                type: 'm.room.encryption',
                state_key: '',
                content: { algorithm: 'm.megolm.v1.aes-sha2' },
              },
            ],
          },
        );
        const alias = `#${aliasLocal}:${MATRIX_SERVER_NAME}`;
        await appserviceRequest(
          'POST',
          `/_matrix/client/v3/join/${encodeURIComponent(created.room_id)}`,
          {},
        );
        await appserviceRequest(
          'PUT',
          `/_matrix/client/v3/directory/room/${encodeURIComponent(alias)}`,
          { room_id: created.room_id },
        );
        await matrixRequest(
          aliceSession,
          'PUT',
          `/_matrix/client/v3/rooms/${encodeURIComponent(created.room_id)}/state/m.room.canonical_alias`,
          { alias },
        );
        return created.room_id;
      },
    );
    await waitForMatrixGateway(oracle.url);
    await step('bot auto-joins the room', async () => {
      await waitFor(
        async () => {
          const members = await matrixRequest<{
            joined: Record<string, unknown>;
          }>(
            aliceSession,
            'GET',
            `/_matrix/client/v3/rooms/${encodeURIComponent(roomId)}/joined_members`,
          );
          return BOT_USER_ID in members.joined;
        },
        60_000,
        'bot join',
      );
      // Production rooms grant the oracle PL 50 (state-bot does it at signup);
      // mirror that so the bot can write `m.ixo.media_state` etc.
      const pl = await matrixRequest<{ users?: Record<string, number> }>(
        aliceSession,
        'GET',
        `/_matrix/client/v3/rooms/${encodeURIComponent(roomId)}/state/m.room.power_levels`,
      );
      if ((pl.users?.[BOT_USER_ID] ?? 0) < 50) {
        await matrixRequest(
          aliceSession,
          'PUT',
          `/_matrix/client/v3/rooms/${encodeURIComponent(roomId)}/state/m.room.power_levels`,
          {
            ...pl,
            users: { ...(pl.users ?? {}), [BOT_USER_ID]: 50 },
          },
        );
      }
    });

    // ------------------------------------------------------------------ storage round trip
    await step(
      'working copy flushes to the user room as m.ixo.media_state',
      async () => {
        const res = await fetch(`${oracle.url}/debug/storage/flush`, {
          method: 'POST',
          headers: client.headers(),
        });
        const body = (await res.json()) as { uploaded: boolean; bytes: number };
        assert.equal(res.status, 200, JSON.stringify(body));
        assert.ok(body.uploaded, JSON.stringify(body));
        const state = await matrixRequest<
          Array<{
            type: string;
            state_key: string;
            content: Record<string, unknown>;
          }>
        >(
          aliceSession,
          'GET',
          `/_matrix/client/v3/rooms/${encodeURIComponent(roomId)}/state`,
        );
        const media = state.filter((e) => e.type === 'm.ixo.media_state');
        assert.ok(
          media.length >= 1,
          `no m.ixo.media_state in room: ${state.map((e) => e.type).join(',')}`,
        );
      },
    );
    await step(
      'after a working-copy reset the transcript is re-imported from the owner copy',
      async () => {
        const reset = await fetch(`${oracle.url}/debug/storage/reset`, {
          method: 'POST',
          headers: client.headers(),
        });
        const body = (await reset.json()) as {
          reloadedFromOwnerStore: boolean;
        };
        assert.equal(reset.status, 200, JSON.stringify(body));
        assert.equal(body.reloadedFromOwnerStore, true, JSON.stringify(body));
        const { messages } = await client.listMessages(sessionId);
        assert.ok(
          messages.length >= 6,
          `transcript lost after reset: ${messages.length}`,
        );
        const r = await client.stream(
          sessionId,
          'One more time — what was that sum? Only the number.',
        );
        assert.match(r.text, /42/, `memory lost after reset: "${r.text}"`);
      },
    );

    // ------------------------------------------------------------------ matrix E2EE chat
    const sdk = await import('matrix-js-sdk');
    const mx = sdk.createClient({
      baseUrl: MATRIX_BASE_URL,
      accessToken: aliceSession.accessToken,
      userId: aliceSession.userId,
      deviceId: aliceSession.deviceId,
      store: new sdk.MemoryStore(),
      useAuthorizationHeader: true,
    });
    await mx.initRustCrypto({ useIndexedDB: false });
    await mx.startClient({ initialSyncLimit: 5, lazyLoadMembers: true });
    await new Promise<void>((resolve) => {
      const onSync = (state: string) => {
        if (state === 'PREPARED' || state === 'SYNCING') {
          mx.removeListener(sdk.ClientEvent.Sync, onSync);
          resolve();
        }
      };
      mx.on(sdk.ClientEvent.Sync, onSync);
    });
    const waitForBotReply = (
      after: number,
      pattern: RegExp,
      timeoutMs = 120_000,
    ) =>
      new Promise<string>((resolve, reject) => {
        const timer = setTimeout(() => {
          mx.removeListener(sdk.RoomEvent.Timeline, onTimeline);
          reject(
            new Error(`no bot reply matching ${pattern} within ${timeoutMs}ms`),
          );
        }, timeoutMs);
        const onTimeline = async (
          event: import('matrix-js-sdk').MatrixEvent,
        ) => {
          if (event.getRoomId() !== roomId || event.getSender() !== BOT_USER_ID)
            return;
          if (event.getTs() < after) return;
          await mx.decryptEventIfNeeded(event);
          if (event.getType() !== 'm.room.message') return;
          const body = String(
            (event.getContent() as { body?: string }).body ?? '',
          );
          if (pattern.test(body)) {
            clearTimeout(timer);
            mx.removeListener(sdk.RoomEvent.Timeline, onTimeline);
            resolve(body);
          }
        };
        mx.on(sdk.RoomEvent.Timeline, onTimeline);
      });
    try {
      await step(
        'alice sends an ENCRYPTED message; bot decrypts and replies encrypted',
        async () => {
          const since = Date.now();
          const room = mx.getRoom(roomId);
          assert.ok(room, 'alice sees the room');
          assert.ok(mx.isRoomEncrypted(roomId), 'room is encrypted');
          await mx.sendTextMessage(
            roomId,
            'What is 8 times 9? Reply with only the number.',
          );
          const reply = await waitForBotReply(since, /72/);
          assert.match(reply, /72/);
          // The reply must have arrived encrypted on the wire.
          const last = room
            .getLiveTimeline()
            .getEvents()
            .filter((e) => e.getSender() === BOT_USER_ID)
            .at(-1);
          assert.ok(last?.isEncrypted(), 'bot reply event is E2EE');
        },
      );

      // ── reset leaks: best-effort room posts and the dirty mark ──────────
      const debugPost = async (path: string) => {
        const res = await fetch(`${oracle.url}${path}`, {
          method: 'POST',
          headers: client.headers(),
        });
        return { status: res.status, text: await res.text() };
      };
      const storageStatus = async () => {
        // Boot the object first: the status route only reports what is open.
        await fetch(`${oracle.url}/sessions`, { headers: client.headers() });
        const res = await fetch(`${oracle.url}/debug/storage`, {
          headers: client.headers(),
        });
        assert.equal(res.status, 200, await res.clone().text());
        return (await res.json()) as {
          dirty: boolean;
          writeGeneration?: number;
          uploadedGeneration?: number;
        };
      };
      const botEventsSince = async (after: number, type: string) => {
        const room = mx.getRoom(roomId);
        let n = 0;
        for (const e of room?.getLiveTimeline().getEvents() ?? []) {
          if (e.getSender() !== BOT_USER_ID || e.getTs() < after) continue;
          await mx.decryptEventIfNeeded(e);
          if (e.getType() === type) n += 1;
        }
        return n;
      };
      const threadBodies = async (sid: string) => {
        const room = mx.getRoom(roomId);
        const bodies: string[] = [];
        for (const e of room?.getLiveTimeline().getEvents() ?? []) {
          if (e.getSender() !== BOT_USER_ID) continue;
          await mx.decryptEventIfNeeded(e);
          if (e.threadRootId !== sid) continue;
          bodies.push(String((e.getContent() as { body?: string }).body ?? ''));
        }
        return bodies;
      };
      const pause = (ms: number) => new Promise((r) => setTimeout(r, ms));

      await step(
        'replay mirror survives a gateway reset mid-turn: both mirrors land exactly once, in order',
        async () => {
          const sid = await client.createSession();
          assert.ok(sid.startsWith('$'), `session has no marker event: ${sid}`);
          const marker = `MIRROR-${Math.random().toString(36).slice(2, 8).toUpperCase()}`;
          const turn = fetch(
            `${oracle.url}/messages/${encodeURIComponent(sid)}`,
            {
              method: 'POST',
              headers: client.headers(),
              body: JSON.stringify({
                message: `Reply with exactly ${marker} and nothing else.`,
                stream: false,
              }),
            },
          );
          // The user-message mirror is in flight now: kill the gateway under it.
          await pause(200);
          const reset = await debugPost('/debug/matrix/abort');
          assert.equal(reset.status, 200, reset.text.slice(0, 200));
          const res = await turn;
          assert.equal(res.status, 200, (await res.text()).slice(0, 200));
          await waitFor(
            async () => (await threadBodies(sid)).length >= 2,
            90_000,
            `two mirrors threaded under ${sid}`,
            2_000,
          );
          await pause(10_000); // a duplicate would have arrived by now
          const bodies = await threadBodies(sid);
          assert.equal(
            bodies.length,
            2,
            `expected exactly two mirrors: ${JSON.stringify(bodies)}`,
          );
          assert.match(bodies[0] ?? '', /\*\*You:\*\*/, JSON.stringify(bodies));
          assert.ok(
            bodies[0]?.includes(marker) &&
              bodies[1]?.includes(marker) &&
              !/\*\*You:\*\*/.test(bodies[1] ?? ''),
            `mirrors out of order or wrong: ${JSON.stringify(bodies)}`,
          );
        },
      );

      await step(
        "dirty mark: an interrupted turn's committed steps are flushed after an object reset",
        async () => {
          const flushed = await debugPost('/debug/storage/flush');
          assert.equal(flushed.status, 200, flushed.text.slice(0, 200));
          const clean = await storageStatus();
          assert.equal(clean.dirty, false, JSON.stringify(clean));
          assert.equal(
            clean.writeGeneration,
            clean.uploadedGeneration,
            JSON.stringify(clean),
          );
          // A turn that dies in the middle: abort as soon as the model streams.
          const ac = new AbortController();
          let aborted = false;
          await client
            .stream(sessionId, 'Write a 1500-word essay about the sea.', {
              signal: ac.signal,
              onEvent: (e) => {
                if (
                  !aborted &&
                  (e.event === 'message' || e.event === 'reasoning')
                ) {
                  aborted = true;
                  void client.abort(sessionId);
                }
              },
            })
            .catch(() => undefined);
          assert.ok(aborted, 'the turn produced nothing to abort on');
          await pause(2_000);
          const interrupted = await storageStatus();
          assert.ok(
            (interrupted.writeGeneration ?? 0) >
              (interrupted.uploadedGeneration ?? 0),
            `the interrupted turn committed nothing: ${JSON.stringify(interrupted)}`,
          );
          assert.equal(
            interrupted.dirty,
            false,
            `already marked before the reset — the drill would not exercise the boot check: ${JSON.stringify(interrupted)}`,
          );
          // Reset the object: the boot must notice the file moved past its upload.
          const reset = await debugPost('/debug/object/abort');
          assert.equal(reset.status, 200, reset.text.slice(0, 200));
          const rebooted = await storageStatus();
          assert.equal(
            rebooted.dirty,
            true,
            `boot did not mark the copy dirty: ${JSON.stringify(rebooted)}`,
          );
          const flushed2 = await debugPost('/debug/storage/flush');
          assert.equal(flushed2.status, 200, flushed2.text.slice(0, 200));
          const after = await storageStatus();
          assert.equal(after.dirty, false, JSON.stringify(after));
          assert.equal(
            after.writeGeneration,
            after.uploadedGeneration,
            JSON.stringify(after),
          );
        },
      );

      await step(
        'reauth prompt: a room message without a delegation posts delegation_required once per throttle window',
        async () => {
          // Every HTTP call of `client` carries alice's delegation header and
          // the object adopts it, so a Matrix turn would find one. Use a
          // header-less client to reset the throttle, revoke the delegation
          // and confirm the object holds none before the room message.
          const bare = new ChatClient(oracle.url, { invocation });
          const barePost = async (path: string, method = 'POST') => {
            const res = await fetch(`${oracle.url}${path}`, {
              method,
              headers: bare.headers(),
            });
            return { status: res.status, text: await res.text() };
          };
          const reset = await barePost('/debug/reauth-prompt/reset');
          assert.equal(reset.status, 200, reset.text.slice(0, 200));
          const revoked = await barePost('/delegation', 'DELETE');
          assert.ok(revoked.status < 300, revoked.text.slice(0, 200));
          const none = await barePost('/debug/delegation', 'GET');
          assert.equal(none.status, 200, none.text.slice(0, 200));
          assert.equal(
            (JSON.parse(none.text) as { present?: boolean }).present,
            false,
            `object still holds a delegation: ${none.text}`,
          );
          const since = Date.now();
          await mx.sendTextMessage(
            roomId,
            'Reply with the single word PROMPT.',
          );
          await waitFor(
            async () =>
              (await botEventsSince(since, 'ixo.oracle.delegation_required')) >=
              1,
            90_000,
            'the delegation_required prompt',
            2_000,
          );
          await waitForBotReply(since, /PROMPT/i);
          // Inside the window a second message must not prompt again.
          const since2 = Date.now();
          await mx.sendTextMessage(roomId, 'Reply with the single word AGAIN.');
          await waitForBotReply(since2, /AGAIN/i);
          await pause(3_000);
          assert.equal(
            await botEventsSince(since2, 'ixo.oracle.delegation_required'),
            0,
            'prompted again inside the throttle window',
          );
          assert.equal(
            await botEventsSince(since, 'ixo.oracle.delegation_required'),
            1,
          );
        },
      );
      await step(
        'matrix conversation keeps memory (room-default session)',
        async () => {
          const since = Date.now();
          await mx.sendTextMessage(
            roomId,
            'And what did I just ask you to multiply? Reply with only the two numbers.',
          );
          const reply = await waitForBotReply(since, /8.*9|9.*8/);
          assert.match(reply, /8/);
        },
      );
      await step(
        'gateway restart keeps the same device id and still decrypts',
        async () => {
          const before = (await (
            await fetch(`${oracle.url}/matrix/status`)
          ).json()) as { deviceId?: string };
          const restart = await fetch(`${oracle.url}/debug/matrix/restart`, {
            method: 'POST',
          });
          assert.equal(restart.status, 200, await restart.text());
          const after = await waitForMatrixGateway(oracle.url);
          assert.equal(
            after.deviceId,
            before.deviceId,
            `device changed ${before.deviceId} → ${String(after.deviceId)}`,
          );
          const since = Date.now();
          await mx.sendTextMessage(
            roomId,
            'Still there? Reply with the single word: present',
          );
          const reply = await waitForBotReply(since, /present/i);
          assert.match(reply, /present/i);
        },
      );

      // ------------------------------------------------------------------ tasks
      // A LIVE scheduled run: previewed and created through chat (the tool
      // contract requires preview → user confirms in a NEW message → create),
      // then the DO alarm fires the run in a background session and the
      // result is delivered — encrypted — into this room.
      await step(
        'a scheduled task is previewed and created through chat',
        async () => {
          // Far enough out that both chat turns land before `at` (a past
          // one-shot time is rejected at creation), near enough to observe.
          const at = new Date(Date.now() + 100_000).toISOString();
          let since = Date.now();
          await mx.sendTextMessage(
            roomId,
            `Preview a background task for me (preview_task): title "Ping check", ` +
              `schedule kind "once" at exactly "${at}", intent: ` +
              `'Reply with exactly the word TASKPONG and nothing else.' ` +
              `Show me the preview.`,
          );
          await waitForBotReply(since, /./s);
          since = Date.now();
          await mx.sendTextMessage(
            roomId,
            'Yes, that looks right — call create_task now with exactly the ' +
              'previewed title/intent/schedule, then reply with the task id ' +
              'the tool returned (it starts with "task_").',
          );
          const confirmation = await waitForBotReply(since, /./s);
          // The task id is the proof create_task actually ran — a polite
          // reply without one means the model skipped the tool call.
          assert.match(
            confirmation,
            /task_/,
            `no task id in the confirmation — was create_task called? Reply: "${confirmation}"`,
          );
        },
      );
      await step(
        'the DO alarm fires the task and delivers the result to the room',
        async () => {
          // The run is a fresh background session on a DO alarm; the
          // reply must be the intent's exact word, delivered by the bot.
          const reply = await waitForBotReply(Date.now(), /TASKPONG/, 180_000);
          assert.match(reply, /TASKPONG/);
        },
      );
    } finally {
      mx.stopClient();
    }
  } finally {
    await oracle.stop();
    const failed = results.filter((r) => !r.ok);
    console.log('\n=== E2E summary ===');
    for (const r of results)
      console.log(
        `${r.ok ? '✔' : '✘'} ${r.name} (${r.ms} ms)${r.detail ? `\n    ${r.detail}` : ''}`,
      );
    console.log(`${results.length - failed.length}/${results.length} passed`);
    if (failed.length) process.exitCode = 1;
  }
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});

import { env, runInDurableObject } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import type { SqliteTestDO } from '../sqlite/test-do';
import {
  botPowerLevelOf,
  COMPACT_BUFFER_THRESHOLD,
  COMPACT_JIT_MIN,
  type GateInput,
  GroupChatService,
  GroupChatStore,
  groupChatOptionsFromEnv,
  isBotMentioned,
  type GroupChatDeps,
  type GroupChatOptions,
} from './group-chat';
import type { ObservedMessage } from './group-chat-summarizer';

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace -- augmenting the ambient `Cloudflare.Env` needs namespace syntax
  namespace Cloudflare {
    interface Env {
      SQLITE_TEST: DurableObjectNamespace<SqliteTestDO>;
    }
  }
}

function stub(name: string): DurableObjectStub<SqliteTestDO> {
  return env.SQLITE_TEST.get(env.SQLITE_TEST.idFromName(name));
}

const BOT = '@did-ixo-ixo1oracle:ixo.test';
const ALICE = '@did-ixo-ixo1alice:ixo.test';
const BOB = '@did-ixo-ixo1bob:ixo.test';
const ROOM = '!group:ixo.test';

/**
 * A fake homeserver: rooms with members, member display names, sent events
 * and power levels; a scripted summarizer; a manual clock.
 */
function fakeDeps(
  overrides: {
    members?: string[];
    isDirect?: boolean;
    oracleRoom?: boolean;
    names?: Record<string, string>;
    profiles?: Record<string, string>;
    events?: Record<string, { sender: string }>;
    powerLevels?: unknown;
    summarize?: (messages: ObservedMessage[]) => Promise<string | null>;
  } = {},
) {
  const members = overrides.members ?? [BOT, ALICE, BOB];
  const calls = { members: 0, memberEvents: 0, events: 0, summaries: 0 };
  const kept: Promise<unknown>[] = [];
  const log: string[] = [];
  let now = 1_000_000;
  const deps: GroupChatDeps = {
    botUserId: BOT,
    isOracleRoom: async () => overrides.oracleRoom === true,
    getRoomStateEvent: async (_roomId, type, stateKey) => {
      if (type === 'm.room.create')
        return overrides.isDirect ? JSON.stringify({ is_direct: true }) : null;
      if (type === 'm.room.member') {
        calls.memberEvents += 1;
        const name = overrides.names?.[stateKey ?? ''];
        return name ? JSON.stringify({ displayname: name }) : null;
      }
      if (type === 'm.room.power_levels')
        return overrides.powerLevels === undefined
          ? null
          : JSON.stringify(overrides.powerLevels);
      return null;
    },
    getJoinedRoomMembers: async () => {
      calls.members += 1;
      return members;
    },
    getEvent: async (_roomId, eventId) => {
      calls.events += 1;
      const ev = overrides.events?.[eventId];
      return ev
        ? JSON.stringify({ event_id: eventId, sender: ev.sender })
        : null;
    },
    getUserProfile: async (userId) => {
      const name = overrides.profiles?.[userId];
      return name ? { displayname: name } : null;
    },
    summarize: async (messages) => {
      calls.summaries += 1;
      return overrides.summarize
        ? overrides.summarize(messages)
        : `summary of ${messages.length}: ${messages.map((m) => m.body).join(' | ')}`;
    },
    keepAlive: (work) => {
      kept.push(work);
    },
    log: (level, msg) => {
      log.push(`${level}: ${msg}`);
    },
    now: () => now,
    jitTimeoutMs: 50,
  };
  return {
    deps,
    calls,
    log,
    kept,
    settle: () => Promise.allSettled(kept.splice(0)),
    tick: (ms: number) => {
      now += ms;
    },
  };
}

const options: GroupChatOptions = {
  groupRooms: 'gate',
  activeThreadTtlMs: 60_000,
  requirePowerLevel: 0,
  roomInfoTtlMs: 60_000,
};

let seq = 0;
function gateInput(over: Partial<GateInput> = {}): GateInput {
  seq += 1;
  const eventId = over.eventId ?? `$e${seq}`;
  return {
    roomId: ROOM,
    threadId: eventId,
    eventId,
    sender: ALICE,
    senderDid: 'did:ixo:ixo1alice',
    body: `message ${seq}`,
    ts: seq * 1000,
    mentionsBot: false,
    ...over,
  };
}

describe('group-chat options + pure helpers', () => {
  it('reads the Node knobs from the gateway env with Node defaults', () => {
    expect(groupChatOptionsFromEnv({})).toEqual({
      groupRooms: 'silent',
      activeThreadTtlMs: 30 * 60 * 1000,
      requirePowerLevel: 0,
      roomInfoTtlMs: 30 * 60 * 1000,
    });
    expect(
      groupChatOptionsFromEnv({
        MATRIX_GROUP_ROOMS: 'gate',
        GROUP_CHAT_ACTIVE_THREAD_TTL_MS: '120000',
        GROUP_CHAT_REQUIRE_POWER_LEVEL: '50',
        GROUP_CHAT_ROOM_INFO_TTL_MS: '1', // below the minimum → default
      }),
    ).toEqual({
      groupRooms: 'gate',
      activeThreadTtlMs: 120_000,
      requirePowerLevel: 50,
      roomInfoTtlMs: 30 * 60 * 1000,
    });
  });

  it('detects a mention only through m.mentions.user_ids', () => {
    expect(isBotMentioned({ 'm.mentions': { user_ids: [BOT] } }, BOT)).toBe(
      true,
    );
    expect(isBotMentioned({ 'm.mentions': { user_ids: [ALICE] } }, BOT)).toBe(
      false,
    );
    expect(isBotMentioned({ body: `hey ${BOT}` }, BOT)).toBe(false);
    expect(isBotMentioned(undefined, BOT)).toBe(false);
  });

  it('resolves the bot power level like Node (missing event = everyone allowed)', () => {
    expect(botPowerLevelOf(undefined, BOT).allowed()).toBe(true);
    const pl = botPowerLevelOf(
      { users: { [BOT]: 10 }, events: { 'm.room.message': 25 } },
      BOT,
    );
    expect(pl).toMatchObject({ pl: 10, sendThreshold: 25 });
    expect(pl.allowed()).toBe(false);
    expect(
      botPowerLevelOf({ users_default: 50, events_default: 50 }, BOT).allowed(
        60,
      ),
    ).toBe(false);
    expect(
      botPowerLevelOf(
        { users: { [BOT]: 100 }, events_default: 50 },
        BOT,
      ).allowed(60),
    ).toBe(true);
  });
});

describe('GroupChatStore', () => {
  it('stores chunks with an FTS5 index and searches them (ranked, stemmed), LIKE for a query FTS rejects', async () => {
    await runInDurableObject(stub('group-store'), async (_i, state) => {
      const store = new GroupChatStore(state.storage.sql);
      expect(store.fts).toBe(true);
      const chunk = (id: string, summary: string, toTs: number) => ({
        id,
        roomId: ROOM,
        summary,
        fromEventId: `$f${id}`,
        toEventId: `$t${id}`,
        fromTimestamp: toTs - 10,
        toTimestamp: toTs,
        messageCount: 3,
        participants: ['did:ixo:ixo1alice'],
        threadIds: ['$t'],
        tier: 1,
        createdAt: toTs,
      });
      store.insertChunk(
        chunk('a', 'The team decided the launch date is Friday.', 1000),
      );
      store.insertChunk(
        chunk('b', 'Bob owns the redesign; Alice reviews it.', 2000),
      );
      store.insertChunk({
        ...chunk('other', 'launch talk elsewhere', 3000),
        roomId: '!other:x',
      });
      expect(store.countChunks(ROOM)).toBe(2);
      expect(store.recentChunks(ROOM, 10).map((c) => c.id)).toEqual(['b', 'a']);
      expect(store.oldestChunks(ROOM, 1).map((c) => c.id)).toEqual(['a']);
      // Stemming: "launching" finds "launch"; the other room's chunk is out.
      expect(
        store.searchChunks(ROOM, 'launching', 10).map((c) => c.id),
      ).toEqual(['a']);
      // Several words are OR-ed.
      expect(
        store
          .searchChunks(ROOM, 'redesign friday', 10)
          .map((c) => c.id)
          .sort(),
      ).toEqual(['a', 'b']);
      // A query the FTS parser rejects falls back to LIKE (every word, as a
      // substring): the unbalanced parenthesis is a syntax error for FTS5.
      store.insertChunk(chunk('c', 'Notes: launch (final) is Friday.', 2500));
      expect(store.searchChunks(ROOM, 'final)', 10).map((c) => c.id)).toEqual([
        'c',
      ]);
      expect(
        store.searchChunks(ROOM, 'final) nothing-here', 10).map((c) => c.id),
      ).toEqual([]);
      expect(store.searchChunks(ROOM, '   ', 10).map((c) => c.id)).toEqual([
        'c',
        'b',
        'a',
      ]);
    });
  });

  it('keeps pinned facts, the roster, the compaction buffer and the durable bot-thread marks', async () => {
    await runInDurableObject(stub('group-store-2'), async (_i, state) => {
      const store = new GroupChatStore(state.storage.sql);
      store.insertPinnedFact({
        id: 'f1',
        roomId: ROOM,
        fact: 'Alice owns the redesign.',
        pinnedByDid: 'did:ixo:ixo1bob',
        createdAt: 1,
      });
      store.insertPinnedFact({
        id: 'f2',
        roomId: ROOM,
        fact: 'Launch is Friday.',
        pinnedByDid: 'did:ixo:ixo1bob',
        sourceEventId: '$src',
        createdAt: 2,
      });
      expect(store.listPinnedFacts(ROOM).map((f) => f.id)).toEqual([
        'f2',
        'f1',
      ]);
      expect(store.listPinnedFacts(ROOM)[0]?.sourceEventId).toBe('$src');
      expect(store.deletePinnedFact(ROOM, 'f1')).toBe(true);
      expect(store.deletePinnedFact(ROOM, 'f1')).toBe(false);
      expect(store.deletePinnedFact('!other:x', 'f2')).toBe(false);
      expect(store.listPinnedFacts(ROOM).map((f) => f.id)).toEqual(['f2']);

      expect(store.getMembers(ROOM)).toEqual([]);
      store.upsertMembers(
        ROOM,
        [{ matrixUserId: ALICE, displayName: 'Alice' }],
        5,
      );
      store.upsertMembers(ROOM, [{ matrixUserId: BOB, displayName: 'Bob' }], 6);
      expect(store.getMembers(ROOM)).toEqual([
        { matrixUserId: BOB, displayName: 'Bob' },
      ]);

      const observed = (eventId: string, ts: number): ObservedMessage => ({
        eventId,
        threadId: '$t',
        senderDid: 'did:ixo:ixo1alice',
        senderMatrixUserId: ALICE,
        senderDisplayName: 'Alice',
        body: `m ${eventId}`,
        timestamp: ts,
      });
      expect(store.bufferAppend(ROOM, observed('$2', 20))).toBe(true);
      expect(store.bufferAppend(ROOM, observed('$1', 10))).toBe(true);
      expect(store.bufferAppend(ROOM, observed('$1', 10))).toBe(false); // a replay
      expect(store.bufferCount(ROOM)).toBe(2);
      expect(store.bufferRows(ROOM).map((m) => m.eventId)).toEqual([
        '$1',
        '$2',
      ]);
      store.bufferDelete(['$1']);
      expect(store.bufferRows(ROOM).map((m) => m.eventId)).toEqual(['$2']);

      store.markBotThread(ROOM, '$t', 500);
      expect(store.botThreadExpiry(ROOM, '$t')).toBe(500);
      store.markBotThread(ROOM, '$t', 900);
      expect(store.botThreadExpiry(ROOM, '$t')).toBe(900);
      store.sweepBotThreads(901);
      expect(store.botThreadExpiry(ROOM, '$t')).toBeUndefined();
      expect(store.stats()).toEqual({ buffered: 1, chunks: 0, facts: 1 });
    });
  });
});

describe('GroupChatService', () => {
  it('classifies rooms like Node: the create flag, then ≤ 2 joined members; cached until invalidated', async () => {
    await runInDurableObject(stub('group-rooms'), async (_i, state) => {
      const direct = fakeDeps({ members: [BOT, ALICE] });
      const svc = new GroupChatService(state.storage.sql, direct.deps, options);
      expect(await svc.roomInfo(ROOM)).toEqual({
        isDirect: true,
        memberCount: 2,
        joinedMemberIds: [BOT, ALICE],
      });
      await svc.roomInfo(ROOM);
      expect(direct.calls.members).toBe(1); // cached
      svc.invalidateRoom(ROOM);
      await svc.roomInfo(ROOM);
      expect(direct.calls.members).toBe(2);
      direct.tick(options.roomInfoTtlMs + 1);
      await svc.roomInfo(ROOM);
      expect(direct.calls.members).toBe(3); // expired

      const flagged = fakeDeps({ members: [BOT, ALICE, BOB], isDirect: true });
      const svc2 = new GroupChatService(
        state.storage.sql,
        flagged.deps,
        options,
      );
      expect((await svc2.roomInfo(ROOM)).isDirect).toBe(true);

      const group = fakeDeps();
      const svc3 = new GroupChatService(state.storage.sql, group.deps, options);
      expect(await svc3.roomInfo(ROOM)).toMatchObject({
        isDirect: false,
        memberCount: 3,
      });

      // A user↔oracle room stays direct however many service bots sit in it
      // (devnet rooms hold the room bot and the memory engine as well).
      const aliased = fakeDeps({
        members: [BOT, ALICE, '@ixo-room-bot:ixo.test', '@memory:ixo.test'],
        oracleRoom: true,
      });
      const svc4 = new GroupChatService(
        state.storage.sql,
        aliased.deps,
        options,
      );
      expect(await svc4.roomInfo(ROOM)).toMatchObject({
        isDirect: true,
        memberCount: 4,
      });
      expect(await svc4.gate(gateInput())).toMatchObject({
        respond: true,
        reason: 'dm',
        roomKind: 'direct',
      });
    });
  });

  it('resolves display names from the member event, then the profile, then the user id', async () => {
    await runInDurableObject(stub('group-names'), async (_i, state) => {
      const f = fakeDeps({
        names: { [ALICE]: 'Alice Room' },
        profiles: { [ALICE]: 'Alice Global', [BOB]: 'Bob' },
      });
      const svc = new GroupChatService(state.storage.sql, f.deps, options);
      expect(await svc.displayName(ROOM, ALICE)).toBe('Alice Room');
      expect(await svc.displayName(ROOM, BOB)).toBe('Bob');
      expect(await svc.displayName(ROOM, '@nobody:ixo.test')).toBe(
        '@nobody:ixo.test',
      );
      await svc.displayName(ROOM, ALICE);
      expect(f.calls.memberEvents).toBe(3); // cached per room+user
    });
  });

  it('always answers in a direct room, without touching channel memory', async () => {
    await runInDurableObject(stub('group-gate-dm'), async (_i, state) => {
      const f = fakeDeps({
        members: [BOT, ALICE],
        names: { [ALICE]: 'Alice' },
      });
      const svc = new GroupChatService(state.storage.sql, f.deps, options);
      expect(await svc.gate(gateInput())).toEqual({
        respond: true,
        reason: 'dm',
        roomKind: 'direct',
        memberCount: 2,
        displayName: 'Alice',
      });
      expect(svc.store.bufferCount(ROOM)).toBe(0);
    });
  });

  it('answers a mention, a reply to the bot and an active thread; ignores the rest but captures it', async () => {
    await runInDurableObject(stub('group-gate'), async (_i, state) => {
      const f = fakeDeps({
        names: { [ALICE]: 'Alice' },
        events: { $botmsg: { sender: BOT }, $alicemsg: { sender: ALICE } },
      });
      const svc = new GroupChatService(state.storage.sql, f.deps, options);

      const ignored = await svc.gate(gateInput({ eventId: '$1' }));
      expect(ignored).toMatchObject({
        respond: false,
        reason: 'ignored',
        roomKind: 'group',
        memberCount: 3,
      });
      expect(svc.store.bufferRows(ROOM).map((m) => m.eventId)).toEqual(['$1']);

      const mentioned = await svc.gate(
        gateInput({ eventId: '$2', mentionsBot: true }),
      );
      expect(mentioned).toMatchObject({
        respond: true,
        reason: 'mentioned',
        displayName: 'Alice',
      });
      // The thread the bot answers in is active now: a follow-up without a mention is answered.
      const followUp = await svc.gate(
        gateInput({ eventId: '$3', threadId: '$2' }),
      );
      expect(followUp).toMatchObject({
        respond: true,
        reason: 'active-thread',
      });
      // A quote-reply to the bot's own message is answered; to someone else's is not.
      expect(
        await svc.gate(gateInput({ eventId: '$4', inReplyTo: '$botmsg' })),
      ).toMatchObject({ respond: true, reason: 'reply-to-bot' });
      expect(
        await svc.gate(gateInput({ eventId: '$5', inReplyTo: '$alicemsg' })),
      ).toMatchObject({ respond: false, reason: 'ignored' });
      // Every group message was captured, answered or not.
      expect(svc.store.bufferCount(ROOM)).toBe(5);
      await f.settle();
      // The roster was refreshed for the answered turns (bot excluded).
      expect(
        svc.store
          .getMembers(ROOM)
          .map((m) => m.matrixUserId)
          .sort(),
      ).toEqual([ALICE, BOB]);

      // The active thread survives a new instance (the durable table), and expires.
      const again = new GroupChatService(state.storage.sql, f.deps, options);
      expect(
        await again.gate(gateInput({ eventId: '$6', threadId: '$2' })),
      ).toMatchObject({ respond: true, reason: 'active-thread' });
      f.tick(options.activeThreadTtlMs + 1);
      const later = new GroupChatService(state.storage.sql, f.deps, options);
      expect(
        await later.gate(gateInput({ eventId: '$7', threadId: '$2' })),
      ).toMatchObject({ respond: false, reason: 'ignored' });
    });
  });

  it('stays silent when the bot cannot post (power levels), passes through when the gate is off or the room is unreadable', async () => {
    await runInDurableObject(stub('group-gate-pl'), async (_i, state) => {
      const muted = fakeDeps({
        powerLevels: { users: { [BOT]: 0 }, events: { 'm.room.message': 50 } },
      });
      const svc = new GroupChatService(state.storage.sql, muted.deps, options);
      expect(await svc.gate(gateInput({ mentionsBot: true }))).toMatchObject({
        respond: false,
        reason: 'power-level',
      });
      expect(muted.log.some((l) => /bot PL 0 < required 50/.test(l))).toBe(
        true,
      );

      const strict = fakeDeps({
        powerLevels: { users: { [BOT]: 50 }, events: { 'm.room.message': 50 } },
      });
      const svc2 = new GroupChatService(state.storage.sql, strict.deps, {
        ...options,
        requirePowerLevel: 60,
      });
      expect(await svc2.gate(gateInput({ mentionsBot: true }))).toMatchObject({
        respond: false,
        reason: 'power-level',
      });
      const svc3 = new GroupChatService(
        state.storage.sql,
        strict.deps,
        options,
      );
      expect(await svc3.gate(gateInput({ mentionsBot: true }))).toMatchObject({
        respond: true,
        reason: 'mentioned',
      });

      const answerAll = new GroupChatService(
        state.storage.sql,
        fakeDeps().deps,
        { ...options, groupRooms: 'answer' },
      );
      expect(await answerAll.gate(gateInput())).toMatchObject({
        respond: true,
        reason: 'answer-all',
        roomKind: 'direct',
      });

      const broken = fakeDeps();
      broken.deps.getJoinedRoomMembers = async () => {
        throw new Error('503');
      };
      const svc4 = new GroupChatService(
        state.storage.sql,
        broken.deps,
        options,
      );
      expect(await svc4.gate(gateInput())).toMatchObject({
        respond: true,
        reason: 'dm',
        roomKind: 'direct',
      });
    });
  });

  it('compacts the buffer at the threshold into a searchable chunk, keeps it when the summary fails, and dedups replays', async () => {
    await runInDurableObject(stub('group-compact'), async (_i, state) => {
      let fail = false;
      const f = fakeDeps({
        summarize: async (messages) =>
          fail
            ? null
            : `The group discussed ${messages.length} things about kiwis.`,
      });
      const svc = new GroupChatService(state.storage.sql, f.deps, options);
      const observed = (i: number): ObservedMessage => ({
        eventId: `$o${i}`,
        threadId: '$t',
        senderDid: 'did:ixo:ixo1alice',
        senderMatrixUserId: ALICE,
        senderDisplayName: 'Alice',
        body: `kiwi ${i}`,
        timestamp: i,
      });
      for (let i = 1; i < COMPACT_BUFFER_THRESHOLD; i += 1)
        svc.observe(ROOM, observed(i));
      expect(f.calls.summaries).toBe(0);
      svc.observe(ROOM, observed(COMPACT_BUFFER_THRESHOLD));
      await f.settle();
      expect(f.calls.summaries).toBe(1);
      expect(svc.store.bufferCount(ROOM)).toBe(0);
      const chunks = svc.recall(ROOM).chunks;
      expect(chunks).toHaveLength(1);
      expect(chunks[0]).toMatchObject({
        messageCount: COMPACT_BUFFER_THRESHOLD,
        fromEventId: '$o1',
        toEventId: `$o${COMPACT_BUFFER_THRESHOLD}`,
        participants: ['did:ixo:ixo1alice'],
        threadIds: ['$t'],
        tier: 1,
      });
      expect(svc.search(ROOM, 'kiwi')).toHaveLength(1);

      // A failed summary leaves the batch buffered for the next attempt.
      fail = true;
      for (let i = 100; i < 100 + COMPACT_BUFFER_THRESHOLD; i += 1)
        svc.observe(ROOM, observed(i));
      await f.settle();
      expect(svc.store.bufferCount(ROOM)).toBe(COMPACT_BUFFER_THRESHOLD);
      // A replayed message is not buffered twice.
      svc.observe(ROOM, observed(100));
      expect(svc.store.bufferCount(ROOM)).toBe(COMPACT_BUFFER_THRESHOLD);
      fail = false;
      await svc.compact(ROOM);
      expect(svc.store.bufferCount(ROOM)).toBe(0);
      expect(svc.recall(ROOM, 30).chunks).toHaveLength(2);
    });
  });

  it('compacts just in time before an answer (≥ 5 buffered) without holding the reply past the cap', async () => {
    await runInDurableObject(stub('group-jit'), async (_i, state) => {
      let release: () => void = () => undefined;
      const slow = new Promise<string>((resolve) => {
        release = () => resolve('slow summary');
      });
      const f = fakeDeps({ summarize: () => slow });
      const svc = new GroupChatService(state.storage.sql, f.deps, options);
      for (let i = 1; i < COMPACT_JIT_MIN; i += 1)
        await svc.gate(gateInput({ eventId: `$j${i}` }));
      expect(f.calls.summaries).toBe(0);
      // The fifth message is a mention: the answer must not wait for the slow model.
      const started = Date.now();
      const decision = await svc.gate(
        gateInput({ eventId: '$j5', mentionsBot: true }),
      );
      expect(decision.respond).toBe(true);
      expect(Date.now() - started).toBeLessThan(1_000);
      expect(f.calls.summaries).toBe(1);
      expect(svc.store.bufferCount(ROOM)).toBe(COMPACT_JIT_MIN); // still buffered
      release();
      await f.settle();
      expect(svc.store.bufferCount(ROOM)).toBe(0);
      expect(svc.recall(ROOM).chunks[0]?.summary).toBe('slow summary');
    });
  });

  it('the default policy is silent: a group room gets no reply, no capture, no member lookups; direct rooms are unchanged', async () => {
    await runInDurableObject(stub('group-silent'), async (_i, state) => {
      const f = fakeDeps({ names: { [ALICE]: 'Alice' } });
      const svc = new GroupChatService(
        state.storage.sql,
        f.deps,
        groupChatOptionsFromEnv({}),
      );
      expect(svc.options.groupRooms).toBe('silent');
      for (const input of [
        gateInput({ mentionsBot: true }),
        gateInput({ inReplyTo: '$botmsg' }),
        gateInput(),
      ])
        expect(await svc.gate(input)).toEqual({
          respond: false,
          reason: 'group-rooms-off',
          roomKind: 'group',
          memberCount: 3,
          displayName: ALICE,
        });
      expect(svc.store.stats()).toEqual({ buffered: 0, chunks: 0, facts: 0 });
      expect(f.calls.memberEvents).toBe(0);
      expect(f.calls.events).toBe(0);
      expect(svc.store.getMembers(ROOM)).toEqual([]);

      const dm = fakeDeps({
        members: [BOT, ALICE],
        names: { [ALICE]: 'Alice' },
      });
      const direct = new GroupChatService(
        state.storage.sql,
        dm.deps,
        groupChatOptionsFromEnv({}),
      );
      expect(await direct.gate(gateInput({ mentionsBot: true }))).toMatchObject(
        {
          respond: true,
          reason: 'dm',
          roomKind: 'direct',
          displayName: 'Alice',
        },
      );
    });
  });

  it('pins and unpins facts (trimmed, capped) and serves the recall bundle', async () => {
    await runInDurableObject(stub('group-facts'), async (_i, state) => {
      const svc = new GroupChatService(
        state.storage.sql,
        fakeDeps().deps,
        options,
      );
      const pinned = svc.pinFact({
        roomId: ROOM,
        fact: `  ${'x'.repeat(600)}  `,
        pinnedByDid: 'did:ixo:ixo1bob',
      });
      expect(pinned.fact).toHaveLength(500);
      const bundle = svc.recall(ROOM);
      expect(bundle.pinnedFacts.map((f) => f.id)).toEqual([pinned.id]);
      expect(bundle.chunks).toEqual([]);
      expect(svc.unpinFact(ROOM, pinned.id)).toBe(true);
      expect(svc.recall(ROOM).pinnedFacts).toEqual([]);
    });
  });
});

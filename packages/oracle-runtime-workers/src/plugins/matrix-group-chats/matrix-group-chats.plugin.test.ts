import { describe, expect, it } from 'vitest';
import { validateManifest } from '../../core/manifest';
import { makeRuntimeContext } from '../../core/test-fixtures';
import type { RuntimeContext } from '../../plugin-api/types';
import { MatrixGroupChatsPlugin } from './index';

function ctxFor(input: {
  client: RuntimeContext['session']['client'];
  roomId?: string;
  members?: number;
  isDirect?: boolean;
  fail?: boolean;
  noGateway?: boolean;
  groupLane?: boolean;
}): RuntimeContext {
  const base = makeRuntimeContext();
  const memory: NonNullable<RuntimeContext['matrix']['channelMemory']> = {
    recall: async () => ({ chunks: [], pinnedFacts: [], members: [] }),
    search: async () => [],
    pin: async (args) => ({
      id: 'f1',
      roomId: args.roomId,
      fact: args.fact,
      pinnedByDid: args.pinnedByDid,
      createdAt: 1,
    }),
    unpin: async () => true,
  };
  return {
    ...base,
    session: {
      ...base.session,
      client: input.client,
      ...(input.roomId ? { roomId: input.roomId } : {}),
    },
    matrix: {
      ...base.matrix,
      ...(input.noGateway
        ? {}
        : {
            roomInfo: async () => {
              if (input.fail) throw new Error('503');
              const memberCount = input.members ?? 3;
              return {
                isDirect: input.isDirect ?? memberCount <= 2,
                memberCount,
                joinedMemberIds: [],
                groupLane: input.groupLane ?? true,
              };
            },
            channelMemory: memory,
          }),
    },
  };
}

describe('MatrixGroupChatsPlugin', () => {
  it('has the Node identity and a valid manifest, and is on by default', () => {
    const plugin = new MatrixGroupChatsPlugin();
    expect(plugin.name).toBe('matrix-group-chats');
    expect(plugin.version).toBe('1.0.0');
    expect(plugin.manifest.visibility).toBe('on-demand');
    const result = validateManifest(plugin.manifest, plugin.name);
    expect(result.errors).toEqual([]);
    expect(result.valid).toBe(true);
    expect(plugin.autoDetect).toBeUndefined();
    expect(plugin.configSchema.parse({})).toEqual({
      GROUP_CHAT_ACTIVE_THREAD_TTL_MS: 30 * 60 * 1000,
      GROUP_CHAT_REQUIRE_POWER_LEVEL: 0,
      GROUP_CHAT_ROOM_INFO_TTL_MS: 30 * 60 * 1000,
    });
  });

  it('offers the four channel-memory tools only to a session in a Matrix group room', async () => {
    const plugin = new MatrixGroupChatsPlugin();
    const names = async (ctx: RuntimeContext) =>
      (await plugin.getRequestTools(ctx)).map((t) => t.name);
    expect(await names(ctxFor({ client: 'matrix', roomId: '!g:x' }))).toEqual([
      'recall_channel_memory',
      'search_channel_memory',
      'pin_room_fact',
      'unpin_room_fact',
    ]);
    expect(
      await names(ctxFor({ client: 'matrix', roomId: '!dm:x', members: 2 })),
    ).toEqual([]);
    expect(
      await names(
        ctxFor({
          client: 'matrix',
          roomId: '!flag:x',
          members: 5,
          isDirect: true,
        }),
      ),
    ).toEqual([]);
    expect(await names(ctxFor({ client: 'portal', roomId: '!g:x' }))).toEqual(
      [],
    );
    expect(await names(ctxFor({ client: 'matrix' }))).toEqual([]);
    expect(
      await names(ctxFor({ client: 'matrix', roomId: '!g:x', fail: true })),
    ).toEqual([]);
    expect(
      await names(
        ctxFor({ client: 'matrix', roomId: '!g:x', noGateway: true }),
      ),
    ).toEqual([]);
    // The deployment default: no group-chat lane, no tools.
    expect(
      await names(
        ctxFor({ client: 'matrix', roomId: '!g:x', groupLane: false }),
      ),
    ).toEqual([]);
  });

  it('the tools read and write the room memory of the session room as the current user', async () => {
    const plugin = new MatrixGroupChatsPlugin();
    const ctx = ctxFor({ client: 'matrix', roomId: '!g:x' });
    const pins: unknown[] = [];
    ctx.matrix.channelMemory = {
      ...ctx.matrix.channelMemory!,
      pin: async (args) => {
        pins.push(args);
        return {
          id: 'f9',
          roomId: args.roomId,
          fact: args.fact,
          pinnedByDid: args.pinnedByDid,
          createdAt: 1,
        };
      },
      search: async (_room, query) =>
        query === 'kiwi'
          ? [
              {
                id: 'c1',
                roomId: '!g:x',
                summary: 'kiwis were discussed',
                fromEventId: '$a',
                toEventId: '$b',
                fromTimestamp: 0,
                toTimestamp: 1000,
                messageCount: 2,
                participants: [],
                threadIds: [],
                tier: 1,
                createdAt: 1,
              },
            ]
          : [],
    };
    const tools = await plugin.getRequestTools(ctx);
    const tool = (name: string) => tools.find((t) => t.name === name)!;
    expect(
      await tool('pin_room_fact').handler(
        { fact: '  Launch is Friday.  ' },
        ctx,
      ),
    ).toEqual({
      factId: 'f9',
      fact: 'Launch is Friday.',
    });
    expect(pins[0]).toMatchObject({
      roomId: '!g:x',
      fact: 'Launch is Friday.',
      pinnedByDid: ctx.user.did,
    });
    expect(
      await tool('search_channel_memory').handler({ query: 'kiwi' }, ctx),
    ).toMatchObject({
      chunks: [
        {
          id: 'c1',
          summary: 'kiwis were discussed',
          toTimestamp: '1970-01-01T00:00:01.000Z',
        },
      ],
    });
    expect(
      await tool('search_channel_memory').handler({ query: 'nothing' }, ctx),
    ).toEqual({
      chunks: [],
      note: 'No matching chunks.',
    });
    expect(
      await tool('unpin_room_fact').handler({ factId: 'f9' }, ctx),
    ).toEqual({ ok: true });
    expect(await tool('recall_channel_memory').handler({}, ctx)).toEqual({
      chunks: [],
      pinnedFacts: [],
      members: [],
    });
  });
});

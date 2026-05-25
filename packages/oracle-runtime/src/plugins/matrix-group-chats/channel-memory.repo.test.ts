import Database from 'better-sqlite3';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ChannelMemoryRepo } from './channel-memory.repo.js';
import type {
  ChannelMember,
  ChannelMemoryChunk,
  PinnedFact,
} from './channel-memory.types.js';

const ROOM_A = '!room-a:matrix.test';
const ROOM_B = '!room-b:matrix.test';

const makeChunk = (
  overrides: Partial<ChannelMemoryChunk> & { id: string },
): ChannelMemoryChunk => ({
  id: overrides.id,
  roomId: ROOM_A,
  summary: 'default summary text',
  fromEventId: '$evt-from',
  toEventId: '$evt-to',
  fromTimestamp: 1_000,
  toTimestamp: 2_000,
  messageCount: 5,
  participants: ['@alice:matrix.test'],
  threadIds: ['thread-1'],
  tier: 1,
  createdAt: Date.now(),
  ...overrides,
});

describe('ChannelMemoryRepo', () => {
  let tmpDir: string;
  let dbPath: string;
  let repo: ChannelMemoryRepo;

  beforeAll(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'channel-memory-repo-'));
    dbPath = path.join(tmpDir, 'test.db');
    repo = new ChannelMemoryRepo(dbPath);
  });

  afterAll(() => {
    try {
      repo.close();
    } catch {
      // best effort
    }
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('insertChunk → recentChunks returns it (tier-1 only)', () => {
    const chunk = makeChunk({
      id: 'chunk-1',
      summary: 'launch date discussion with Alice',
      toTimestamp: 5_000,
    });
    repo.insertChunk(chunk);

    const recent = repo.recentChunks(ROOM_A, 10);
    expect(recent).toHaveLength(1);
    expect(recent[0]?.id).toBe('chunk-1');
    expect(recent[0]?.summary).toBe('launch date discussion with Alice');
    expect(recent[0]?.tier).toBe(1);

    // Tier-2 chunk is filtered out by recentChunks (default tier=1).
    repo.insertChunk(
      makeChunk({ id: 'chunk-tier2', tier: 2, toTimestamp: 9_000 }),
    );
    const stillTier1 = repo.recentChunks(ROOM_A, 10);
    expect(stillTier1.map((c) => c.id)).toEqual(['chunk-1']);
    expect(repo.recentChunks(ROOM_A, 10, 2).map((c) => c.id)).toEqual([
      'chunk-tier2',
    ]);
  });

  it('searchChunks: FTS5 hit + multi-word OR + empty query returns recent', () => {
    repo.insertChunk(
      makeChunk({
        id: 'chunk-search-1',
        summary: 'Alice confirmed the redesign deadline is Friday',
        toTimestamp: 10_000,
      }),
    );
    repo.insertChunk(
      makeChunk({
        id: 'chunk-search-2',
        summary: 'Bob discussed marketing budget for Q3',
        toTimestamp: 11_000,
      }),
    );

    const hit = repo.searchChunks(ROOM_A, 'redesign', 10);
    expect(hit.map((c) => c.id)).toContain('chunk-search-1');

    // Multi-word OR matches either word.
    const orHit = repo.searchChunks(ROOM_A, 'redesign budget', 10);
    const ids = orHit.map((c) => c.id);
    expect(ids).toContain('chunk-search-1');
    expect(ids).toContain('chunk-search-2');

    // Empty query falls through to recentChunks (tier-1 only).
    const empty = repo.searchChunks(ROOM_A, '   ', 10);
    const emptyIds = empty.map((c) => c.id);
    expect(emptyIds).toContain('chunk-search-1');
    expect(emptyIds).not.toContain('chunk-tier2'); // tier=2 excluded
  });

  it('pinFact + listPinnedFacts + deletePinnedFact', () => {
    const fact: PinnedFact = {
      id: 'fact-1',
      roomId: ROOM_A,
      fact: 'Alice owns the redesign',
      pinnedByDid: 'did:ixo:alice',
      createdAt: Date.now(),
    };
    repo.insertPinnedFact(fact);

    const facts = repo.listPinnedFacts(ROOM_A);
    expect(facts).toHaveLength(1);
    expect(facts[0]?.fact).toBe('Alice owns the redesign');

    const deleted = repo.deletePinnedFact(ROOM_A, 'fact-1');
    expect(deleted).toBe(true);
    expect(repo.listPinnedFacts(ROOM_A)).toHaveLength(0);

    expect(repo.deletePinnedFact(ROOM_A, 'no-such-fact')).toBe(false);
  });

  it('upsertMembers + getMembers (also filters malformed JSON entries)', () => {
    const members: ChannelMember[] = [
      { matrixUserId: '@alice:matrix.test', displayName: 'Alice' },
      { matrixUserId: '@bob:matrix.test', displayName: 'Bob' },
    ];
    repo.upsertMembers(ROOM_A, members);
    expect(repo.getMembers(ROOM_A)).toEqual(members);

    // Upsert overwrites with the new roster.
    repo.upsertMembers(ROOM_A, [
      { matrixUserId: '@alice:matrix.test', displayName: 'Alice' },
    ]);
    expect(repo.getMembers(ROOM_A)).toHaveLength(1);

    // Malformed entries are filtered out. upsertMembers refuses anything
    // that doesn't match the type, so we open a second connection to the
    // same DB file and write a mixed JSON blob directly to channel_meta.
    const sideDb = new Database(dbPath);
    try {
      const roomMalformed = '!room-malformed:matrix.test';
      const mixed = [
        { matrixUserId: '@carol:matrix.test', displayName: 'Carol' },
        { matrixUserId: 42, displayName: 'NotAUserId' },
        null,
        { displayName: 'NoMatrixId' },
      ];
      sideDb
        .prepare(
          `INSERT INTO channel_meta (room_id, members_json, updated_at) VALUES (?, ?, ?)`,
        )
        .run(roomMalformed, JSON.stringify(mixed), Date.now());
      expect(repo.getMembers(roomMalformed)).toEqual([
        { matrixUserId: '@carol:matrix.test', displayName: 'Carol' },
      ]);

      // Garbage JSON returns an empty list, not a throw.
      sideDb
        .prepare(
          `INSERT INTO channel_meta (room_id, members_json, updated_at) VALUES (?, ?, ?)`,
        )
        .run('!room-garbage:matrix.test', 'not-json', Date.now());
      expect(repo.getMembers('!room-garbage:matrix.test')).toEqual([]);
    } finally {
      sideDb.close();
    }
  });

  it('findRollupCandidates groups by bucket and respects minChunksPerBucket', () => {
    const roomR = '!room-rollup:matrix.test';
    const DAY = 24 * 60 * 60 * 1000;
    const BUCKET = 7 * DAY;
    // Bucket starting at 0: 3 chunks → eligible
    // Bucket starting at 7d: 1 chunk → skipped by min=2
    repo.insertChunk(
      makeChunk({ id: 'b0-1', roomId: roomR, toTimestamp: DAY }),
    );
    repo.insertChunk(
      makeChunk({ id: 'b0-2', roomId: roomR, toTimestamp: 2 * DAY }),
    );
    repo.insertChunk(
      makeChunk({ id: 'b0-3', roomId: roomR, toTimestamp: 3 * DAY }),
    );
    repo.insertChunk(
      makeChunk({ id: 'b1-1', roomId: roomR, toTimestamp: 8 * DAY }),
    );

    const candidates = repo.findRollupCandidates(roomR, {
      sourceTier: 1,
      olderThanTs: 100 * DAY,
      bucketMs: BUCKET,
      minChunksPerBucket: 2,
    });
    expect(candidates).toHaveLength(1);
    expect(candidates[0]?.toTier).toBe(2);
    expect(candidates[0]?.chunks.map((c) => c.id).sort()).toEqual([
      'b0-1',
      'b0-2',
      'b0-3',
    ]);
  });

  it('replaceWithRollup deletes sources + inserts the rollup atomically', () => {
    const roomR = '!room-replace:matrix.test';
    repo.insertChunk(makeChunk({ id: 'src-1', roomId: roomR }));
    repo.insertChunk(makeChunk({ id: 'src-2', roomId: roomR }));

    const rollup = makeChunk({
      id: 'rollup-1',
      roomId: roomR,
      tier: 2,
      summary: 'consolidated summary',
    });
    repo.replaceWithRollup(['src-1', 'src-2'], rollup);

    const all = repo.recentChunks(roomR, 10, 2);
    expect(all.map((c) => c.id)).toEqual(['rollup-1']);
    expect(repo.recentChunks(roomR, 10)).toHaveLength(0); // tier-1 gone
  });

  it('checkpoint() does not throw', () => {
    expect(() => repo.checkpoint()).not.toThrow();
  });

  it('listRoomIds returns distinct rooms across both tables', () => {
    // Add a room only in channel_meta, plus we already have rooms from chunks above.
    repo.upsertMembers(ROOM_B, [
      { matrixUserId: '@solo:matrix.test', displayName: 'Solo' },
    ]);

    const rooms = repo.listRoomIds();
    expect(rooms).toContain(ROOM_A);
    expect(rooms).toContain(ROOM_B);
    // Distinct — no duplicates.
    expect(new Set(rooms).size).toBe(rooms.length);
  });
});

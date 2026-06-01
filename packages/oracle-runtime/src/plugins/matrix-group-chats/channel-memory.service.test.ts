import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ChannelMemoryService } from './channel-memory.service.js';
import { type Summarizer } from './channel-memory.summarizer.js';
import { type ObservedMessage } from './channel-memory.types.js';

const ROOM = '!room-svc:matrix.test';

const makeMsg = (i: number): ObservedMessage => ({
  eventId: `$evt-${i}`,
  threadId: `thread-${i % 3}`,
  senderDid: `did:ixo:sender-${i % 2}`,
  senderMatrixUserId: `@user${i % 2}:matrix.test`,
  senderDisplayName: i % 2 === 0 ? 'Alice' : 'Bob',
  body: `message body ${i}`,
  timestamp: 1_000 + i,
});

function makeFakeSummarizer(): Summarizer & {
  summarize: ReturnType<typeof vi.fn>;
  rollup: ReturnType<typeof vi.fn>;
} {
  return {
    summarize: vi.fn(async () => 'mock summary'),
    rollup: vi.fn(async () => 'mock rollup'),
  };
}

async function newService(opts: {
  tmpDir: string;
  summarizer?: Summarizer;
}): Promise<ChannelMemoryService> {
  ChannelMemoryService.resetSingleton();
  const summarizer = opts.summarizer ?? makeFakeSummarizer();
  const svc = new ChannelMemoryService(
    null,
    {
      dbPath: opts.tmpDir,
      syncDebounceMs: 60_000,
      matrixSyncDisabled: true,
      oracleDid: 'did:ixo:test-oracle',
    },
    summarizer,
  );
  svc.onModuleInit();
  return svc;
}

describe('ChannelMemoryService', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'channel-memory-svc-'));
  });

  afterEach(async () => {
    ChannelMemoryService.resetSingleton();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('observeMessage with 20 msgs triggers compaction → one chunk persisted', async () => {
    const summarizer = makeFakeSummarizer();
    const svc = await newService({ tmpDir, summarizer });

    for (let i = 0; i < 20; i++) {
      svc.observeMessage(ROOM, makeMsg(i));
    }

    // Wait for the threshold-triggered compaction promise to settle.
    // `compact` is fire-and-forget — exposed only through internal in-flight map.
    // The simplest reliable wait: poll until there's exactly one chunk.
    await vi.waitFor(
      async () => {
        const chunks = await svc.recentChunks(ROOM);
        expect(chunks).toHaveLength(1);
      },
      { timeout: 2000, interval: 25 },
    );

    expect(summarizer.summarize).toHaveBeenCalledTimes(1);
    const chunks = await svc.recentChunks(ROOM);
    expect(chunks[0]?.summary).toBe('mock summary');
    expect(chunks[0]?.messageCount).toBe(20);
    expect(chunks[0]?.tier).toBe(1);

    await svc.onModuleDestroy();
  });

  it('compactJustInTime races within 3s and drains the buffer when above the JIT min', async () => {
    const summarizer = makeFakeSummarizer();
    const svc = await newService({ tmpDir, summarizer });

    for (let i = 0; i < 10; i++) {
      svc.observeMessage(ROOM, makeMsg(i));
    }

    const start = Date.now();
    await svc.compactJustInTime(ROOM);
    const elapsed = Date.now() - start;
    expect(elapsed).toBeLessThan(3000);

    expect(summarizer.summarize).toHaveBeenCalledTimes(1);
    const chunks = await svc.recentChunks(ROOM);
    expect(chunks).toHaveLength(1);
    expect(chunks[0]?.messageCount).toBe(10);

    await svc.onModuleDestroy();
  });

  it('compactJustInTime is a no-op when buffer is below the JIT min', async () => {
    const summarizer = makeFakeSummarizer();
    const svc = await newService({ tmpDir, summarizer });

    // 4 messages — below the COMPACT_JIT_MIN of 5.
    for (let i = 0; i < 4; i++) {
      svc.observeMessage(ROOM, makeMsg(i));
    }

    await svc.compactJustInTime(ROOM);
    expect(summarizer.summarize).not.toHaveBeenCalled();
    expect(await svc.recentChunks(ROOM)).toHaveLength(0);

    await svc.onModuleDestroy();
  });

  it('pinFact / unpinFact end-to-end', async () => {
    const svc = await newService({ tmpDir });

    const pinned = await svc.pinFact({
      roomId: ROOM,
      fact: 'Friday is the launch date',
      pinnedByDid: 'did:ixo:alice',
    });
    expect(pinned.id).toBeTruthy();
    expect(pinned.fact).toBe('Friday is the launch date');

    const facts = await svc.listPinnedFacts(ROOM);
    expect(facts.map((f) => f.fact)).toEqual(['Friday is the launch date']);

    const ok = await svc.unpinFact(ROOM, pinned.id);
    expect(ok).toBe(true);
    expect(await svc.listPinnedFacts(ROOM)).toHaveLength(0);

    expect(await svc.unpinFact(ROOM, 'does-not-exist')).toBe(false);

    await svc.onModuleDestroy();
  });

  it('rollupTier consolidates two tier-1 chunks into one tier-2', async () => {
    const summarizer = makeFakeSummarizer();
    const svc = await newService({ tmpDir, summarizer });

    // Generate two tier-1 chunks via two threshold-triggered compactions.
    for (let i = 0; i < 20; i++) svc.observeMessage(ROOM, makeMsg(i));
    await vi.waitFor(async () =>
      expect((await svc.recentChunks(ROOM)).length).toBe(1),
    );
    for (let i = 20; i < 40; i++) svc.observeMessage(ROOM, makeMsg(i));
    await vi.waitFor(async () =>
      expect((await svc.recentChunks(ROOM)).length).toBe(2),
    );

    const DAY = 24 * 60 * 60 * 1000;
    const olderThan = Date.now() + DAY; // all chunks count as "old"
    const rolled = await svc.rollupTier(ROOM, 1, olderThan, 7 * DAY, 2);
    expect(rolled).toBe(2);
    expect(summarizer.rollup).toHaveBeenCalledTimes(1);

    const tier1 = await svc.recentChunks(ROOM);
    expect(tier1).toHaveLength(0);

    // Tier-2 lookup is plumbed through recentChunks with explicit tier arg
    // on the repo — go through the service's public ChannelMemoryRepo via
    // listOpenRoomIds + member of rooms — easier path: search returns
    // tier-2 too (FTS doesn't filter by tier).
    const found = await svc.search(ROOM, 'mock', 10);
    const tier2 = found.filter((c) => c.tier === 2);
    expect(tier2).toHaveLength(1);
    expect(tier2[0]?.summary).toBe('mock rollup');

    await svc.onModuleDestroy();
  });

  it('listOpenRoomIds lists rooms whose DB has been opened', async () => {
    const svc = await newService({ tmpDir });

    expect(svc.listOpenRoomIds()).toEqual([]);

    await svc.pinFact({
      roomId: ROOM,
      fact: 'open the room',
      pinnedByDid: 'did:ixo:alice',
    });
    expect(svc.listOpenRoomIds()).toEqual([ROOM]);

    await svc.onModuleDestroy();
  });

  it('singleton accessor returns the running instance and clears on destroy', async () => {
    const svc = await newService({ tmpDir });
    expect(ChannelMemoryService.getInstance()).toBe(svc);
    await svc.onModuleDestroy();
    expect(ChannelMemoryService.getInstance()).toBeUndefined();
  });
});

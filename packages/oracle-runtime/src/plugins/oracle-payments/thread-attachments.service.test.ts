import { describe, expect, it, vi } from 'vitest';
import {
  filterThreadAttachments,
  type ThreadAttachment,
  type TimelineMessage,
} from '../../matrix/room-file.js';
import { ThreadAttachmentService } from './thread-attachments.service.js';
import {
  makeCommerceCtx,
  ROOM_ID,
  THREAD_ID,
} from './__test-fixtures__/oracle-payments-fixtures.js';

const OTHER_THREAD = '$other-thread:ixo.world';

/** One room timeline holding two threads plus a room-level file. */
const TIMELINE: TimelineMessage[] = [
  {
    eventId: THREAD_ID,
    sender: '@u:ixo.world',
    body: 'brief.pdf',
    timestamp: 1_700_000_000_000,
    msgtype: 'm.file',
  },
  {
    eventId: '$in-thread',
    sender: '@u:ixo.world',
    body: 'receipts.csv',
    timestamp: 1_700_000_060_000,
    threadId: THREAD_ID,
    msgtype: 'm.file',
  },
  {
    eventId: '$other-thread-file',
    sender: '@u:ixo.world',
    body: 'secret.pdf',
    timestamp: 1_700_000_120_000,
    threadId: OTHER_THREAD,
    msgtype: 'm.file',
  },
  {
    eventId: '$room-level-file',
    sender: '@u:ixo.world',
    body: 'stray.png',
    timestamp: 1_700_000_180_000,
    msgtype: 'm.image',
  },
  {
    eventId: '$in-thread-text',
    sender: '@u:ixo.world',
    body: 'here you go',
    timestamp: 1_700_000_240_000,
    threadId: THREAD_ID,
    msgtype: 'm.text',
  },
];

/**
 * A service whose Matrix read is the real thread filter over `timeline`, so
 * the scoping rule is exercised end-to-end rather than stubbed away.
 */
function makeService(timeline: TimelineMessage[] = TIMELINE) {
  const listAttachments = vi.fn(
    async (_roomId: string, threadId: string): Promise<ThreadAttachment[]> =>
      filterThreadAttachments(timeline, threadId),
  );
  return {
    service: new ThreadAttachmentService({ listAttachments }),
    listAttachments,
  };
}

describe('filterThreadAttachments', () => {
  it('keeps only media from this thread (plus the thread root)', () => {
    expect(
      filterThreadAttachments(TIMELINE, THREAD_ID).map((a) => a.eventId),
    ).toEqual([THREAD_ID, '$in-thread']);
  });

  it('accepts every media msgtype the bridge coalesces', () => {
    const media = ['m.file', 'm.image', 'm.video', 'm.audio'].map(
      (msgtype, i) => ({
        eventId: `$${msgtype}`,
        sender: '@u:ixo.world',
        body: `file-${i}`,
        timestamp: i,
        threadId: THREAD_ID,
        msgtype,
      }),
    );
    expect(filterThreadAttachments(media, THREAD_ID)).toHaveLength(4);
  });
});

describe('ThreadAttachmentService', () => {
  it("lists this thread's attachments with their archived sandbox paths", async () => {
    const { service, listAttachments } = makeService();

    const result = await service.list(makeCommerceCtx());

    expect(listAttachments).toHaveBeenCalledWith(ROOM_ID, THREAD_ID);
    expect(result.attachments).toEqual([
      {
        eventId: THREAD_ID,
        fileName: 'brief.pdf',
        mimetype: 'application/pdf',
        sharedAt: new Date(1_700_000_000_000).toISOString(),
        sandboxPath: '/workspace/output/brief.pdf',
      },
      {
        eventId: '$in-thread',
        fileName: 'receipts.csv',
        mimetype: 'text/csv',
        sharedAt: new Date(1_700_000_060_000).toISOString(),
        sandboxPath: '/workspace/output/receipts.csv',
      },
    ]);
    expect(result.note).toMatch(/best-effort/);
  });

  it('never surfaces a file shared in another thread of the same room', async () => {
    const { service } = makeService();

    const result = await service.list(makeCommerceCtx());

    const names = result.attachments.map((a) => a.fileName);
    expect(names).not.toContain('secret.pdf');
    expect(names).not.toContain('stray.png');
  });

  it("reports the archive's own sanitized path, not a raw file name", async () => {
    // `sanitizeAttachmentFilename` — the function the archive itself writes
    // with — strips bracket sequences, so the reported path must too.
    const { service } = makeService([
      {
        eventId: '$odd-name',
        sender: '@u:ixo.world',
        body: 're[po]rt.pdf',
        timestamp: 1_700_000_300_000,
        threadId: THREAD_ID,
        msgtype: 'm.file',
      },
    ]);

    const result = await service.list(makeCommerceCtx());

    expect(result.attachments[0]?.sandboxPath).toBe(
      '/workspace/output/report.pdf',
    );
  });

  it('says so plainly when nothing was shared in this thread', async () => {
    const { service } = makeService([]);

    const result = await service.list(makeCommerceCtx());

    expect(result.attachments).toEqual([]);
    expect(result.note).toMatch(/No files have been shared in this thread/);
  });

  it('degrades to a note when the timeline cannot be read', async () => {
    const warn = vi.fn();
    const service = new ThreadAttachmentService({
      listAttachments: async () => {
        throw new Error('matrix down');
      },
      logger: { log: vi.fn(), error: vi.fn(), warn, debug: vi.fn() },
    });

    const result = await service.list(makeCommerceCtx());

    expect(result.attachments).toEqual([]);
    expect(result.note).toMatch(/could not be read/);
    // The reason reaches the agent too, not just the operator's log.
    expect(result.note).toContain('matrix down');
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('matrix down'));
  });

  it('degrades to a note outside a Matrix room', async () => {
    const { service, listAttachments } = makeService();
    const ctx = makeCommerceCtx();
    ctx.session.roomId = undefined;

    const result = await service.list(ctx);

    expect(result.attachments).toEqual([]);
    expect(result.note).toMatch(/not a Matrix thread/);
    expect(listAttachments).not.toHaveBeenCalled();
  });
});

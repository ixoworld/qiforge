import { Logger as NestLogger } from '@nestjs/common';
import {
  listThreadAttachments,
  type ThreadAttachment,
} from '../../matrix/room-file.js';
import { archivedAttachmentPath } from '../../modules/messages/attachment-archive.js';
import type { Logger, RuntimeContext } from '../../plugin-api/types.js';
import { inferMimeFromPath } from '../sandbox/sandbox-bridge.js';
import { errorMessage } from './util.js';

/** Shown when the turn has no Matrix room — nothing was shared in a thread. */
const NO_ROOM_NOTE =
  'This conversation is not a Matrix thread, so there are no shared files to look up.';

/** Shown for an empty thread — never a claim that the user sent nothing at all. */
const NOTHING_SHARED_NOTE =
  'No files have been shared in this thread yet. If the user did send one, ask them to send it again.';

/**
 * Shown when the timeline read failed — degraded, not "there are no files".
 * Carries the failure itself: "I cannot tell" with no reason is what makes the
 * agent invent one.
 */
function readFailedNote(detail: string): string {
  return (
    `The thread history could not be read just now (${detail}), so I cannot tell which files were ` +
    'shared. Say so rather than telling the user they shared nothing, and ask them to resend the ' +
    'file if you need it.'
  );
}

/**
 * Attached to every non-empty listing: the archive that puts these files in
 * the sandbox is fire-and-forget, so a listed path can be missing.
 */
const ARCHIVE_CAVEAT =
  'Each file was archived to its sandboxPath in the background. Archiving is best-effort, so a listed file may not be present — if reading its path fails, ask the user to send the file again.';

/** One file shared in this thread, as the tool reports it. */
export interface ThreadAttachmentEntry {
  /** The Matrix event body — the name the file was shared under. */
  fileName: string;
  /**
   * Inferred from the file name: the room timeline carries the msgtype, not
   * the original `info.mimetype`.
   */
  mimetype: string;
  /** Matrix event id of the message that carried the file. */
  eventId: string;
  /** ISO timestamp of when it was sent. */
  sharedAt: string;
  /** Where the runtime archived it, using the archive's own naming. */
  sandboxPath: string;
}

/** What `get_thread_attachment` returns — always an object, never a throw. */
export interface ThreadAttachmentListing {
  attachments: ThreadAttachmentEntry[];
  note: string;
}

/** Thread-scoped Matrix reads, injected so tests never touch a live room. */
export interface ThreadAttachmentDeps {
  listAttachments?: (
    roomId: string,
    threadId: string,
  ) => Promise<ThreadAttachment[]>;
  logger?: Logger;
}

/**
 * Backs `get_thread_attachment`: answers "what did the user share in THIS
 * thread", which the sandbox alone cannot — the archive under
 * `/workspace/output` is per-user and accumulates every file from every thread
 * and every past job. Scoping is the whole point, so the listing comes from
 * the thread's own Matrix timeline.
 *
 * Nothing is downloaded or written: the runtime already archived each
 * attachment, so each entry carries the sandbox path the agent reads with the
 * sandbox tools.
 */
export class ThreadAttachmentService {
  private readonly listAttachments: NonNullable<
    ThreadAttachmentDeps['listAttachments']
  >;

  private readonly logger: Logger;

  constructor(deps: ThreadAttachmentDeps = {}) {
    this.listAttachments = deps.listAttachments ?? listThreadAttachments;
    this.logger = deps.logger ?? new NestLogger(ThreadAttachmentService.name);
  }

  async list(ctx: RuntimeContext): Promise<ThreadAttachmentListing> {
    const roomId = ctx.session.roomId;
    if (!roomId) {
      return { attachments: [], note: NO_ROOM_NOTE };
    }

    // The Matrix thread root doubles as the session id, so the session already
    // identifies the thread the turn belongs to.
    const threadId = ctx.session.id;

    let attachments: ThreadAttachment[];
    try {
      attachments = await this.listAttachments(roomId, threadId);
    } catch (error) {
      const detail = errorMessage(error);
      this.logger.warn(
        `[oracle-payments] thread attachment listing failed for ${roomId}/${threadId}: ${detail}`,
      );
      return { attachments: [], note: readFailedNote(detail) };
    }

    if (attachments.length === 0) {
      return { attachments: [], note: NOTHING_SHARED_NOTE };
    }

    return {
      attachments: attachments.map((a) => ({
        fileName: a.fileName,
        mimetype: inferMimeFromPath(a.fileName),
        eventId: a.eventId,
        sharedAt: new Date(a.timestamp).toISOString(),
        sandboxPath: archivedAttachmentPath(a.fileName),
      })),
      note: ARCHIVE_CAVEAT,
    };
  }
}

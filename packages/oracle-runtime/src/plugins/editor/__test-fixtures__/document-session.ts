/**
 * Offline stand-ins for the two narrow interfaces the editor's write path needs
 * from Matrix, so the guards and the tools can be exercised against a plain
 * `Y.Doc`. Shared by `content-session.test.ts` and `content-tools.test.ts`.
 *
 * Not a `*.test.ts` file — no assertions here.
 */

import * as Y from 'yjs';
import type {
  DocumentSession,
  DocumentWriter,
  RoomStateReader,
} from '../content-session.js';

export const ORACLE_USER_ID = '@oracle:mx.test';
export const TEST_ROOM_ID = '!doc:mx.test';

export interface WriterStub extends DocumentWriter {
  /** How many times the write path awaited a flush. */
  flushes: number;
}

export interface WriterStubOptions {
  /** Start out unable to write (a previous write was already rejected). */
  canWrite?: boolean;
  /** Flip to un-writable during the flush, as an M_FORBIDDEN response does. */
  rejectOnFlush?: boolean;
  /** Never settle the flush, to exercise the bounded wait. */
  hang?: boolean;
}

export function makeWriterStub(options: WriterStubOptions = {}): WriterStub {
  let writable = options.canWrite ?? true;
  const stub: WriterStub = {
    flushes: 0,
    get canWrite() {
      return writable;
    },
    async waitForFlush() {
      stub.flushes += 1;
      if (options.hang) {
        await new Promise<void>(() => {
          /* never settles */
        });
      }
      if (options.rejectOnFlush) writable = false;
    },
  };
  return stub;
}

export function makeStateReader(
  powerLevels: Record<string, unknown> | Error | null,
  roomName?: string,
): RoomStateReader {
  return {
    getUserId: () => ORACLE_USER_ID,
    // Dispatches on `eventType` because the write path reads two different
    // state events: `m.room.power_levels` for the write guard and
    // `m.room.name` to seed an untitled document.
    getStateEvent: async (_roomId: string, eventType: string) => {
      if (eventType === 'm.room.name') {
        return roomName === undefined ? {} : { name: roomName };
      }
      if (powerLevels instanceof Error) throw powerLevels;
      return powerLevels ?? {};
    },
  };
}

/** A collaborative room the oracle has NOT been granted access to. */
export const UNGRANTED_POWER_LEVELS: Record<string, unknown> = {
  users_default: 0,
  events_default: 50,
  users: { '@someone-else:mx.test': 100 },
};

/** The same room after `grant_assistant_access` put the oracle at 60. */
export const GRANTED_POWER_LEVELS: Record<string, unknown> = {
  users_default: 0,
  events_default: 50,
  users: { [ORACLE_USER_ID]: 60 },
};

export interface SessionStubOptions {
  doc?: Y.Doc;
  writer?: WriterStub;
  powerLevels?: Record<string, unknown> | Error | null;
  roomId?: string;
  alias?: string;
  isFlow?: boolean;
  /** `m.room.name` for the room, which seeds an untitled document's title. */
  roomName?: string;
}

export interface SessionStub extends DocumentSession {
  writer: WriterStub;
}

export function makeSessionStub(options: SessionStubOptions = {}): SessionStub {
  const writer = options.writer ?? makeWriterStub();
  return {
    doc: options.doc ?? new Y.Doc(),
    provider: writer,
    matrixClient: makeStateReader(
      options.powerLevels === undefined
        ? GRANTED_POWER_LEVELS
        : options.powerLevels,
      options.roomName,
    ),
    roomId: options.roomId ?? TEST_ROOM_ID,
    alias: options.alias,
    isFlow: options.isFlow ?? false,
    writer,
  };
}

/**
 * The output of one run, in order, with a sequence number per frame.
 *
 * Every SSE frame a turn produces (`message`, `reasoning`, `tool_call`,
 * `action_call`, `router.update`, `error`, `done`, plugin-emitted events) is
 * pushed here first. Two things read it:
 *
 *   - **subscribers** — the HTTP response of the turn and every client that
 *     re-joined (`GET /runs/:id?after=<seq>`); each gets the frames after its
 *     cursor and then the live tail;
 *   - **the segment packer** — the unflushed tail is packed into one row of
 *     `turn_run_segments` every `flushMs` or `flushBytes`, and at once for
 *     the frames `immediate` selects (a settled tool result), so a re-join
 *     after the object was reset — or a recovery — can restore the exact
 *     output. Everything else rides the timer: one row per `flushMs` of
 *     output is the write budget, whatever the frame count.
 *
 * Only the unflushed tail lives in memory: a re-join reads older frames from
 * the store (`readSegments`) before it subscribes, so the buffer never grows
 * with the reply. The packer's timer is armed only while there is something
 * to flush and is cleared when the run closes (a pending timer keeps a
 * Durable Object resident — see docs/architecture.md, rules of the road).
 */

export interface RunFrame {
  seq: number;
  event: string;
  data: unknown;
}

export interface PackedSegment {
  seqFrom: number;
  seqTo: number;
  /** JSON array of `{ seq, event, data }`. */
  payload: string;
}

export interface RunBufferOptions {
  /** Max age of the unflushed tail before it is packed (ms). */
  flushMs: number;
  /** Max size of the unflushed tail before it is packed (bytes of JSON). */
  flushBytes: number;
  /** Frames packed at once instead of on the timer (a settled tool result must survive a reset). */
  immediate?: (event: string, data: unknown) => boolean;
  /** Persist one packed segment. Errors are reported through `onPackError`. */
  onPack: (segment: PackedSegment) => Promise<void> | void;
  onPackError?: (error: unknown) => void;
  now?: () => number;
  /** Timer hooks (tests use fakes). */
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (handle: unknown) => void;
  /**
   * Sequence number the first frame continues from (a resumed run keeps
   * numbering after the frames its earlier attempt packed, so a client's
   * cursor stays valid across the reset).
   */
  startSeq?: number;
}

export type RunSubscriber = (frame: RunFrame) => void;

/** Assistant text accumulated over `message` frames — the reply so far. */
export function partialTextOf(frames: Iterable<RunFrame>): string {
  let text = '';
  for (const frame of frames) {
    if (frame.event !== 'message') continue;
    const content = (frame.data as { content?: unknown } | undefined)?.content;
    if (typeof content === 'string') text += content;
  }
  return text;
}

/** Decode the frames of packed segments, in order, keeping only `seq > after`. */
export function framesOfSegments(
  segments: Iterable<Pick<PackedSegment, 'payload'>>,
  after = 0,
): RunFrame[] {
  const out: RunFrame[] = [];
  for (const segment of segments) {
    const frames = JSON.parse(segment.payload) as RunFrame[];
    for (const frame of frames) if (frame.seq > after) out.push(frame);
  }
  return out;
}

export class RunBuffer {
  private seq = 0;

  /** Frames not yet packed into a segment. */
  private readonly tail: RunFrame[] = [];

  private tailBytes = 0;

  private readonly subscribers = new Set<RunSubscriber>();

  private timer: unknown = null;

  private closed = false;

  private packing: Promise<void> = Promise.resolve();

  /** Highest sequence number packed so far (0 = nothing packed). */
  packedSeq = 0;

  constructor(private readonly options: RunBufferOptions) {
    this.seq = options.startSeq ?? 0;
    this.packedSeq = options.startSeq ?? 0;
  }

  get lastSeq(): number {
    return this.seq;
  }

  get isClosed(): boolean {
    return this.closed;
  }

  /** Append a frame, fan it out, and schedule or force a pack. */
  push(event: string, data: unknown): RunFrame {
    if (this.closed) throw new Error('run buffer is closed');
    const frame: RunFrame = { seq: ++this.seq, event, data };
    this.tail.push(frame);
    this.tailBytes += JSON.stringify(frame).length;
    for (const subscriber of this.subscribers) {
      try {
        subscriber(frame);
      } catch {
        /* a broken subscriber never breaks the run */
      }
    }
    if (
      this.options.immediate?.(event, data) ||
      this.tailBytes >= this.options.flushBytes
    ) {
      void this.flush();
    } else if (this.timer === null) {
      const set = this.options.setTimer ?? setTimeout;
      this.timer = set(() => {
        this.timer = null;
        void this.flush();
      }, this.options.flushMs);
    }
    return frame;
  }

  /**
   * The unflushed frames after `after` — what a re-join needs on top of the
   * segments it read from the store.
   */
  tailAfter(after: number): RunFrame[] {
    return this.tail.filter((frame) => frame.seq > after);
  }

  /**
   * Attach a live subscriber. The caller replays the store's segments and
   * `tailAfter(cursor)` first; from then on every new frame is delivered.
   */
  subscribe(subscriber: RunSubscriber): () => void {
    this.subscribers.add(subscriber);
    return () => {
      this.subscribers.delete(subscriber);
    };
  }

  get subscriberCount(): number {
    return this.subscribers.size;
  }

  /** Pack the unflushed tail into one segment. Serialised; safe to call often. */
  flush(): Promise<void> {
    if (this.timer !== null) {
      (this.options.clearTimer ?? clearTimeout)(this.timer as never);
      this.timer = null;
    }
    if (this.tail.length === 0) return this.packing;
    const frames = this.tail.splice(0, this.tail.length);
    this.tailBytes = 0;
    const segment: PackedSegment = {
      seqFrom: frames[0]!.seq,
      seqTo: frames[frames.length - 1]!.seq,
      payload: JSON.stringify(frames),
    };
    this.packing = this.packing
      .then(() => this.options.onPack(segment))
      .then(() => {
        this.packedSeq = Math.max(this.packedSeq, segment.seqTo);
      })
      .catch((error: unknown) => {
        // The frames stay delivered to live subscribers; only the durable
        // copy is missing. Report and carry on — the next pack retries
        // nothing (the frames are gone) but the run itself is unaffected.
        this.options.onPackError?.(error);
      });
    return this.packing;
  }

  /** Final pack; no more frames accepted afterwards. */
  async close(): Promise<void> {
    if (this.closed) return this.packing;
    this.closed = true;
    await this.flush();
    this.subscribers.clear();
  }
}

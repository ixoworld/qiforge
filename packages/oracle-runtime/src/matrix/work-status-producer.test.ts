import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import {
  humanizeToolLabel,
  WorkStatusProducer,
} from './work-status-producer.js';

const TURN = {
  requestId: 'req-1',
  roomId: '!room:home.server',
  threadId: 'evt-root',
  sessionId: 'evt-root',
  forEventId: 'evt-user-msg',
};

const NOW = new Date('2026-07-22T12:00:00.000Z');

/** Typed view over what the producer posted — parsed, not asserted. */
const postedContentSchema = z.object({
  component: z.string(),
  props: z.record(z.string(), z.unknown()),
  body: z.string(),
  sessionId: z.string(),
  requestId: z.string(),
  'm.relates_to': z
    .object({ rel_type: z.string(), event_id: z.string() })
    .optional(),
});
type PostedContent = z.infer<typeof postedContentSchema>;

interface RecordedPost {
  roomId: string;
  eventType: string;
  content: PostedContent;
}

function makeProducer(
  postEvent?: (
    roomId: string,
    eventType: string,
    content: object,
  ) => Promise<string>,
): {
  producer: WorkStatusProducer;
  posts: RecordedPost[];
  warn: ReturnType<typeof vi.fn>;
} {
  const posts: RecordedPost[] = [];
  let counter = 0;
  const warn = vi.fn();
  const producer = new WorkStatusProducer({
    postEvent:
      postEvent ??
      (async (roomId, eventType, content) => {
        posts.push({
          roomId,
          eventType,
          content: postedContentSchema.parse(content),
        });
        counter += 1;
        return `$status-${counter}`;
      }),
    clock: () => NOW,
    logger: { warn },
  });
  return { producer, posts, warn };
}

/**
 * A producer whose posts hang until released, so tests can observe what the
 * producer does with frames staged behind an in-flight post.
 */
function makeGatedProducer(): {
  producer: WorkStatusProducer;
  posts: RecordedPost[];
  /** Resolve the oldest in-flight post and let the producer drain. */
  releaseNext: () => Promise<void>;
} {
  const posts: RecordedPost[] = [];
  const inFlight: Array<() => void> = [];
  let counter = 0;
  const producer = new WorkStatusProducer({
    postEvent: (roomId, eventType, content) => {
      posts.push({
        roomId,
        eventType,
        content: postedContentSchema.parse(content),
      });
      counter += 1;
      const eventId = `$status-${counter}`;
      return new Promise<string>((resolve) => {
        inFlight.push(() => {
          resolve(eventId);
        });
      });
    },
    clock: () => NOW,
    logger: { warn: vi.fn() },
  });
  return {
    producer,
    posts,
    releaseNext: async () => {
      const resolve = inFlight.shift();
      if (!resolve) throw new Error('no in-flight post to release');
      resolve();
      await flushQueue();
    },
  };
}

/** Drain the producer's internal post queue (chained microtasks). */
async function flushQueue(): Promise<void> {
  for (let i = 0; i < 20; i += 1) await Promise.resolve();
}

/** The `phase` of each post, in order. */
function phases(posts: RecordedPost[]): unknown[] {
  return posts.map((p) => p.content.props.phase);
}

/** The `label` of each post, in order. */
function labels(posts: RecordedPost[]): unknown[] {
  return posts.map((p) => p.content.props.label);
}

describe('WorkStatusProducer', () => {
  it('ignores emissions for unregistered requestIds', async () => {
    const { producer, posts } = makeProducer();

    producer.emit('unknown-req', 'working', 'Doing things…');
    await flushQueue();

    expect(posts).toHaveLength(0);
  });

  it('anchors the first routing emission in-thread with the full props', async () => {
    const { producer, posts } = makeProducer();
    producer.beginTurn(TURN);

    producer.emit('req-1', 'routing');
    await flushQueue();

    expect(posts).toHaveLength(1);
    const post = posts[0]!;
    expect(post.roomId).toBe(TURN.roomId);
    expect(post.eventType).toBe('ixo.oracle.component');
    expect(post.content.component).toBe('work_status');
    expect(post.content.props).toEqual({
      forEventId: 'evt-user-msg',
      phase: 'routing',
      label: 'Routing your request…',
      updatedAt: NOW.toISOString(),
    });
    expect(post.content.sessionId).toBe('evt-root');
    expect(post.content.requestId).toBe('req-1');
    expect(post.content['m.relates_to']).toEqual({
      rel_type: 'm.thread',
      event_id: 'evt-root',
    });
  });

  it('posts later phases as m.replace updates of the anchor', async () => {
    const { producer, posts } = makeProducer();
    producer.beginTurn(TURN);

    // One frame at a time: frames staged while a post is in flight coalesce,
    // and what this test pins is where each post's relation points.
    producer.emit('req-1', 'routing');
    await flushQueue();
    producer.emit('req-1', 'working', 'Generate tax report…');
    await flushQueue();
    producer.emit('req-1', 'delivering');
    await flushQueue();

    expect(posts).toHaveLength(3);
    // Every update replaces the FIRST event (the anchor), not the previous one.
    for (const post of posts.slice(1)) {
      expect(post.content['m.relates_to']).toEqual({
        rel_type: 'm.replace',
        event_id: '$status-1',
      });
    }
    expect(posts[1]!.content.props).toMatchObject({
      phase: 'working',
      label: 'Generate tax report…',
    });
  });

  it('never anchors on a closing phase — a turn with no card posts nothing', async () => {
    const { producer, posts } = makeProducer();
    producer.beginTurn(TURN);

    producer.emit('req-1', 'delivering');
    producer.finish('req-1', 'done');
    await flushQueue();

    expect(posts).toHaveLength(0);
  });

  it('finish posts the final phase and unregisters the turn immediately', async () => {
    const { producer, posts } = makeProducer();
    producer.beginTurn(TURN);
    producer.emit('req-1', 'working');
    producer.finish('req-1', 'superseded');
    // A late emission from the dying turn must be a no-op.
    producer.emit('req-1', 'working', 'Late tool…');
    await flushQueue();

    expect(posts).toHaveLength(2);
    expect(posts[1]!.content.props).toMatchObject({
      phase: 'superseded',
      label: 'Got your new message — restarting',
    });
  });

  it('logs post failures and keeps later emissions working', async () => {
    const posts: RecordedPost[] = [];
    let call = 0;
    const { producer, warn } = makeProducer(
      async (roomId, eventType, content) => {
        call += 1;
        if (call === 1) throw new Error('matrix down');
        posts.push({
          roomId,
          eventType,
          content: postedContentSchema.parse(content),
        });
        return `$ok-${call}`;
      },
    );
    producer.beginTurn(TURN);

    producer.emit('req-1', 'routing');
    await flushQueue();
    producer.emit('req-1', 'working');
    await flushQueue();

    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining('work_status post failed'),
    );
    // The failed post never became the anchor; the next emission anchors.
    expect(posts).toHaveLength(1);
    expect(posts[0]!.content['m.relates_to']).toEqual({
      rel_type: 'm.thread',
      event_id: 'evt-root',
    });
  });

  it('numbers steps within the turn as `Step {n} · {action}`', async () => {
    const { producer, posts } = makeProducer();
    producer.beginTurn(TURN);

    producer.step('req-1', 'Thinking…');
    await flushQueue();
    producer.step('req-1', 'Search skills…');
    await flushQueue();
    producer.step('req-1', 'Generate tax report…');
    await flushQueue();

    expect(labels(posts)).toEqual([
      'Step 1 · Thinking…',
      'Step 2 · Search skills…',
      'Step 3 · Generate tax report…',
    ]);
    expect(phases(posts)).toEqual(['working', 'working', 'working']);
  });

  it('counts steps per turn, not per producer', async () => {
    const { producer, posts } = makeProducer();
    producer.beginTurn(TURN);
    producer.beginTurn({
      ...TURN,
      requestId: 'req-2',
      threadId: 'evt-root-2',
      sessionId: 'evt-root-2',
    });

    producer.step('req-1', 'Thinking…');
    await flushQueue();
    producer.step('req-1', 'Search skills…');
    await flushQueue();
    producer.step('req-2', 'Thinking…');
    await flushQueue();

    expect(labels(posts)).toEqual([
      'Step 1 · Thinking…',
      'Step 2 · Search skills…',
      'Step 1 · Thinking…',
    ]);
    expect(posts.map((p) => p.content.requestId)).toEqual([
      'req-1',
      'req-1',
      'req-2',
    ]);
  });

  it('ignores steps for unregistered requestIds', async () => {
    const { producer, posts } = makeProducer();

    producer.step('unknown-req', 'Thinking…');
    await flushQueue();

    expect(posts).toHaveLength(0);
  });

  it('coalesces frames staged behind an in-flight post — newest wins', async () => {
    const { producer, posts, releaseNext } = makeGatedProducer();
    producer.beginTurn(TURN);

    producer.emit('req-1', 'routing');
    await flushQueue();
    expect(posts).toHaveLength(1);

    // Three steps land while the anchor post is still in flight. They must
    // collapse into a single post carrying the newest label.
    producer.step('req-1', 'Thinking…');
    producer.step('req-1', 'Search skills…');
    producer.step('req-1', 'Generate tax report…');
    await flushQueue();
    expect(posts).toHaveLength(1);

    await releaseNext();

    expect(posts).toHaveLength(2);
    expect(posts[1]!.content.props).toMatchObject({
      phase: 'working',
      // Steps 1 and 2 were never posted — the counter tracks work, not cards.
      label: 'Step 3 · Generate tax report…',
    });
  });

  it('never drops the anchor when frames coalesce behind it', async () => {
    const { producer, posts, releaseNext } = makeGatedProducer();
    producer.beginTurn(TURN);

    producer.emit('req-1', 'routing');
    producer.step('req-1', 'Thinking…');
    producer.finish('req-1', 'done');
    await flushQueue();

    // The anchor is the first post of the turn, so it can never be the frame
    // that gets replaced — only frames waiting behind it are.
    expect(posts).toHaveLength(1);
    expect(posts[0]!.content.props).toMatchObject({ phase: 'routing' });
    expect(posts[0]!.content['m.relates_to']).toEqual({
      rel_type: 'm.thread',
      event_id: 'evt-root',
    });

    await releaseNext();

    expect(phases(posts)).toEqual(['routing', 'done']);
    expect(posts[1]!.content['m.relates_to']).toEqual({
      rel_type: 'm.replace',
      event_id: '$status-1',
    });
  });

  it('lands the terminal phase even when finish arrives mid-post', async () => {
    const { producer, posts, releaseNext } = makeGatedProducer();
    producer.beginTurn(TURN);

    producer.emit('req-1', 'routing');
    await flushQueue();
    await releaseNext();

    producer.step('req-1', 'Search skills…');
    await flushQueue();
    expect(posts).toHaveLength(2);

    // Staged behind the in-flight step post, then superseded by `finish`.
    producer.step('req-1', 'Generate tax report…');
    producer.finish('req-1', 'done');
    await flushQueue();
    expect(posts).toHaveLength(2);

    await releaseNext();

    expect(phases(posts)).toEqual(['routing', 'working', 'done']);
    expect(posts[2]!.content.props).toMatchObject({
      phase: 'done',
      label: 'Done',
    });
  });

  it('endTurn unregisters without posting', async () => {
    const { producer, posts } = makeProducer();
    producer.beginTurn(TURN);
    producer.endTurn('req-1');

    producer.emit('req-1', 'working');
    await flushQueue();

    expect(posts).toHaveLength(0);
  });
});

describe('humanizeToolLabel', () => {
  it('turns snake_case tool names into sentence labels', () => {
    expect(humanizeToolLabel('generate_tax_report')).toBe(
      'Generate tax report…',
    );
    expect(humanizeToolLabel('list-services')).toBe('List services…');
  });

  it('falls back to the working default for empty names', () => {
    expect(humanizeToolLabel('')).toBe('Working…');
  });
});

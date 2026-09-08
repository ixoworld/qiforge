/**
 * `work_status` liveness card: the producer's anchor/replace/coalesce
 * semantics over a fake poster, and the middleware's per-step emissions.
 */
import { describe, expect, it } from 'vitest';
import {
  buildOracleComponentContent,
  humanizeToolLabel,
  ORACLE_COMPONENT_EVENT_TYPE,
  WorkStatusProducer,
  type OracleComponentEventContent,
} from '../../matrix/work-status';
import { createWorkStatusMiddleware } from './work-status';

interface Posted {
  roomId: string;
  type: string;
  content: OracleComponentEventContent;
}

function makeProducer(opts: { failFirst?: boolean } = {}) {
  const posted: Posted[] = [];
  let release: (() => void) | null = null;
  let seq = 0;
  let failed = false;
  const producer = new WorkStatusProducer({
    postEvent: async (roomId, type, content) => {
      if (opts.failFirst && !failed) {
        failed = true;
        throw new Error('homeserver down');
      }
      posted.push({
        roomId,
        type,
        content: content as OracleComponentEventContent,
      });
      // Hold the post until the test releases it, to prove coalescing.
      await new Promise<void>((resolve) => {
        release = resolve;
      });
      seq += 1;
      return `$evt${seq}`;
    },
    clock: () => new Date('2026-09-02T12:00:00.000Z'),
  });
  const flush = async (): Promise<void> => {
    // Release every held post until nothing is in flight.
    for (let i = 0; i < 20; i += 1) {
      await Promise.resolve();
      if (release) {
        const r: () => void = release;
        release = null;
        r();
      }
      await Promise.resolve();
      await Promise.resolve();
    }
  };
  return { producer, posted, flush };
}

const TURN = {
  requestId: 'req-1',
  roomId: '!room:mx',
  threadId: '$thread',
  sessionId: 'thread:$thread',
  forEventId: '$user-msg',
};

describe('WorkStatusProducer', () => {
  it('anchors the card in the thread on the first routing/working frame, then edits it in place', async () => {
    const { producer, posted, flush } = makeProducer();
    producer.beginTurn(TURN);
    producer.emit('req-1', 'routing');
    await flush();
    producer.finish('req-1', 'done');
    await flush();

    expect(posted).toHaveLength(2);
    expect(posted[0]!.type).toBe(ORACLE_COMPONENT_EVENT_TYPE);
    expect(posted[0]!.content).toMatchObject({
      component: 'work_status',
      props: {
        forEventId: '$user-msg',
        phase: 'routing',
        label: 'Routing your request…',
        updatedAt: '2026-09-02T12:00:00.000Z',
      },
      body: 'Status: Routing your request…',
      sessionId: 'thread:$thread',
      requestId: 'req-1',
      'm.relates_to': { rel_type: 'm.thread', event_id: '$thread' },
    });
    // The second frame replaces the anchor and repeats the envelope in m.new_content.
    expect(posted[1]!.content['m.relates_to']).toEqual({
      rel_type: 'm.replace',
      event_id: '$evt1',
    });
    expect(posted[1]!.content['m.new_content']).toMatchObject({
      props: { phase: 'done', label: 'Done' },
    });
    expect(producer.has('req-1')).toBe(false);
  });

  it('coalesces frames staged behind an in-flight post, never dropping the terminal one', async () => {
    const { producer, posted, flush } = makeProducer();
    producer.beginTurn(TURN);
    producer.emit('req-1', 'routing'); // in flight (held)
    producer.step('req-1', 'Thinking…'); // staged
    producer.step('req-1', 'Search skills…'); // replaces the staged frame
    producer.emit('req-1', 'delivering'); // replaces again
    producer.finish('req-1', 'done'); // newest → the one that lands
    await flush();
    expect(posted.map((p) => p.content.props['phase'])).toEqual([
      'routing',
      'done',
    ]);
  });

  it('numbers steps monotonically even when frames are skipped', async () => {
    const { producer, posted, flush } = makeProducer();
    producer.beginTurn(TURN);
    producer.step('req-1', 'Thinking…');
    await flush(); // Step 1 landed, nothing in flight
    producer.step('req-1', 'Read file…'); // Step 2: in flight (held)
    producer.step('req-1', 'Thinking…'); // Step 3: staged
    producer.step('req-1', 'Search skills…'); // Step 4: replaces the staged frame
    await flush();
    expect(posted.map((p) => p.content.props['label'])).toEqual([
      'Step 1 · Thinking…',
      'Step 2 · Read file…',
      'Step 4 · Search skills…',
    ]);
  });

  it('ignores unregistered turns and closing phases with no card', async () => {
    const { producer, posted, flush } = makeProducer();
    producer.emit('nope', 'working');
    producer.beginTurn(TURN);
    producer.finish('req-1', 'done'); // no anchor yet → nothing posted
    await flush();
    expect(posted).toHaveLength(0);
    expect(producer.has('req-1')).toBe(false);
  });

  it('survives a failing homeserver (logs, never throws)', async () => {
    const warnings: string[] = [];
    let attempts = 0;
    const producer = new WorkStatusProducer({
      postEvent: async () => {
        attempts += 1;
        throw new Error('homeserver down');
      },
      anchorRetryDelayMs: 0,
      logger: {
        warn: (m) => {
          warnings.push(m);
        },
      },
    });
    producer.beginTurn(TURN);
    producer.emit('req-1', 'working');
    // The anchor post is retried once (after the delay) before it is given up.
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(attempts).toBe(2);
    expect(warnings.some((w) => /homeserver down/.test(w))).toBe(true);
  });

  it('builds the Node envelope byte-for-byte', () => {
    expect(
      buildOracleComponentContent({
        component: 'work_delivered',
        props: { a: 1 },
        body: 'b',
        sessionId: 's',
        requestId: 'r',
        toolCallId: 'tc',
        threadId: '$t',
      }),
    ).toEqual({
      component: 'work_delivered',
      props: { a: 1 },
      body: 'b',
      sessionId: 's',
      requestId: 'r',
      toolCallId: 'tc',
      'm.relates_to': { rel_type: 'm.thread', event_id: '$t' },
    });
    expect(humanizeToolLabel('generate_tax_report')).toBe(
      'Generate tax report…',
    );
    expect(humanizeToolLabel('')).toBe('Working…');
  });
});

describe('createWorkStatusMiddleware', () => {
  it('emits one step per model call and per tool call, keyed by the run context requestId', async () => {
    const steps: Array<[string, string]> = [];
    const mw = createWorkStatusMiddleware({
      producer: {
        step: (requestId, action) => {
          steps.push([requestId, action]);
        },
      },
    });
    const runtime = { context: { session: { requestId: 'req-9' } } };
    const modelResult = { ok: 'model' };
    const toolResult = { ok: 'tool' };
    const wrapModel = mw.wrapModelCall;
    const wrapTool = mw.wrapToolCall;
    if (!wrapModel || !wrapTool) throw new Error('wrappers missing');
    expect(
      await wrapModel({ runtime } as never, (() => modelResult) as never),
    ).toBe(modelResult);
    expect(
      await wrapTool(
        { runtime, toolCall: { name: 'search_skills' } } as never,
        (() => toolResult) as never,
      ),
    ).toBe(toolResult);
    // No request id in context → pure pass-through.
    expect(
      await wrapModel(
        { runtime: { context: {} } } as never,
        (() => 1) as never,
      ),
    ).toBe(1);
    expect(steps).toEqual([
      ['req-9', 'Thinking…'],
      ['req-9', 'Search skills…'],
    ]);
  });
});

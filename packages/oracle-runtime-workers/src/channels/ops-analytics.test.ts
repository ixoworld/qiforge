import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  CHANNEL_ROUTES,
  OPS_RUNTIME_INDEX,
  channelOpsProvider,
  channelRouteName,
  finishChannelOp,
  noteChannelOp,
  startChannelOp,
  thrownClass,
  timedObjectCall,
  type OpsAnalyticsDataset,
} from './ops-analytics';

type Point = { indexes?: string[]; blobs?: string[]; doubles?: number[] };

function sink() {
  const points: Point[] = [];
  const dataset: OpsAnalyticsDataset = {
    writeDataPoint: (point) => void points.push(point),
  };
  return { points, dataset };
}

afterEach(() => vi.restoreAllMocks());

describe('channel request metrics', () => {
  it('names only the three channel routes, by method and exact path', () => {
    expect(CHANNEL_ROUTES.map((r) => channelRouteName(...split(r)))).toEqual([
      ...CHANNEL_ROUTES,
    ]);
    expect(channelRouteName('GET', '/channels/history')).toBeNull();
    expect(channelRouteName('POST', '/channels/history/')).toBeNull();
    expect(channelRouteName('POST', '/channels/other')).toBeNull();
  });

  it('writes one point in the shared ops layout, the channel in blob8', () => {
    const { points, dataset } = sink();
    const op = startChannelOp('POST /channels/history');
    noteChannelOp(op, {
      provider: 'web',
      limit: 20,
      items: 7,
      plans: 2,
      objectMs: 5,
    });
    finishChannelOp(op, 200, dataset);
    expect(points).toHaveLength(1);
    expect(points[0]!.indexes).toEqual([OPS_RUNTIME_INDEX]);
    expect(points[0]!.blobs).toEqual([
      'http',
      'POST /channels/history',
      'ok',
      '200',
      '',
      '',
      'gateway',
      'web',
      '',
    ]);
    expect(points[0]!.doubles!.slice(1)).toEqual([1, 7, 2, 20, 5]);
    expect(points[0]!.doubles![0]).toBeGreaterThanOrEqual(0);
  });

  it('classifies statuses and keeps fixed codes and class names only', () => {
    const { points, dataset } = sink();
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const write = (
      status: number,
      patch: Parameters<typeof noteChannelOp>[1],
    ) => {
      const op = startChannelOp('POST /channels/turn');
      noteChannelOp(op, patch);
      finishChannelOp(op, status, dataset);
    };
    write(409, {
      provider: 'telegram',
      code: 'session_conflict',
      phase: 'admit',
    });
    write(503, { provider: 'whatsapp', thrown: 'TypeError' });
    write(503, { code: 'not_configured' });
    write(400, { code: 'not a code: did:ixo:ixo1secret' });
    expect(points.map((p) => p.blobs!.slice(2, 5))).toEqual([
      ['client_error', '409', 'session_conflict'],
      ['exception', '503', 'TypeError'],
      ['server_error', '503', 'not_configured'],
      ['client_error', '400', ''],
    ]);
    expect(points.map((p) => [p.blobs![7], p.blobs![8]])).toEqual([
      ['telegram', 'admit'],
      ['whatsapp', ''],
      ['', ''],
      ['', ''],
    ]);
  });

  it('writes a fixed channel name: an unknown provider id is `other`', () => {
    expect(['web', 'whatsapp', 'telegram'].map(channelOpsProvider)).toEqual([
      'web',
      'whatsapp',
      'telegram',
    ]);
    expect(channelOpsProvider('someone_typed_this')).toBe('other');
    expect(channelOpsProvider(undefined)).toBe('');
  });

  it('logs one structured line per refusal or failure, none for a success', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const ok = startChannelOp('POST /channels/history');
    finishChannelOp(ok, 200, undefined);
    expect(warn).not.toHaveBeenCalled();
    expect(error).not.toHaveBeenCalled();

    const refused = startChannelOp('POST /channels/history');
    noteChannelOp(refused, {
      provider: 'web',
      code: 'invalid_cursor',
      limit: 20,
      objectMs: 3,
      requestId: 'web-history:5b0c4f2e-0000-4000-8000-000000000001',
    });
    finishChannelOp(refused, 400, undefined);
    expect(warn).toHaveBeenCalledTimes(1);
    const line = String(warn.mock.calls[0]![0]);
    expect(line.startsWith('[channel-request] ')).toBe(true);
    expect(JSON.parse(line.slice('[channel-request] '.length))).toMatchObject({
      event: 'channels.history',
      status: 400,
      outcome: 'client_error',
      code: 'invalid_cursor',
      provider: 'web',
      objectMs: 3,
      limit: 20,
      requestId: 'web-history:5b0c4f2e-0000-4000-8000-000000000001',
    });

    const failed = startChannelOp('POST /channels/control');
    noteChannelOp(failed, { thrown: 'TypeError', provider: 'whatsapp' });
    finishChannelOp(failed, 503, undefined);
    expect(error).toHaveBeenCalledTimes(1);
    expect(String(error.mock.calls[0]![0])).toContain(
      '"event":"channels.control"',
    );
  });

  it('keeps a request id out of the log unless it is a history read id', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const op = startChannelOp('POST /channels/history');
    noteChannelOp(op, { requestId: 'wa:+27821234567 hello' });
    finishChannelOp(op, 403, undefined);
    expect(String(warn.mock.calls[0]![0])).not.toContain('27821234567');
    expect(String(warn.mock.calls[0]![0])).not.toContain('requestId');
  });

  it('never throws when the dataset does, and still logs', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const op = startChannelOp('POST /channels/turn');
    expect(() =>
      finishChannelOp(op, 429, {
        writeDataPoint: () => {
          throw new Error('over the limit');
        },
      }),
    ).not.toThrow();
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it('times a call made in a thunk, and returns or rethrows exactly what it did', async () => {
    const op = startChannelOp('POST /channels/turn');
    const result = { ok: true };
    expect(await timedObjectCall(op, async () => result)).toBe(result);
    const failure = new TypeError('boom');
    await expect(
      timedObjectCall(op, async () => {
        throw failure;
      }),
    ).rejects.toBe(failure);
    expect(op.objectMs).toBeGreaterThanOrEqual(0);
    // Without an op it is the call itself.
    expect(await timedObjectCall(undefined, async () => result)).toBe(result);
  });

  it('names a thrown value by its class only', () => {
    const error = new Error('did:ixo:ixo1secret failed for +27821234567');
    error.name = 'OwnerCopyUnavailableError';
    expect(thrownClass(error)).toBe('OwnerCopyUnavailableError');
    expect(thrownClass('a string')).toBe('NonError');
    expect(thrownClass(null)).toBe('NonError');
    expect(thrownClass({ name: 'has spaces and did:ixo:x' })).toBe('NonError');
    const hostile = {
      get name(): string {
        throw new Error('nope');
      },
    };
    expect(thrownClass(hostile)).toBe('NonError');
  });
});

function split(route: string): [string, string] {
  const [method, path] = route.split(' ');
  return [method!, path!];
}

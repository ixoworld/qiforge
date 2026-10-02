import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { transcriptionSocket } from './routes';
import type { ClientSink, TranscriptionService } from './service';

class Socket extends EventTarget {
  readyState = 1;
  accept = vi.fn();
  send = vi.fn();
  close = vi.fn();
  emit(data: string | ArrayBuffer) {
    const event = new Event('message');
    Object.defineProperty(event, 'data', { value: data });
    this.dispatchEvent(event);
  }
}
class Pair {
  0 = new Socket();
  1 = new Socket();
  static latest: Pair;
  constructor() {
    Pair.latest = this;
  }
}
class UpgradeResponse {
  status: number;
  webSocket: unknown;
  constructor(_body: unknown, init: { status: number; webSocket?: unknown }) {
    this.status = init.status;
    this.webSocket = init.webSocket;
  }
}
type RelayService = Pick<
  TranscriptionService,
  'attach' | 'audio' | 'stop' | 'disconnect'
>;
function harness() {
  let sink: ClientSink | undefined;
  const service: RelayService = {
    attach: vi
      .fn<RelayService['attach']>()
      .mockImplementation(async (_id, _ticket, _origin, s) => {
        sink = s;
        s.send({ type: 'ready' });
      }),
    audio: vi.fn<RelayService['audio']>().mockResolvedValue(undefined),
    stop: vi.fn<RelayService['stop']>().mockResolvedValue(undefined),
    disconnect: vi
      .fn<RelayService['disconnect']>()
      .mockResolvedValue(undefined),
  };
  const request = new Request(
    'https://oracle.example/transcription/socket?sessionId=12345678',
    { headers: { upgrade: 'websocket', origin: 'https://portal.example' } },
  );
  const response = transcriptionSocket(request, service);
  return { service, socket: Pair.latest[1], response, sink: () => sink };
}
async function flush() {
  for (let i = 0; i < 12; i++) await Promise.resolve();
}
beforeEach(() => {
  vi.useFakeTimers();
  vi.stubGlobal('WebSocketPair', Pair);
  vi.stubGlobal('Response', UpgradeResponse);
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.clearAllTimers();
  vi.useRealTimers();
});

describe('bounded transcription socket protocol', () => {
  it('upgrades, authenticates in first frame, then accepts PCM and explicit stop only', async () => {
    const h = harness();
    expect(h.response.status).toBe(101);
    h.socket.emit(JSON.stringify({ type: 'authenticate', ticket: 'secret' }));
    await flush();
    expect(h.service.attach).toHaveBeenCalledWith(
      '12345678',
      'secret',
      'https://portal.example',
      expect.any(Object),
    );
    const audio = new ArrayBuffer(960);
    h.socket.emit(audio);
    await flush();
    h.socket.emit(JSON.stringify({ type: 'stop' }));
    await flush();
    expect(h.service.audio).toHaveBeenCalledWith('12345678', audio);
    expect(h.service.stop).toHaveBeenCalledWith('12345678', false);
  });
  it.each([
    JSON.stringify({ type: 'session.update', model: 'expensive-model' }),
    new ArrayBuffer(100),
  ])(
    'rejects unauthenticated audio/provider configuration',
    async (message) => {
      const h = harness();
      h.socket.emit(message);
      await flush();
      expect(h.service.attach).not.toHaveBeenCalled();
      expect(h.service.audio).not.toHaveBeenCalled();
      expect(h.socket.close).toHaveBeenCalled();
    },
  );
  it('rejects queued audio before ready instead of buffering pre-authentication input', async () => {
    const h = harness();
    h.socket.emit(JSON.stringify({ type: 'authenticate', ticket: 'secret' }));
    h.socket.emit(new ArrayBuffer(960));
    await flush();
    expect(h.service.audio).not.toHaveBeenCalled();
    expect(h.socket.close).toHaveBeenCalled();
  });
  it('never forwards arbitrary provider JSON after authentication', async () => {
    const h = harness();
    h.socket.emit(JSON.stringify({ type: 'authenticate', ticket: 'secret' }));
    await flush();
    h.socket.emit(JSON.stringify({ type: 'response.create' }));
    await flush();
    expect(h.service.stop).not.toHaveBeenCalled();
    expect(h.socket.close).toHaveBeenCalled();
  });
  it('bounds accumulated PCM awaiting asynchronous processing', async () => {
    const h = harness();
    h.socket.emit(JSON.stringify({ type: 'authenticate', ticket: 'secret' }));
    await flush();
    for (let i = 0; i < 5; i++) h.socket.emit(new ArrayBuffer(24000));
    await flush();
    expect(h.socket.close).toHaveBeenCalled();
    expect(h.service.audio).not.toHaveBeenCalled();
  });
  it('closes idle unauthenticated sockets and binds cancellation to the same socket sink', async () => {
    const h = harness();
    await vi.advanceTimersByTimeAsync(5001);
    expect(h.socket.close).toHaveBeenCalled();
    expect(h.service.disconnect).toHaveBeenCalledWith(
      '12345678',
      expect.any(Object),
    );
  });
});

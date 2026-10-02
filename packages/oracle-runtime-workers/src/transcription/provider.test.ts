import { describe, expect, it, vi } from 'vitest';
import { openTranscriptionProvider, TRANSCRIPTION_URL } from './provider';

class Socket extends EventTarget {
  accept = vi.fn();
  send = vi.fn();
  close = vi.fn();
  emit(value: unknown) {
    const event = new Event('message');
    Object.defineProperty(event, 'data', { value: JSON.stringify(value) });
    this.dispatchEvent(event);
  }
}
const configured = {
  type: 'session.updated',
  session: {
    type: 'transcription',
    audio: {
      input: {
        format: { type: 'audio/pcm', rate: 24000 },
        transcription: { model: 'gpt-live-transcribe' },
        turn_detection: null,
      },
    },
  },
};
async function harness() {
  const socket = new Socket();
  const response = new Response();
  Object.defineProperties(response, {
    status: { value: 101 },
    webSocket: { value: socket },
  });
  const fetcher = vi.fn<typeof fetch>().mockResolvedValue(response);
  const callbacks = { delta: vi.fn(), completed: vi.fn(), failed: vi.fn() };
  const abort = new AbortController();
  const pending = openTranscriptionProvider(
    'test-key',
    callbacks,
    abort.signal,
    fetcher,
  );
  await Promise.resolve();
  return { socket, fetcher, callbacks, abort, pending };
}

describe('OpenAI transcription adapter', () => {
  it('uses the transcription-intent endpoint and locks model, PCM and explicit commit', async () => {
    const h = await harness();
    expect(h.fetcher).toHaveBeenCalledWith(
      TRANSCRIPTION_URL,
      expect.objectContaining({
        headers: {
          Upgrade: 'websocket',
          Authorization: 'Bearer test-key',
        },
      }),
    );
    expect(JSON.parse(h.socket.send.mock.calls[0]?.[0])).toEqual({
      type: 'session.update',
      session: configured.session,
    });
    h.socket.emit(configured);
    const provider = await h.pending;
    provider.append(new Uint8Array([0, 1, 255, 127]).buffer);
    provider.commit();
    provider.commit();
    expect(h.socket.send.mock.calls.map((c) => JSON.parse(c[0]).type)).toEqual([
      'session.update',
      'input_audio_buffer.append',
      'input_audio_buffer.commit',
    ]);
    expect(
      h.socket.send.mock.calls.some((c) => c[0].includes('response.create')),
    ).toBe(false);
    provider.close();
    expect(h.socket.close).toHaveBeenCalled();
  });
  it('rejects a provider acknowledgement with a different session/model/format', async () => {
    const h = await harness();
    h.socket.emit({ ...configured, session: { type: 'realtime' } });
    await expect(h.pending).rejects.toMatchObject({
      code: 'provider_unavailable',
    });
    expect(h.callbacks.failed).toHaveBeenCalled();
  });
  it('replaces cumulative preview and returns actual duration only after commit', async () => {
    const h = await harness();
    h.socket.emit(configured);
    const provider = await h.pending;
    h.socket.emit({
      type: 'conversation.item.input_audio_transcription.delta',
      item_id: 'i1',
      delta: 'Hello',
    });
    h.socket.emit({
      type: 'conversation.item.input_audio_transcription.delta',
      item_id: 'i1',
      delta: ' world',
    });
    expect(h.callbacks.delta.mock.calls).toEqual([['Hello'], ['Hello world']]);
    provider.commit();
    h.socket.emit({
      type: 'conversation.item.input_audio_transcription.completed',
      item_id: 'i1',
      transcript: 'Hello, world.',
      usage: { type: 'duration', seconds: 1.2 },
    });
    expect(h.callbacks.completed).toHaveBeenCalledWith('Hello, world.', 1.2);
    provider.close();
  });
  it.each([
    undefined,
    { type: 'tokens', total_tokens: 2 },
    { type: 'duration', seconds: -1 },
  ])('fails accounting on missing or unexpected usage %s', async (usage) => {
    const h = await harness();
    h.socket.emit(configured);
    const provider = await h.pending;
    provider.commit();
    h.socket.emit({
      type: 'conversation.item.input_audio_transcription.completed',
      item_id: 'i1',
      transcript: 'text',
      usage,
    });
    expect(h.callbacks.completed).not.toHaveBeenCalled();
    expect(h.callbacks.failed).toHaveBeenCalled();
    provider.close();
  });
  it('refuses a completed item before explicit commit or a second unrelated turn', async () => {
    const h = await harness();
    h.socket.emit(configured);
    const provider = await h.pending;
    h.socket.emit({
      type: 'conversation.item.input_audio_transcription.completed',
      item_id: 'i1',
      transcript: 'text',
      usage: { type: 'duration', seconds: 1 },
    });
    expect(h.callbacks.completed).not.toHaveBeenCalled();
    expect(h.callbacks.failed).toHaveBeenCalled();
    provider.close();
  });
  it('aborts a pending handshake and closes the upstream socket', async () => {
    const h = await harness();
    h.abort.abort();
    await expect(h.pending).rejects.toMatchObject({ code: 'cancelled' });
    expect(h.socket.close).toHaveBeenCalled();
  });
  it('does not turn a normal close into a provider error', async () => {
    const h = await harness();
    h.socket.emit(configured);
    const provider = await h.pending;
    provider.close();
    h.socket.dispatchEvent(new Event('close'));
    expect(h.callbacks.failed).not.toHaveBeenCalled();
  });
});

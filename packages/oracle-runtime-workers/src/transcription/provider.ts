import { jsonObject, TranscriptionError } from './protocol';

/** Kept server-side. The browser cannot select a model or change VAD/config. */
export const TRANSCRIPTION_MODEL = 'gpt-live-transcribe';
export const TRANSCRIPTION_URL =
  'https://api.openai.com/v1/realtime?intent=transcription';

export interface TranscriptionProvider {
  append(audio: ArrayBuffer): void;
  commit(): void;
  close(): void;
}

export interface ProviderIdentifiers {
  providerSessionId?: string;
  providerItemId?: string;
  providerRequestId?: string;
}
export interface ProviderCallbacks {
  identified?(identifiers: ProviderIdentifiers): void;
  delta(text: string): void;
  completed(text: string, durationSeconds: number): void;
  failed(): void;
}

/** The only upstream connection; never forwards arbitrary browser JSON. */
export async function openTranscriptionProvider(
  apiKey: string,
  callbacks: ProviderCallbacks,
  signal: AbortSignal,
  fetcher: typeof fetch = fetch,
): Promise<TranscriptionProvider> {
  const response = await fetcher(TRANSCRIPTION_URL, {
    headers: { Upgrade: 'websocket', Authorization: `Bearer ${apiKey}` },
    signal,
  });
  const socket = response.webSocket;
  if (response.status !== 101 || !socket)
    throw new TranscriptionError('provider_unavailable');
  socket.accept();
  const requestId = response.headers.get('x-request-id');
  if (requestId && /^[a-zA-Z0-9_-]{1,160}$/.test(requestId))
    callbacks.identified?.({ providerRequestId: requestId });
  let closed = false;
  let committed = false;
  let ready = false;
  let itemId: string | undefined;
  let preview = '';
  let resolveReady: (() => void) | undefined;
  let rejectReady: ((error: Error) => void) | undefined;
  const readiness = new Promise<void>((resolve, reject) => {
    resolveReady = resolve;
    rejectReady = reject;
  });
  const fail = () => {
    if (closed) return;
    rejectReady?.(new TranscriptionError('provider_unavailable'));
    callbacks.failed();
  };
  const abort = () => {
    if (closed) return;
    closed = true;
    rejectReady?.(new TranscriptionError('cancelled'));
    socket.close(1000, 'Finished');
  };
  signal.addEventListener('abort', abort, { once: true });
  socket.addEventListener('error', fail);
  socket.addEventListener('close', fail);
  socket.addEventListener('message', (message) => {
    if (closed) return;
    try {
      if (typeof message.data !== 'string' || message.data.length > 262144)
        return fail();
      const event = jsonObject(message.data);
      if (
        event.type === 'error' ||
        event.type === 'conversation.item.input_audio_transcription.failed'
      )
        return fail();
      if (
        event.type === 'session.created' ||
        event.type === 'session.updated'
      ) {
        const session = event.session;
        if (
          session &&
          typeof session === 'object' &&
          'id' in session &&
          typeof session.id === 'string' &&
          /^[a-zA-Z0-9_-]{1,160}$/.test(session.id)
        )
          callbacks.identified?.({ providerSessionId: session.id });
      }
      if (event.type === 'session.updated') {
        const session = event.session;
        if (
          !session ||
          typeof session !== 'object' ||
          !('type' in session) ||
          session.type !== 'transcription' ||
          !('audio' in session)
        )
          return fail();
        const audio = session.audio;
        if (!audio || typeof audio !== 'object' || !('input' in audio))
          return fail();
        const input = audio.input;
        if (
          !input ||
          typeof input !== 'object' ||
          !('transcription' in input) ||
          !('turn_detection' in input) ||
          input.turn_detection !== null
        )
          return fail();
        if (
          !('format' in input) ||
          !input.format ||
          typeof input.format !== 'object' ||
          !('type' in input.format) ||
          input.format.type !== 'audio/pcm' ||
          !('rate' in input.format) ||
          input.format.rate !== 24000
        )
          return fail();
        const transcription = input.transcription;
        if (
          !transcription ||
          typeof transcription !== 'object' ||
          !('model' in transcription) ||
          transcription.model !== TRANSCRIPTION_MODEL
        )
          return fail();
        ready = true;
        resolveReady?.();
      }
      if (
        event.type === 'input_audio_buffer.committed' &&
        typeof event.item_id === 'string'
      ) {
        if (itemId && itemId !== event.item_id) return fail();
        itemId = event.item_id;
        callbacks.identified?.({ providerItemId: itemId });
      }
      if (event.type === 'conversation.item.input_audio_transcription.delta') {
        if (
          typeof event.item_id !== 'string' ||
          typeof event.delta !== 'string'
        )
          return fail();
        if (itemId && itemId !== event.item_id) return fail();
        itemId = event.item_id;
        preview += event.delta;
        if (preview.length > 32768) return fail();
        callbacks.delta(preview);
      }
      if (
        event.type === 'conversation.item.input_audio_transcription.completed'
      ) {
        if (
          !committed ||
          typeof event.item_id !== 'string' ||
          typeof event.transcript !== 'string' ||
          (itemId && itemId !== event.item_id) ||
          event.transcript.length > 32768
        )
          return fail();
        const usage = event.usage;
        if (
          !usage ||
          typeof usage !== 'object' ||
          !('type' in usage) ||
          usage.type !== 'duration' ||
          !('seconds' in usage) ||
          typeof usage.seconds !== 'number' ||
          !Number.isFinite(usage.seconds) ||
          usage.seconds < 0
        )
          return fail();
        callbacks.completed(event.transcript, usage.seconds);
      }
    } catch {
      fail();
    }
  });
  socket.send(
    JSON.stringify({
      type: 'session.update',
      session: {
        type: 'transcription',
        audio: {
          input: {
            format: { type: 'audio/pcm', rate: 24000 },
            transcription: { model: TRANSCRIPTION_MODEL },
            turn_detection: null,
          },
        },
      },
    }),
  );
  if (signal.aborted) abort();
  try {
    await readiness;
  } catch (error) {
    abort();
    throw error;
  }
  return {
    append(audio) {
      if (!ready || closed || committed)
        throw new TranscriptionError('invalid_state');
      // The relay bounds every frame, so this conversion never expands an unbounded input.
      let binary = '';
      for (const byte of new Uint8Array(audio))
        binary += String.fromCharCode(byte);
      socket.send(
        JSON.stringify({
          type: 'input_audio_buffer.append',
          audio: btoa(binary),
        }),
      );
    },
    commit() {
      if (closed || committed) return;
      committed = true;
      socket.send(JSON.stringify({ type: 'input_audio_buffer.commit' }));
    },
    close() {
      signal.removeEventListener('abort', abort);
      abort();
    },
  };
}

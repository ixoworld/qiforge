import type { TranscriptionService } from './service';
import { jsonObject, MAX_QUEUED_BYTES, TranscriptionError } from './protocol';

/** Browser bearer ticket is sent once in the first frame, never in a URL. */
export function transcriptionSocket(
  request: Request,
  service: Pick<
    TranscriptionService,
    'attach' | 'audio' | 'stop' | 'disconnect'
  >,
): Response {
  const url = new URL(request.url);
  const sessionId = url.searchParams.get('sessionId');
  if (
    request.headers.get('upgrade')?.toLowerCase() !== 'websocket' ||
    !sessionId
  )
    return Response.json({ code: 'invalid_upgrade' }, { status: 400 });
  const pair = new WebSocketPair();
  const client = pair[0];
  const server = pair[1];
  server.accept();
  let authenticated = false;
  let receivedFirst = false;
  let ended = false;
  let queuedBytes = 0;
  let queuedMessages = 0;
  let chain = Promise.resolve();
  const send = (value: unknown) => {
    if (!ended && server.readyState === 1) server.send(JSON.stringify(value));
  };
  const close = () => {
    if (ended) return;
    ended = true;
    clearTimeout(authTimer);
    try {
      server.close(1000, 'Finished');
    } catch {
      /* already closed */
    }
  };
  const reject = () => {
    send({ type: 'error', code: 'invalid_message' });
    close();
    void service.disconnect(sessionId, sink).catch(() => undefined);
  };
  const sink = { send, close, isClosed: () => ended };
  const authTimer = setTimeout(reject, 5000);
  server.addEventListener('message', (event) => {
    if (ended) return;
    if (!authenticated && receivedFirst) return reject();
    receivedFirst = true;
    const data = event.data;
    const size = typeof data === 'string' ? data.length * 2 : data.byteLength;
    if (
      size > MAX_QUEUED_BYTES ||
      queuedBytes + size > MAX_QUEUED_BYTES ||
      queuedMessages >= 128
    )
      return reject();
    queuedBytes += size;
    queuedMessages++;
    chain = chain
      .then(async () => {
        if (ended) return;
        if (!authenticated) {
          if (typeof data !== 'string' || data.length > 1024)
            throw new TranscriptionError('invalid_message');
          const event = jsonObject(data);
          if (
            event.type !== 'authenticate' ||
            typeof event.ticket !== 'string' ||
            Object.keys(event).length !== 2
          )
            throw new TranscriptionError('invalid_message');
          clearTimeout(authTimer);
          await service.attach(
            sessionId,
            event.ticket,
            request.headers.get('origin'),
            sink,
          );
          if (ended) {
            await service.disconnect(sessionId, sink);
            return;
          }
          authenticated = true;
        } else if (typeof data !== 'string') {
          await service.audio(sessionId, data);
        } else {
          if (data.length > 64) throw new TranscriptionError('invalid_message');
          const event = jsonObject(data);
          if (
            Object.keys(event).length !== 1 ||
            (event.type !== 'stop' && event.type !== 'cancel')
          )
            throw new TranscriptionError('invalid_message');
          await service.stop(sessionId, event.type === 'cancel');
        }
      })
      .catch(() => {
        reject();
      })
      .finally(() => {
        queuedBytes -= size;
        queuedMessages--;
      });
  });
  const disconnected = () => {
    close();
    void service.disconnect(sessionId, sink).catch(() => undefined);
  };
  server.addEventListener('close', disconnected);
  server.addEventListener('error', disconnected);
  return new Response(null, { status: 101, webSocket: client });
}

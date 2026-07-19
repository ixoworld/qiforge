import {
  createStreamTranslator,
  type StreamTranslatorOptions,
} from './stream-translator.js';
import { TURN_FRAME_VERSION, type TurnStreamSink } from './turn-stream.js';

export interface HandleTurnOptions {
  /** The agent's `streamEvents` v2 iterable. */
  stream: AsyncIterable<unknown>;
  sessionId: string;
  requestId: string;
  /** Client-side AG-UI action names (routed to ActionCallEvents). */
  agActionNames?: StreamTranslatorOptions['agActionNames'];
  /**
   * Turn cancellation. Checked between envelopes; a set signal ends the
   * loop WITHOUT the orphan flush or completion marker — an aborted turn
   * must not write trailing frames.
   */
  signal: AbortSignal;
  sink: TurnStreamSink;
}

export interface TurnResult {
  /** Assistant text accumulated from `message` frames. */
  fullContent: string;
  aborted: boolean;
}

/**
 * Drive one agent turn: translate the stream into ordered `TurnFrame`s and
 * write them to the sink, awaiting each write so transport backpressure
 * pauses the loop instead of buffering unboundedly.
 *
 * Transport-neutral on purpose — no express, no headers, no heartbeat, no
 * terminal `done`/`error` wire frames. Those belong to the transport shell
 * (the Node SSE runner today, a Worker DO stream later); this function owns
 * only the turn semantics: translation order, orphaned-tool-call flushing,
 * the completion marker, and terminal `sink.close(error?)` exactly once.
 */
export async function handleTurn(
  options: HandleTurnOptions,
): Promise<TurnResult> {
  const { stream, sessionId, requestId, signal, sink } = options;
  const translator = createStreamTranslator({
    sessionId,
    requestId,
    agActionNames: options.agActionNames ?? new Set<string>(),
  });

  let seq = 0;
  const emit = async (event: string, payload: unknown): Promise<void> => {
    await sink.write({ v: TURN_FRAME_VERSION, seq: seq++, event, payload });
  };

  try {
    for await (const evt of stream) {
      if (signal.aborted) break;
      for (const translated of translator.translate(evt)) {
        await emit(translated.event, translated.payload);
      }
    }

    if (!signal.aborted) {
      for (const translated of translator.flushOrphans()) {
        await emit(translated.event, translated.payload);
      }
      const completion = translator.completionEvent();
      await emit(completion.event, completion.payload);
    }

    await sink.close();
    return { fullContent: translator.fullContent, aborted: signal.aborted };
  } catch (error) {
    await sink.close(error instanceof Error ? error : new Error(String(error)));
    throw error;
  }
}

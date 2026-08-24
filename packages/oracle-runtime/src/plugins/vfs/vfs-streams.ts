import { Readable } from 'node:stream';

/**
 * Wrap a Node readable as a WHATWG stream for a `fetch` request body. Built
 * by hand (not `Readable.toWeb`) so the result carries the DOM lib's
 * `ReadableStream` type that `fetch` expects — no cast needed.
 */
export function nodeToWebStream(source: Readable): ReadableStream<Uint8Array> {
  const iterator = source[Symbol.asyncIterator]();
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      const { done, value } = await iterator.next();
      if (done) {
        controller.close();
        return;
      }
      controller.enqueue(Buffer.isBuffer(value) ? value : Buffer.from(value));
    },
    cancel() {
      source.destroy();
    },
  });
}

/**
 * Expose a `fetch` response body as a Node readable without buffering.
 *
 * Destroying the returned readable (a failed pipeline — disk full, a payload
 * that isn't gzip) cancels the response body. Without that cancel the worker
 * keeps streaming the whole file to a reader nobody drains, until it finishes
 * or the connection times out. Both ends have to be covered: a destroy while
 * the generator sits at its `yield` resumes it (running the `finally`), but a
 * destroy while it awaits the next chunk cannot — an async generator parked
 * in an `await` never sees `return()` — which is exactly where a stalled
 * download sits, hence the `close` listener.
 */
export function webToNodeStream(body: ReadableStream<Uint8Array>): Readable {
  const reader = body.getReader();
  let settled = false;
  /**
   * Let go of the body exactly once. Cancelling leaves the reader locked on
   * purpose: `releaseLock` throws while a read is still outstanding, and a
   * cancelled stream has nothing left to hand to another reader anyway.
   */
  const release = (cancel: boolean): void => {
    if (settled) return;
    settled = true;
    if (cancel) void reader.cancel().catch(() => undefined);
    else reader.releaseLock();
  };

  return new Readable({
    read() {
      // One outstanding read at a time: the consumer's demand paces the
      // transfer, so nothing is buffered ahead of it.
      reader.read().then(
        ({ done, value }) => {
          if (done) {
            release(false);
            this.push(null);
            return;
          }
          this.push(value);
        },
        (error: unknown) => {
          release(false);
          this.destroy(
            error instanceof Error ? error : new Error(String(error)),
          );
        },
      );
    },
    destroy(error, callback) {
      // Reached on every destroy, including one raised while a read is still
      // pending — the state a stalled download sits in.
      release(true);
      callback(error);
    },
  });
}

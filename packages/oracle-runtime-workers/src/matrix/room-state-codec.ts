/**
 * Wire codec for `ixo.room.state` events — byte-compatible with the Node
 * runtime's `@ixo/matrix` `MatrixStateManager`, which is what the Portal,
 * the Node oracle and every other IXO service read and write:
 *
 *   content = { data: base64( zlib-deflate( superjson.stringify(value) ) ) }
 *
 * Both runtimes share rooms (a user migrated from Node keeps the same
 * user↔oracle room), so anything this runtime persists as room state MUST
 * round-trip through the Node codec and vice versa — the UCAN delegation
 * (`ucan_delegation`) and the user preferences (`user_prefs`) in particular.
 *
 * Reads are lenient, mirroring the Node manager's fallbacks:
 *   1. `{ data: <compressed superjson> }` — the current format;
 *   2. `{ data: <uncompressed superjson string> }` — the Node legacy format;
 *   3. a plain JSON object — what earlier builds of this runtime wrote
 *      (kept readable so nothing deposited before the codec is lost);
 *   4. `{}` / missing → `null` (a cleared key).
 *
 * zlib "deflate" is the format Node's `deflateSync` emits and the Web
 * `CompressionStream('deflate')` produces — the same 2-byte zlib header and
 * Adler-32 trailer — so no Node polyfill is needed on workerd.
 */
import { parse, stringify } from 'superjson';
import { base64ToBytes, bytesToBase64 } from '../plugins/base64';

/** The state event type every IXO room-state key lives under. */
export const ROOM_STATE_EVENT_TYPE = 'ixo.room.state';

/** The compressed room-state envelope. */
export interface RoomStateEnvelope {
  data: string;
}

function bytesToStream(bytes: Uint8Array): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(bytes);
      controller.close();
    },
  });
}

async function streamToBytes(
  stream: ReadableStream<Uint8Array>,
): Promise<Uint8Array> {
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

/** zlib-format deflate (what Node's `deflateSync` produces). */
export async function deflate(bytes: Uint8Array): Promise<Uint8Array> {
  return streamToBytes(
    bytesToStream(bytes).pipeThrough(new CompressionStream('deflate')),
  );
}

/** zlib-format inflate. Rejects on malformed input. */
export async function inflate(bytes: Uint8Array): Promise<Uint8Array> {
  return streamToBytes(
    bytesToStream(bytes).pipeThrough(new DecompressionStream('deflate')),
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * superjson's `parse` yields `undefined` for a JSON document that is not a
 * superjson envelope (no `json` key). Treat that — and `null` — as "nothing
 * stored" so callers get one absent value.
 */
function normalise(value: unknown): unknown {
  return value === undefined ? null : value;
}

/**
 * Encode a value the way the Node runtime does. The result is the state
 * event's `content`.
 */
export async function encodeRoomStateContent(
  value: unknown,
): Promise<RoomStateEnvelope> {
  const serialized = new TextEncoder().encode(stringify(value));
  return { data: bytesToBase64(await deflate(serialized)) };
}

/**
 * Decode a state event's `content` (any of the formats listed above) into
 * the stored value, or `null` when nothing (readable) is stored. Never
 * throws on malformed input: an unreadable payload is reported as absent,
 * matching the Node manager's "return undefined + warn" behaviour.
 */
export async function decodeRoomStateContent(
  content: unknown,
): Promise<unknown> {
  if (!isRecord(content)) return null;
  const data = content['data'];
  if (typeof data === 'string') {
    if (data.length === 0) return null;
    try {
      const inflated = await inflate(base64ToBytes(data));
      return normalise(parse(new TextDecoder().decode(inflated)));
    } catch {
      // Not compressed — fall through to the legacy uncompressed form.
    }
    try {
      return normalise(parse(data));
    } catch {
      return null;
    }
  }
  // Plain JSON written by earlier builds of this runtime (pre-codec).
  return Object.keys(content).length === 0 ? null : content;
}

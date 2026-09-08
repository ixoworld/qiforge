/**
 * Room-state codec — proven against payloads produced by the REAL Node
 * encoder (`@ixo/matrix` MatrixStateManager: superjson → zlib deflateSync →
 * base64). The fixtures below were generated with that exact pipeline, so a
 * green decode here means a Node-written state event reads correctly on
 * workerd, and the encode round-trip means the reverse holds too.
 */
import { describe, expect, it } from 'vitest';
import {
  decodeRoomStateContent,
  encodeRoomStateContent,
  inflate,
} from './room-state-codec';

// superjson.stringify + deflateSync + base64 of this object, produced by Node:
const PREFS = {
  userName: 'Zed',
  language: 'en',
  tone: 'concise and dry',
  formality: 'casual',
  customInstructions: 'Keep replies under three sentences.',
  updatedAt: '2026-09-01T10:00:00.000Z',
};
const PREFS_FIXTURE =
  'eJwViTELgzAUBv9K+OYo0aHQbB1LoVMnt5C8Wou+SN7LINL/XgI3HHcnvpIZ/kQVKs+wETwmSrBYA881zC0Qw0IzN4+Z4yJkAieTygGLdy5bWBc92g1SwwqLWEXzdmfRUqMumQUeD6LdFNrXhcRUTlSMfgqREWIljiQ9LOqeglK6KTxGN146d+3c8Bqcd43eOTfh9/sDLEo9Fw==';

const DELEGATION = {
  raw: 'CAR_BASE64_PLACEHOLDER',
  issuer: 'did:ixo:user',
  audience: 'did:ixo:oracle',
  expiration: 4102444800,
  updatedAt: '2026-09-01T10:00:00.000Z',
};
const DELEGATION_FIXTURE =
  'eJxNzbEKgzAURuF3+edYrhKkvVtqhQ5Ci+3URYK5Q0pRSQwVxHcvboWzfcNZ8Y7jAF4R7BeMyrTd2TzqUnf3xlT19dZc6hYKPsYkAQznHftl5BQlQMEm52Xo5U/GYPuPQEGWyQc7+32gcyq01kcihTQ5O4szMxgFFWVGp4zyZ05MewciemHbfuuALqY=';

// Node's `delete` writes `{}` through the same pipeline.
const EMPTY_FIXTURE = 'eJyrVsoqzs9TsqqurQUAGBEEKQ==';

describe('room-state codec (Node-compatible)', () => {
  it('decodes user preferences written by the Node runtime', async () => {
    await expect(
      decodeRoomStateContent({ data: PREFS_FIXTURE }),
    ).resolves.toEqual(PREFS);
  });

  it('decodes a UCAN delegation written by the Node runtime', async () => {
    await expect(
      decodeRoomStateContent({ data: DELEGATION_FIXTURE }),
    ).resolves.toEqual(DELEGATION);
  });

  it('reads a Node-cleared key ({} compressed) as absent', async () => {
    await expect(
      decodeRoomStateContent({ data: EMPTY_FIXTURE }),
    ).resolves.toEqual({});
  });

  it('reads the Node legacy uncompressed superjson form', async () => {
    await expect(
      decodeRoomStateContent({ data: JSON.stringify({ json: PREFS }) }),
    ).resolves.toEqual(PREFS);
  });

  it('still reads the plain JSON this runtime wrote before the codec', async () => {
    const plain = { raw: 'x', issuer: 'did:ixo:u', storedAt: 'now' };
    await expect(decodeRoomStateContent(plain)).resolves.toEqual(plain);
  });

  it('reports empty / malformed / non-object content as absent', async () => {
    await expect(decodeRoomStateContent({})).resolves.toBeNull();
    await expect(decodeRoomStateContent(null)).resolves.toBeNull();
    await expect(decodeRoomStateContent('nope')).resolves.toBeNull();
    await expect(decodeRoomStateContent({ data: '' })).resolves.toBeNull();
    await expect(
      decodeRoomStateContent({ data: '!!not base64 nor json!!' }),
    ).resolves.toBeNull();
    // A JSON document that is not a superjson envelope.
    await expect(
      decodeRoomStateContent({ data: JSON.stringify({ a: 1 }) }),
    ).resolves.toBeNull();
  });

  it('encodes in the Node envelope shape and round-trips', async () => {
    const encoded = await encodeRoomStateContent(DELEGATION);
    expect(Object.keys(encoded)).toEqual(['data']);
    expect(typeof encoded.data).toBe('string');
    // The payload really is zlib-deflated superjson: inflate by hand.
    const bytes = Uint8Array.from(atob(encoded.data), (c) => c.charCodeAt(0));
    expect(bytes[0]).toBe(0x78); // zlib header (CMF) — what Node's inflateSync expects
    const json = new TextDecoder().decode(await inflate(bytes));
    expect(JSON.parse(json)).toEqual({ json: DELEGATION });
    await expect(decodeRoomStateContent(encoded)).resolves.toEqual(DELEGATION);
  });

  it('encodes {} for a cleared key exactly like Node', async () => {
    const encoded = await encodeRoomStateContent({});
    const bytes = Uint8Array.from(atob(encoded.data), (c) => c.charCodeAt(0));
    expect(new TextDecoder().decode(await inflate(bytes))).toBe('{"json":{}}');
  });
});

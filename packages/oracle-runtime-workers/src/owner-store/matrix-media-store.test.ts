/**
 * The legacy Matrix media store streams in both directions — decrypt →
 * gunzip → SQLite header check on the way down, header check → gzip → upload
 * on the way up — against a faked gateway that hands over exactly what the
 * SDK's raw-mode download does: the ciphertext plus its `EncryptedFile`
 * fields. The file is never held whole on this side.
 */
import { createAttachmentEncryptor } from '@ixo/matrix-bot-workers-sdk';
import { describe, expect, it } from 'vitest';
import type { SnapshotStream } from '../do/contracts';
import {
  MatrixMediaOwnerStore,
  type SnapshotGateway,
} from './matrix-media-store';
import {
  bytesOfStream,
  gunzip,
  gzip,
  streamOfBytes,
  type FileSnapshot,
} from './types';

const CHUNK = 64 * 1024;

/** `size` bytes that start like a SQLite file and do not compress. */
function sqliteLike(size: number): Uint8Array {
  const out = new Uint8Array(size);
  for (let offset = 0; offset < size; offset += 65536)
    crypto.getRandomValues(
      out.subarray(offset, Math.min(size, offset + 65536)),
    );
  out.set(new TextEncoder().encode('SQLite format 3\0'), 0);
  return out;
}

async function encrypt(
  plain: Uint8Array,
): Promise<{ cipher: Uint8Array; file: SnapshotStream['file'] }> {
  const encryptor = createAttachmentEncryptor();
  const cipher = await bytesOfStream(
    streamOfBytes(plain).pipeThrough(encryptor.transform),
  );
  return { cipher, file: await encryptor.info };
}

/** `bytes` in `CHUNK`-sized pieces, handed out only when pulled, counting the pulls. */
function chunked(bytes: Uint8Array): {
  stream: ReadableStream<Uint8Array>;
  pulls: () => number;
} {
  let pulls = 0;
  let offset = 0;
  const stream = new ReadableStream<Uint8Array>(
    {
      pull(controller) {
        pulls += 1;
        if (offset >= bytes.byteLength) {
          controller.close();
          return;
        }
        controller.enqueue(bytes.subarray(offset, offset + CHUNK));
        offset += CHUNK;
      },
    },
    { highWaterMark: 0 },
  );
  return { stream, pulls: () => pulls };
}

function fakeGateway(found: SnapshotStream | null): {
  gateway: SnapshotGateway;
  uploads: Array<{ filename: string; size: number; bytes: Uint8Array }>;
} {
  const uploads: Array<{ filename: string; size: number; bytes: Uint8Array }> =
    [];
  const gateway: SnapshotGateway = {
    downloadUserSnapshotStream: async () => found,
    uploadUserSnapshotStream: async (
      _userDid,
      _storageKey,
      body,
      filename,
      size,
    ) => {
      uploads.push({ filename, size, bytes: await bytesOfStream(body) });
      return { eventId: `$upload-${uploads.length}` };
    },
    resolveUserRoom: async () => ({
      roomId: '!room:ixo.test',
      alias: '#alias:ixo.test',
    }),
    getRoomStateEvent: async () => null,
    sendEvent: async () => '$event',
    sendStateEvent: async () => '$state',
  };
  return { gateway, uploads };
}

const storeOver = (gateway: SnapshotGateway): MatrixMediaOwnerStore =>
  new MatrixMediaOwnerStore({
    gateway,
    userDid: 'did:ixo:user',
    storageKey: 'user_oracle',
  });

describe('MatrixMediaOwnerStore.load — streamed', () => {
  it('decrypts and gunzips a Node-style encrypted upload as it streams, reading only the head before it returns', async () => {
    const plain = sqliteLike(1_000_000);
    const { cipher, file } = await encrypt(await gzip(plain));
    const source = chunked(cipher);
    const { gateway } = fakeGateway({
      stream: source.stream,
      ...(file ? { file } : {}),
      eventId: '$snapshot',
      size: cipher.byteLength,
    });

    const copy = await storeOver(gateway).load();
    expect(copy?.etag).toBe('$snapshot');
    expect(copy?.fromLegacy).toBeUndefined();
    // The gzip and SQLite header checks touched the first chunks only; the
    // rest of the ~1 MB ciphertext (16 chunks) is still on the wire.
    expect(source.pulls()).toBeLessThan(8);
    expect(await bytesOfStream(copy!.stream)).toEqual(plain);
  });

  it('accepts a plain upload (no encryption, no gzip) untouched', async () => {
    const plain = sqliteLike(200_000);
    const source = chunked(plain);
    const { gateway } = fakeGateway({
      stream: source.stream,
      eventId: '$plain',
    });
    const copy = await storeOver(gateway).load();
    expect(source.pulls()).toBeLessThan(4);
    expect(await bytesOfStream(copy!.stream)).toEqual(plain);
  });

  it('rejects a file that is not SQLite before the object writes a chunk', async () => {
    const junk = new TextEncoder().encode('<!doctype html>'.repeat(100));
    const { cipher, file } = await encrypt(await gzip(junk));
    const { gateway } = fakeGateway({
      stream: streamOfBytes(cipher),
      ...(file ? { file } : {}),
      eventId: '$junk',
    });
    await expect(storeOver(gateway).load()).rejects.toThrow(
      /snapshot \$junk for user_oracle is not a SQLite file/,
    );
  });

  it('surfaces a ciphertext hash mismatch as a stream error at the end (the import fails, the working copy stays)', async () => {
    const plain = sqliteLike(300_000);
    const { cipher, file } = await encrypt(plain);
    const tamperAt = cipher.byteLength - 10;
    cipher[tamperAt] = (cipher[tamperAt] ?? 0) ^ 0xff;
    const { gateway } = fakeGateway({
      stream: streamOfBytes(cipher),
      ...(file ? { file } : {}),
      eventId: '$tampered',
    });
    // The header still decrypts, so load() resolves …
    const copy = await storeOver(gateway).load();
    // … and the consumer sees the failure when the last byte is in.
    await expect(bytesOfStream(copy!.stream)).rejects.toThrow();
  });

  it('returns null when the user has no snapshot', async () => {
    const { gateway } = fakeGateway(null);
    expect(await storeOver(gateway).load()).toBeNull();
  });
});

describe('MatrixMediaOwnerStore.save — streamed', () => {
  it('gzips the snapshot into the upload with its exact length, in three passes, never whole', async () => {
    const plain = sqliteLike(700_000);
    let opens = 0;
    const snapshot: FileSnapshot = {
      size: plain.byteLength,
      open: () => {
        opens += 1;
        return streamOfBytes(plain);
      },
    };
    const { gateway, uploads } = fakeGateway(null);
    const saved = await storeOver(gateway).save(snapshot);
    expect(uploads).toHaveLength(1);
    const upload = uploads[0]!;
    expect(upload.filename).toBe('user_oracle.db.gz');
    expect(upload.size).toBe(upload.bytes.byteLength);
    expect(saved).toEqual({
      etag: '$upload-1',
      bytes: upload.bytes.byteLength,
    });
    expect(await gunzip(upload.bytes)).toEqual(plain);
    // header peek, gzip length pass, gzip upload pass
    expect(opens).toBe(3);
  });

  it('refuses to upload a working copy that is not a SQLite file', async () => {
    const junk = new TextEncoder().encode('not a database');
    const { gateway, uploads } = fakeGateway(null);
    await expect(
      storeOver(gateway).save({
        size: junk.byteLength,
        open: () => streamOfBytes(junk),
      }),
    ).rejects.toThrow(/is not a SQLite file/);
    expect(uploads).toHaveLength(0);
  });
});

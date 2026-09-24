import { describe, expect, it } from 'vitest';
import { VfsClient } from './vfs-client';

describe('VFS content identity', () => {
  it('preserves file ID separately from CID, content hash and version', async () => {
    const client = new VfsClient({
      baseUrl: 'https://vfs.example/api/fs',
      mint: async () => ({ bearer: 'test' }),
      timeoutMs: 1000,
      fetchImpl: async () =>
        Response.json({
          id: '11111111-1111-4111-8111-111111111111',
          cid: 'bafy-test-content',
          contentHash: 'a'.repeat(64),
          version: 3,
          path: '/Reporter/test.txt',
          mimeType: 'text/plain',
          size: 4,
        }),
    });
    const created = await client.create(
      '/Reporter/test.txt',
      new TextEncoder().encode('test'),
      'text/plain',
    );
    expect(created).toMatchObject({
      id: '11111111-1111-4111-8111-111111111111',
      cid: 'bafy-test-content',
      contentHash: 'a'.repeat(64),
      version: 3,
    });
    expect(created.cid).not.toBe(created.id);
  });
});

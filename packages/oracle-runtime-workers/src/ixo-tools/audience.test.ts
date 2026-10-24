import { describe, expect, it, vi } from 'vitest';
import { createCurrentIxoAudienceReader } from '../do/ixo-tools';

const userDid = 'did:ixo:alice';
const ownerMatrixId = '@did-ixo-alice:mx.test';
const oracleMatrixId = '@oracle:mx.test';
function fixture() {
  const participants = vi.fn(async () => ({
    oracleMatrixId,
    joined: [ownerMatrixId, oracleMatrixId],
  }));
  const fetch = vi.fn(async () =>
    Response.json({
      data: {
        iids: {
          nodes: [
            {
              id: userDid,
              service: [
                {
                  type: 'MatrixHomeServer',
                  serviceEndpoint: 'https://mx.test',
                },
              ],
            },
          ],
        },
      },
    }),
  );
  const input = {
    client: 'portal',
    sessionId: '$session',
    roomId: '!room:mx.test',
    userDid,
    blocksyncUri: 'https://blocksync.test/graphql',
    participants,
    fetch,
  } satisfies Parameters<typeof createCurrentIxoAudienceReader>[0];
  return {
    input,
    participants,
    fetch,
    read: createCurrentIxoAudienceReader(input),
  };
}

describe('native disclosure destinations', () => {
  it('requires fresh owner-DID and membership proof for every mirrored Portal read', async () => {
    const f = fixture();
    expect(await f.read()).toBe('private');
    f.participants.mockResolvedValue({
      oracleMatrixId,
      joined: [ownerMatrixId, oracleMatrixId, '@third:mx.test'],
    });
    expect(await f.read()).toBe('shared');
    expect(f.fetch).toHaveBeenCalledTimes(2);
    expect(f.participants).toHaveBeenCalledTimes(2);
  });
  it('does not fall back to an oracle homeserver or previously resolved owner', async () => {
    const f = fixture();
    expect(await f.read()).toBe('private');
    f.fetch.mockRejectedValue(new Error('offline'));
    expect(await f.read()).toBe('shared');
    expect(f.participants).toHaveBeenCalledTimes(1);
  });
  it('rejects unknown or foreign owner documents and redirected resolution', async () => {
    const f = fixture();
    for (const response of [
      Response.json({ data: { iids: { nodes: [] } } }),
      Response.json({
        data: { iids: { nodes: [{ id: 'did:ixo:other', service: [] }] } },
      }),
      new Response(null, {
        status: 302,
        headers: { location: 'https://other.test' },
      }),
    ]) {
      f.fetch.mockResolvedValue(response);
      expect(await f.read()).toBe('shared');
    }
    expect(f.participants).not.toHaveBeenCalled();
  });
  it('keeps unmirrored Portal streams private and other channels shared', async () => {
    const f = fixture();
    expect(
      await createCurrentIxoAudienceReader({
        ...f.input,
        sessionId: 'local-session',
      })(),
    ).toBe('private');
    expect(
      await createCurrentIxoAudienceReader({
        ...f.input,
        sessionId: '$task-background',
      })(),
    ).toBe('private');
    expect(
      await createCurrentIxoAudienceReader({ ...f.input, client: 'channel' })(),
    ).toBe('shared');
    expect(f.fetch).not.toHaveBeenCalled();
    expect(f.participants).not.toHaveBeenCalled();
  });
  it('requires a verified Matrix sender identity and fresh complete membership', async () => {
    const f = fixture();
    expect(
      await createCurrentIxoAudienceReader({ ...f.input, client: 'matrix' })(),
    ).toBe('shared');
    const read = createCurrentIxoAudienceReader({
      ...f.input,
      client: 'matrix',
      ownerMatrixId,
    });
    expect(await read()).toBe('private');
    f.participants.mockRejectedValue(new Error('403'));
    expect(await read()).toBe('shared');
    expect(f.fetch).not.toHaveBeenCalled();
  });
});

import {
  createDelegation,
  generateKeypair,
  serializeDelegation,
} from '@ixo/ucan';
import { describe, expect, it, vi } from 'vitest';
import { createShell } from './app';
import type * as AuthModule from './auth';
import { authenticate } from './auth';
vi.mock('./auth', async (importOriginal) => ({
  ...(await importOriginal<typeof AuthModule>()),
  authenticate: vi.fn(),
}));

describe('delegation body before durable writes', () => {
  it.each([
    'malformed',
    'expired',
    'foreign-user',
    'wrong-audience',
    'false-expiration',
  ])('rejects %s without room-state or cached-grant mutation', async (kind) => {
    const user = await generateKeypair();
    const oracle = await generateKeypair();
    const other = await generateKeypair();
    vi.mocked(authenticate).mockResolvedValue({
      ok: true,
      auth: { userDid: user.did, via: 'invocation' },
    });
    const expiration =
      Math.floor(Date.now() / 1000) + (kind === 'expired' ? -60 : 60);
    const raw =
      kind === 'malformed'
        ? 'forged'
        : await serializeDelegation(
            await createDelegation({
              issuer: kind === 'foreign-user' ? other.signer : user.signer,
              audience: kind === 'wrong-audience' ? other.did : oracle.did,
              expiration,
              capabilities: [
                { can: 'fs/list', with: 'ixo:filesystem/.oracles' },
              ],
            }),
          );
    const resolveUserRoom = vi.fn();
    const setDelegation = vi.fn();
    const sendStateEvent = vi.fn();
    const env = {
      ORACLE_DID: oracle.did,
      BLOCKSYNC_GRAPHQL_URL: 'https://not-used.example',
      MATRIX_GATEWAY: {
        idFromName: () => 'gateway',
        get: () => ({ resolveUserRoom, sendStateEvent }),
      },
      USER_ORACLE: { idFromName: () => 'user', get: () => ({ setDelegation }) },
    };
    const response = await createShell().request(
      '/delegation',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          raw,
          ...(kind === 'false-expiration'
            ? { expiration: expiration + 1000 }
            : {}),
        }),
      },
      env,
    );
    expect([400, 403]).toContain(response.status);
    expect(resolveUserRoom).not.toHaveBeenCalled();
    expect(sendStateEvent).not.toHaveBeenCalled();
    expect(setDelegation).not.toHaveBeenCalled();
  });
  it('keeps the reporter routes disabled unless the host opts in', async () => {
    vi.mocked(authenticate).mockResolvedValue({
      ok: true,
      auth: { userDid: 'did:ixo:test', via: 'invocation' },
    });
    const response = await createShell().request(
      '/reporter/capabilities',
      {},
      { ORACLE_DID: 'did:ixo:oracle' },
    );
    expect(response.status).toBe(404);
  });
});

it('cancels an oversized chunked Reporter body before DO dispatch', async () => {
  vi.mocked(authenticate).mockResolvedValue({
    ok: true,
    auth: {
      userDid: 'did:ixo:test',
      via: 'invocation',
      delegation: 'valid-header',
    },
  });
  let consumed = 0;
  const cancelled = vi.fn();
  const dispatch = vi.fn();
  const body = new ReadableStream<Uint8Array>(
    {
      pull(controller) {
        consumed++;
        controller.enqueue(new Uint8Array(128 * 1024));
      },
      cancel: cancelled,
    },
    { highWaterMark: 0 },
  );
  const init = { method: 'POST', body, duplex: 'half' };
  const request = new Request('https://companion/reporter/sessions', init);
  const response = await createShell({
    reporter: { profile: 'reporter-grounded-v1' },
  }).request(request, undefined, {
    ORACLE_DID: 'did:ixo:oracle',
    USER_ORACLE: { idFromName: dispatch },
  });
  expect(response.status).toBe(413);
  expect(consumed).toBe(3);
  expect(cancelled).toHaveBeenCalledOnce();
  expect(dispatch).not.toHaveBeenCalled();
});

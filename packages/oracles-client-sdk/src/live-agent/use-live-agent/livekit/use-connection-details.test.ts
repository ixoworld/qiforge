// @vitest-environment jsdom
import { act, renderHook } from '@testing-library/react';
import { type IOpenIDToken } from 'matrix-js-sdk';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import useConnectionDetails from './use-connection-details.js';

const openIdToken: IOpenIDToken = {
  access_token: 'openid',
  expires_in: 3600,
  matrix_server_name: 'hs',
  token_type: 'Bearer',
};

const base64url = (value: object) =>
  btoa(JSON.stringify(value))
    .replace(/=+$/, '')
    .replace(/\+/g, '-')
    .replace(/\//g, '_');
/** An (unsigned) LiveKit JWT expiring `inSeconds` from now. */
const jwtExpiringIn = (inSeconds: number) =>
  `${base64url({ alg: 'HS256', typ: 'JWT' })}.${base64url({
    exp: Math.floor(Date.now() / 1000) + inSeconds,
  })}.sig`;

describe('useConnectionDetails', () => {
  let issued: { room: string; jwt: string }[];
  let nextJwt: () => string;

  beforeEach(() => {
    issued = [];
    nextJwt = () => jwtExpiringIn(10 * 60);
    vi.stubEnv('NEXT_PUBLIC_JWT_SERVER', 'https://jwt.test/sfu/get');
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url: string, init: RequestInit) => {
        const { room } = JSON.parse(String(init.body)) as { room: string };
        const jwt = nextJwt();
        issued.push({ room, jwt });
        return new Response(JSON.stringify({ url: 'wss://lk.test', jwt }));
      }),
    );
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  it('reuses details for the same room while their JWT is valid', async () => {
    const { result } = renderHook(() => useConnectionDetails());
    let first!: { jwt: string };
    await act(async () => {
      first = await result.current.existingOrRefreshConnectionDetails(
        'call-1',
        openIdToken,
      );
    });
    let second!: { jwt: string };
    await act(async () => {
      second = await result.current.existingOrRefreshConnectionDetails(
        'call-1',
        openIdToken,
      );
    });
    expect(issued).toHaveLength(1);
    expect(second.jwt).toBe(first.jwt);
  });

  it('fetches new details once the JWT is (about to be) expired', async () => {
    nextJwt = () => jwtExpiringIn(30); // inside the one-minute margin
    const { result } = renderHook(() => useConnectionDetails());
    await act(async () => {
      await result.current.existingOrRefreshConnectionDetails(
        'call-1',
        openIdToken,
      );
    });
    await act(async () => {
      await result.current.existingOrRefreshConnectionDetails(
        'call-1',
        openIdToken,
      );
    });
    expect(issued).toHaveLength(2);
  });

  it("never hands out another room's details: a new call fetches its own", async () => {
    const { result } = renderHook(() => useConnectionDetails());
    await act(async () => {
      await result.current.existingOrRefreshConnectionDetails(
        'call-1',
        openIdToken,
      );
    });
    let next!: { jwt: string };
    await act(async () => {
      next = await result.current.existingOrRefreshConnectionDetails(
        'call-2',
        openIdToken,
      );
    });
    expect(issued.map((i) => i.room)).toEqual(['call-1', 'call-2']);
    expect(next.jwt).toBe(issued[1]!.jwt);
  });

  it('fails instead of storing an error body as connection details', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(JSON.stringify({ errcode: 'M_UNKNOWN_TOKEN' }), {
            status: 401,
          }),
      ),
    );
    const error = vi
      .spyOn(console, 'error')
      .mockImplementation(() => undefined);
    const { result } = renderHook(() => useConnectionDetails());
    try {
      await act(async () => {
        await expect(
          result.current.existingOrRefreshConnectionDetails(
            'call-1',
            openIdToken,
          ),
        ).rejects.toThrow();
      });
      expect(result.current.connectionDetails).toBeNull();
    } finally {
      error.mockRestore();
    }
  });
});

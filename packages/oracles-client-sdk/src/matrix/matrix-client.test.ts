import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import MatrixClient from './matrix-client.js';

const TOKEN = 'user-matrix-token';
const USER_DID = 'did:ixo:ixo1user';
const ORACLE_DID = 'did:ixo:entity:oracle';
const SESSION = 'https://matrix.supamoto.global';
const ROOMS_BOT = 'https://rooms.bot.mx.ixo.earth';
const UCAN = { Authorization: 'Bearer ucan', 'X-Auth-Type': 'ucan' };

const getMatrixUrlsForDid = vi.hoisted(() => vi.fn());

vi.mock('@ixo/oracles-chain-client/react', () => ({
  getMatrixUrlsForDid,
  normalizeMatrixHomeServerUrl: (url: string) =>
    (/^https?:\/\//.test(url) ? url : `https://${url}`).replace(/\/+$/, ''),
}));

type Call = { url: string; authorization: string | null };

let calls: Call[];

function respond(url: string): Response {
  if (url.endsWith('/spaces/oracle/create')) {
    return new Response(JSON.stringify({ roomId: '!room:mx.ixo.earth' }));
  }
  if (url.includes('/join/')) {
    return new Response(JSON.stringify({ room_id: '!room:mx.ixo.earth' }));
  }
  if (url.includes('/members')) {
    return new Response(JSON.stringify({ chunk: [] }));
  }
  if (url.includes('/directory/room/')) {
    return new Response(JSON.stringify({ room_id: '!room:mx.ixo.earth' }));
  }
  return new Response('{}');
}

function client(
  params: Partial<ConstructorParameters<typeof MatrixClient>[0]>,
) {
  return new MatrixClient({ userAccessToken: TOKEN, ...params });
}

const withToken = () =>
  calls.filter((call) => call.authorization === `Bearer ${TOKEN}`);

beforeEach(() => {
  calls = [];
  getMatrixUrlsForDid.mockReset();
  getMatrixUrlsForDid.mockResolvedValue({
    homeServer: 'https://mx.ixo.earth',
    homeServerCropped: 'mx.ixo.earth',
    roomsBot: ROOMS_BOT,
  });
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      calls.push({
        url,
        authorization: new Headers(init?.headers).get('authorization'),
      });
      return respond(url);
    }),
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('the homeserver the token goes to', () => {
  it('is the session, not the homeserver the DID names', async () => {
    const session = client({ homeserverUrl: SESSION });

    await session.joinSpaceOrRoomWithDid({
      roomId: '!room:mx.ixo.earth',
      userDid: USER_DID,
    });
    await session.listRoomMembersWithDid('!room:mx.ixo.earth', USER_DID);
    await session.inviteUserWithDid('!room:mx.ixo.earth', '@a:b.c', USER_DID);

    expect(calls).toHaveLength(3);
    expect(
      calls.filter((call) => !call.url.startsWith(`${SESSION}/_matrix/`)),
    ).toEqual([]);
    expect(withToken()).toHaveLength(3);
  });

  it('accepts a bare host, as wallets carry it', async () => {
    await client({
      homeserverUrl: 'matrix.supamoto.global',
    }).listRoomMembersWithDid('!room:mx.ixo.earth', USER_DID);

    expect(calls[0].url.startsWith(`${SESSION}/_matrix/`)).toBe(true);
  });

  it('looks the oracle room up on the session, with the alias from the DID', async () => {
    await client({ homeserverUrl: SESSION }).getOracleRoomIdWithDid({
      userDid: USER_DID,
      oracleEntityDid: ORACLE_DID,
    });

    const alias = encodeURIComponent(
      '#did-ixo-ixo1user_did-ixo-entity-oracle:mx.ixo.earth',
    );
    expect(calls).toEqual([
      {
        url: `${SESSION}/_matrix/client/v3/directory/room/${alias}`,
        authorization: `Bearer ${TOKEN}`,
      },
    ]);
  });

  it('falls back to the DID for a caller that names no homeserver', async () => {
    await client({}).listRoomMembersWithDid('!room:mx.ixo.earth', USER_DID);

    expect(calls[0].url.startsWith('https://mx.ixo.earth/_matrix/')).toBe(true);
  });

  it('falls back to the constructor default with no DID either', async () => {
    await client({}).listRoomMembersWithDid('!room:mx.ixo.earth');

    expect(getMatrixUrlsForDid).not.toHaveBeenCalled();
    expect(calls[0].url).toContain('/_matrix/client/v3/rooms/');
  });
});

describe('createAndJoinOracleRoomWithDid', () => {
  it('gives the rooms bot a UCAN and the homeserver the token', async () => {
    const getRoomsBotAuth = vi.fn(async () => UCAN);

    await client({
      homeserverUrl: SESSION,
      getRoomsBotAuth,
    }).createAndJoinOracleRoomWithDid({
      userDid: USER_DID,
      oracleEntityDid: ORACLE_DID,
    });

    expect(getRoomsBotAuth).toHaveBeenCalledWith(ROOMS_BOT);
    expect(calls).toEqual([
      {
        url: `${ROOMS_BOT}/spaces/oracle/create`,
        authorization: 'Bearer ucan',
      },
      {
        url: `${SESSION}/_matrix/client/v3/join/!room:mx.ixo.earth`,
        authorization: `Bearer ${TOKEN}`,
      },
    ]);
  });

  it('refuses without a way to authenticate, and contacts nothing', async () => {
    await expect(
      client({}).createAndJoinOracleRoomWithDid({
        userDid: USER_DID,
        oracleEntityDid: ORACLE_DID,
      }),
    ).rejects.toThrow('getRoomsBotAuth');

    expect(calls).toEqual([]);
  });

  it('sends nothing when minting fails', async () => {
    await expect(
      client({
        getRoomsBotAuth: vi.fn(async () => {
          throw new Error('PIN entry cancelled');
        }),
      }).createAndJoinOracleRoomWithDid({
        userDid: USER_DID,
        oracleEntityDid: ORACLE_DID,
      }),
    ).rejects.toThrow('PIN entry cancelled');

    expect(calls).toEqual([]);
  });
});

describe('a bot', () => {
  it('never receives the access token on any path', async () => {
    const session = client({
      homeserverUrl: SESSION,
      getRoomsBotAuth: vi.fn(async () => UCAN),
    });
    vi.mocked(fetch).mockImplementationOnce(
      async () =>
        new Response(
          JSON.stringify({ space_id: '!space:mx.ixo.earth', subspaces: {} }),
        ),
    );

    await session.sourceMainSpaceWithDid({ userDid: USER_DID });
    await session.createAndJoinOracleRoomWithDid({
      userDid: USER_DID,
      oracleEntityDid: ORACLE_DID,
    });

    expect(
      withToken().filter((call) => new URL(call.url).origin !== SESSION),
    ).toEqual([]);
  });
});

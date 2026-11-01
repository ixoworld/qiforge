import { type LinkedResource } from '@ixo/impactxclient-sdk/codegen/ixo/iid/v1beta1/types';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fetchLinkedResourceDoc } from './get-settings-resouce.js';

const TOKEN = 'user-matrix-token';
const HOME_SERVER = 'mx.ixo.earth';

let fetchMock: ReturnType<typeof vi.fn>;

async function requestFor(serviceEndpoint: string, homeServer?: string) {
  await fetchLinkedResourceDoc(
    { serviceEndpoint } as LinkedResource,
    TOKEN,
    homeServer,
  );
  const [url, init] = fetchMock.mock.calls.at(-1) as [string, RequestInit];
  return {
    url,
    redirect: init.redirect,
    authorization: new Headers(init.headers).get('authorization'),
  };
}

describe('fetchLinkedResourceDoc', () => {
  beforeEach(() => {
    fetchMock = vi.fn(async () => new Response('{}'));
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('sends the token for media on the own homeserver, and follows no redirect', async () => {
    await expect(
      requestFor(
        'https://mx.ixo.earth/_matrix/media/v3/download/mx.ixo.earth/abc',
        HOME_SERVER,
      ),
    ).resolves.toEqual({
      url: 'https://mx.ixo.earth/_matrix/client/v1/media/download/mx.ixo.earth/abc',
      redirect: 'error',
      authorization: `Bearer ${TOKEN}`,
    });
  });

  it('proxies foreign media through the own homeserver', async () => {
    await expect(
      requestFor(
        'https://matrix.supamoto.global/_matrix/media/v3/download/matrix.supamoto.global/abc',
        HOME_SERVER,
      ),
    ).resolves.toEqual({
      url: 'https://mx.ixo.earth/_matrix/client/v1/media/download/matrix.supamoto.global/abc',
      redirect: 'error',
      authorization: `Bearer ${TOKEN}`,
    });
  });

  it('accepts the homeserver as a URL', async () => {
    await expect(
      requestFor(
        'https://mx.ixo.earth/_matrix/media/v3/download/mx.ixo.earth/abc',
        'https://mx.ixo.earth/',
      ),
    ).resolves.toMatchObject({
      url: 'https://mx.ixo.earth/_matrix/client/v1/media/download/mx.ixo.earth/abc',
      authorization: `Bearer ${TOKEN}`,
    });
  });

  it('sends no token to a URL the oracle chose, and still fetches it', async () => {
    await expect(
      requestFor('https://evil.example/agent-card.json', HOME_SERVER),
    ).resolves.toEqual({
      url: 'https://evil.example/agent-card.json',
      redirect: 'follow',
      authorization: null,
    });
  });

  it.each([
    [
      'the authenticated media path on another host',
      'https://evil.example/_matrix/client/v1/media/download/a/b',
    ],
    [
      'a lookalike host',
      'https://mx.ixo.earth.evil.example/_matrix/client/v1/media/download/a/b',
    ],
    [
      'userinfo naming the own host',
      'https://mx.ixo.earth@evil.example/_matrix/client/v1/media/download/a/b',
    ],
    [
      'another port on the own host',
      'https://mx.ixo.earth:8448/_matrix/client/v1/media/download/a/b',
    ],
    ['plain http', 'http://mx.ixo.earth/_matrix/client/v1/media/download/a/b'],
    [
      'another path on the own host',
      'https://mx.ixo.earth/_matrix/client/v3/account/whoami',
    ],
    [
      'a path that climbs out of the media path',
      'https://mx.ixo.earth/_matrix/client/v1/media/download/../../v3/account/whoami',
    ],
    [
      'an encoded climb',
      'https://mx.ixo.earth/_matrix/client/v1/media/download/%2e%2e/%2e%2e/v3/account/whoami',
    ],
    [
      'a legacy media URL whose id climbs out once rewritten',
      'https://evil.example/_matrix/media/v3/download/a/../../../../v3/account/whoami',
    ],
    ['a URL that does not parse', 'not a url'],
  ])('sends no token for %s', async (_label, url) => {
    await expect(requestFor(url, HOME_SERVER)).resolves.toMatchObject({
      authorization: null,
      redirect: 'follow',
    });
  });

  it('sends no token without a homeserver to scope it to', async () => {
    await expect(
      requestFor('https://mx.ixo.earth/_matrix/client/v1/media/download/a/b'),
    ).resolves.toMatchObject({ authorization: null });
  });

  it('sends nothing when there is no token', async () => {
    await fetchLinkedResourceDoc(
      {
        serviceEndpoint:
          'https://mx.ixo.earth/_matrix/client/v1/media/download/a/b',
      } as LinkedResource,
      undefined,
      HOME_SERVER,
    );

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(new Headers(init.headers).has('authorization')).toBe(false);
  });

  it('fails rather than following a redirect with the token', async () => {
    fetchMock.mockImplementation(async (_url: string, init: RequestInit) => {
      if (init.redirect === 'error') throw new TypeError('redirect refused');
      return new Response('{}');
    });

    await expect(
      requestFor(
        'https://mx.ixo.earth/_matrix/client/v1/media/download/a/b',
        HOME_SERVER,
      ),
    ).rejects.toThrow('redirect refused');
  });
});

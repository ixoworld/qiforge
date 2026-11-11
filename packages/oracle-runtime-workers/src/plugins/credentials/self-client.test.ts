import { describe, expect, it } from 'vitest';
import { sha256Hex } from './hub-client';
import { LINKS_PATH, SelfLinksClient } from './self-client';
import { json, noSleep, routedFetch, SELF } from './test-fixtures';

const WEB = 'https://dev.self.ixo.earth';
const LINK = { linkId: 'lnk_1', url: `${WEB}/l/tok`, expiresAt: 1793000900 };

function client(
  fetchImpl: (r: Request) => Promise<Response>,
  entityDid?: string,
) {
  const facts: Record<string, unknown>[][] = [];
  const self = new SelfLinksClient({
    selfUrl: SELF,
    webOrigin: WEB,
    ...(entityDid ? { entityDid } : {}),
    mint: async (f) => {
      facts.push(f);
      return `inv-${facts.length}`;
    },
    fetchImpl,
    sleep: noSleep,
  });
  return { self, facts };
}

describe('SelfLinksClient', () => {
  it('creates a link with a delegated invocation bound to POST /identity/v1/links', async () => {
    const { fetchImpl, calls } = routedFetch({
      [`POST ${SELF}${LINKS_PATH}`]: () => json(LINK, 201),
    });
    const { self, facts } = client(fetchImpl);
    await expect(
      self.createLink({ offerConsent: 'OFFER', requestKey: 'rk' }),
    ).resolves.toEqual(LINK);
    expect(calls[0]?.headers.get('authorization')).toBe('Bearer inv-1');
    expect(JSON.parse(calls[0]?.body ?? '')).toEqual({
      offerConsent: 'OFFER',
      requestKey: 'rk',
    });
    expect(facts).toEqual([
      [
        {
          method: 'POST',
          path: LINKS_PATH,
          body_sha256: await sha256Hex(calls[0]?.body ?? ''),
        },
      ],
    ]);
  });

  it('keeps the data of 409 link_active', async () => {
    const { fetchImpl } = routedFetch({
      [`POST ${SELF}${LINKS_PATH}`]: () =>
        json(
          {
            error: 'link_active',
            message: 'A link is open.',
            linkId: 'lnk_0',
            status: 'sent',
            expiresAt: 1793000500,
          },
          409,
        ),
    });
    const { self } = client(fetchImpl);
    await expect(
      self.createLink({ offerConsent: 'OFFER', requestKey: 'rk' }),
    ).rejects.toMatchObject({
      service: 'self',
      status: 409,
      code: 'link_active',
      body: { linkId: 'lnk_0', expiresAt: 1793000500 },
    });
  });

  it('answers 409 already_verified and 401 as typed refusals', async () => {
    const { fetchImpl } = routedFetch({
      [`POST ${SELF}${LINKS_PATH}`]: [
        () => json({ error: 'already_verified', message: 'x' }, 409),
        () => json({ error: 'unauthorized', message: 'x' }, 401),
      ],
    });
    const { self } = client(fetchImpl);
    await expect(
      self.createLink({ offerConsent: 'O', requestKey: 'a' }),
    ).rejects.toMatchObject({ code: 'already_verified' });
    await expect(
      self.createLink({ offerConsent: 'O', requestKey: 'b' }),
    ).rejects.toMatchObject({ status: 401, code: 'unauthorized' });
  });

  it("refuses a link that is not on Self's web app", async () => {
    const { fetchImpl } = routedFetch({
      [`POST ${SELF}${LINKS_PATH}`]: () =>
        json({ ...LINK, url: 'https://elsewhere.example/l/tok' }, 201),
    });
    const { self } = client(fetchImpl);
    await expect(
      self.createLink({ offerConsent: 'O', requestKey: 'a' }),
    ).rejects.toMatchObject({ code: 'invalid_response' });
  });

  it("names the oracle's entity in a second fact when configured", async () => {
    const { fetchImpl, calls } = routedFetch({
      [`POST ${SELF}${LINKS_PATH}`]: () => json(LINK, 201),
    });
    const entityDid = 'did:ixo:entity:309db22aa6e41e3929597dcb185a23be';
    const { self, facts } = client(fetchImpl, entityDid);
    await self.createLink({ offerConsent: 'OFFER', requestKey: 'rk' });
    expect(facts).toEqual([
      [
        {
          method: 'POST',
          path: LINKS_PATH,
          body_sha256: await sha256Hex(calls[0]?.body ?? ''),
        },
        { entityDid },
      ],
    ]);
  });

  it('reads a link status bound to GET and its path', async () => {
    const { fetchImpl } = routedFetch({
      [`GET ${SELF}${LINKS_PATH}/lnk_1`]: () =>
        json({
          linkId: 'lnk_1',
          status: 'in_progress',
          updatedAt: 1,
          expiresAt: 2,
        }),
    });
    const { self, facts } = client(fetchImpl);
    await expect(self.linkStatus('lnk_1')).resolves.toMatchObject({
      status: 'in_progress',
    });
    expect(facts).toEqual([[{ method: 'GET', path: `${LINKS_PATH}/lnk_1` }]]);
  });

  it('reads `failure` leniently: only a known value beside failed, never a parse error', async () => {
    const base = { linkId: 'lnk_1', updatedAt: 1, expiresAt: 2 };
    const cases: Array<[Record<string, unknown>, string | undefined]> = [
      [{ status: 'failed', failure: 'error' }, 'error'],
      [{ status: 'failed', failure: 'too_many_attempts' }, 'too_many_attempts'],
      [{ status: 'failed' }, undefined],
      [{ status: 'failed', failure: 'rate_limited' }, undefined],
      [{ status: 'failed', failure: 42 }, undefined],
      [{ status: 'failed', failure: null }, undefined],
      [{ status: 'failed', failure: { code: 'error' } }, undefined],
      [{ status: 'passed', failure: 'error' }, undefined],
      [{ status: 'in_progress', failure: 'too_many_attempts' }, undefined],
    ];
    const { fetchImpl } = routedFetch({
      [`GET ${SELF}${LINKS_PATH}/lnk_1`]: cases.map(
        ([body]) =>
          () =>
            json({ ...base, ...body }),
      ),
    });
    const { self } = client(fetchImpl);
    for (const [body, failure] of cases) {
      const state = await self.linkStatus('lnk_1');
      expect(state.status).toBe(body.status);
      expect('failure' in state).toBe(failure !== undefined);
      expect(state.failure).toBe(failure);
    }
  });
});

describe('SelfLinksClient transport', () => {
  it('calls the fetch it was given as a plain function (a host may pass the global; workerd refuses it as a method)', async () => {
    const strict = function (this: unknown, _request: Request) {
      if (this !== undefined && this !== globalThis)
        throw new TypeError('Illegal invocation');
      return Promise.resolve(json(LINK, 201));
    };
    const { self } = client(strict);
    await expect(
      self.createLink({ offerConsent: 'O', requestKey: 'a' }),
    ).resolves.toEqual(LINK);
  });
});

describe("SelfLinksClient: Self's answers as Self sends them", () => {
  // Self answers its times as ISO 8601 text and its errors as
  // `{ error: { code, message, retryable }, ...extra }` (errorBody).
  const ENDS_ISO = '2026-11-10T06:34:12.000Z';
  const ENDS = Date.UTC(2026, 10, 10, 6, 34, 12) / 1000;

  it('reads ISO 8601 and Unix-second times of a new link as Unix seconds', async () => {
    const { fetchImpl } = routedFetch({
      [`POST ${SELF}${LINKS_PATH}`]: [
        () => json({ ...LINK, expiresAt: ENDS_ISO }, 201),
        () => json({ ...LINK, expiresAt: ENDS }, 201),
        () => json({ ...LINK, expiresAt: '2026-11-10T10:34:12+04:00' }, 201),
      ],
    });
    const { self } = client(fetchImpl);
    for (const key of ['a', 'b', 'c'])
      await expect(
        self.createLink({ offerConsent: 'O', requestKey: key }),
      ).resolves.toEqual({ ...LINK, expiresAt: ENDS });
  });

  it('reads ISO 8601 and Unix-second times of a link status as Unix seconds', async () => {
    const { fetchImpl } = routedFetch({
      [`GET ${SELF}${LINKS_PATH}/lnk_1`]: [
        () =>
          json({
            linkId: 'lnk_1',
            status: 'opened',
            updatedAt: '2026-11-10T06:20:00.000Z',
            expiresAt: ENDS_ISO,
          }),
        () =>
          json({
            linkId: 'lnk_1',
            status: 'opened',
            updatedAt: Date.UTC(2026, 10, 10, 6, 20) / 1000,
            expiresAt: ENDS,
          }),
      ],
    });
    const { self } = client(fetchImpl);
    const expected = {
      linkId: 'lnk_1',
      status: 'opened',
      updatedAt: Date.UTC(2026, 10, 10, 6, 20) / 1000,
      expiresAt: ENDS,
    };
    await expect(self.linkStatus('lnk_1')).resolves.toEqual(expected);
    await expect(self.linkStatus('lnk_1')).resolves.toEqual(expected);
  });

  it('refuses a time that is not ISO 8601 with a zone, or not a time', async () => {
    const { fetchImpl } = routedFetch({
      [`POST ${SELF}${LINKS_PATH}`]: [
        // No zone: it would read as the runtime's local time.
        () => json({ ...LINK, expiresAt: '2026-11-10T06:34:12' }, 201),
        () => json({ ...LINK, expiresAt: 'Tue Nov 10 2026' }, 201),
        () => json({ ...LINK, expiresAt: '2026-13-45T99:99:99Z' }, 201),
        () => json({ ...LINK, expiresAt: -5 }, 201),
      ],
    });
    const { self } = client(fetchImpl);
    for (const key of ['a', 'b', 'c', 'd'])
      await expect(
        self.createLink({ offerConsent: 'O', requestKey: key }),
      ).rejects.toMatchObject({ status: 502, code: 'invalid_response' });
  });

  it("reads the code of Self's nested error, never its message, and keeps link_active's data", async () => {
    const { fetchImpl } = routedFetch({
      [`POST ${SELF}${LINKS_PATH}`]: [
        () =>
          json(
            {
              error: {
                code: 'link_active',
                message: 'A link is already open for this person.',
                retryable: false,
              },
              linkId: 'lnk_0',
              status: 'in_progress',
              expiresAt: ENDS_ISO,
            },
            409,
          ),
        () =>
          json(
            {
              error: {
                code: 'already_verified',
                message: "You're already verified.",
                retryable: false,
              },
            },
            409,
          ),
        () =>
          json(
            {
              error: {
                code: 'unauthorized',
                message: 'Please sign in again.',
                retryable: false,
              },
            },
            401,
          ),
        // A code outside the safe shape falls back to the HTTP status.
        () =>
          json(
            { error: { code: 'Not A Code!', message: 'x', retryable: false } },
            400,
          ),
      ],
    });
    const { self } = client(fetchImpl);
    const first = await self
      .createLink({ offerConsent: 'O', requestKey: 'a' })
      .catch((e: unknown) => e);
    expect(first).toMatchObject({
      service: 'self',
      status: 409,
      code: 'link_active',
      body: { linkId: 'lnk_0', status: 'in_progress', expiresAt: ENDS_ISO },
    });
    expect(String(first)).not.toContain('already open');
    await expect(
      self.createLink({ offerConsent: 'O', requestKey: 'b' }),
    ).rejects.toMatchObject({ status: 409, code: 'already_verified' });
    await expect(
      self.createLink({ offerConsent: 'O', requestKey: 'c' }),
    ).rejects.toMatchObject({ status: 401, code: 'unauthorized' });
    await expect(
      self.createLink({ offerConsent: 'O', requestKey: 'd' }),
    ).rejects.toMatchObject({ status: 400, code: 'http_400' });
  });
});

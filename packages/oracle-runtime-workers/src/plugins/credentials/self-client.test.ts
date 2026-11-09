import { describe, expect, it } from 'vitest';
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
    expect(facts).toEqual([[{ method: 'POST', path: LINKS_PATH }]]);
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
    const { fetchImpl } = routedFetch({
      [`POST ${SELF}${LINKS_PATH}`]: () => json(LINK, 201),
    });
    const entityDid = 'did:ixo:entity:309db22aa6e41e3929597dcb185a23be';
    const { self, facts } = client(fetchImpl, entityDid);
    await self.createLink({ offerConsent: 'OFFER', requestKey: 'rk' });
    expect(facts).toEqual([
      [{ method: 'POST', path: LINKS_PATH }, { entityDid }],
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
});

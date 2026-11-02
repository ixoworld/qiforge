import { beforeEach, describe, expect, it } from 'vitest';
import { resetUpstreamHealth, type ChainCall } from '../ixo-chain/http';
import { ACCEPT_CHECK_EVERY_MS, acceptedNote, newlyAccepted } from './accepted';
import {
  getDraft,
  recordSent,
  updateDraft,
  type Draft,
  type Kv,
} from './drafts';

const ADDRESS = 'ixo1cra6p0jefu8f907gqngkfzxur26k7f73an4v95';
const ADMIN = 'ixo1x4p6j0h3mzv8e7mhd6q9wquh2vqd9yh5ttnzyg';
const REST = 'https://rest.test';

function memoryKv(): Kv {
  const rows = new Map<string, unknown>();
  const copy = (v: unknown) =>
    v === undefined ? undefined : JSON.parse(JSON.stringify(v));
  return {
    get: async (ns: string, k: string) => copy(rows.get(`${ns}/${k}`)),
    set: async (ns: string, k: string, v: unknown) =>
      void rows.set(`${ns}/${k}`, copy(v)),
    update: async (ns: string, k: string, fn: (c: unknown) => unknown) => {
      const next = fn(copy(rows.get(`${ns}/${k}`)));
      if (next === undefined) rows.delete(`${ns}/${k}`);
      else rows.set(`${ns}/${k}`, copy(next));
      return copy(next);
    },
    delete: async (ns: string, k: string) => void rows.delete(`${ns}/${k}`),
  };
}

/** A chain whose admin has (or has not) let the person log work on 9787. */
function chain(state: { allowed: boolean }) {
  const urls: string[] = [];
  const call: ChainCall = {
    network: 'mainnet',
    restUrl: REST,
    blocksyncUrl: 'https://blocksync.test/graphql',
    user: `did:ixo:${ADDRESS}`,
    deadline: Date.now() + 20_000,
    signal: new AbortController().signal,
    fetch: async (input) => {
      urls.push(String(input));
      return Response.json({
        grants: state.allowed
          ? [
              {
                authorization: {
                  '@type': '/ixo.claims.v1beta1.SubmitClaimAuthorization',
                  constraints: [{ collection_id: '9787', agent_quota: '1' }],
                },
              },
            ]
          : [],
      });
    },
  };
  return { call, urls };
}

const sentApplication = (collectionId: string): Draft => ({
  v: 1,
  form: 'application',
  collectionId,
  entityDid: 'did:ixo:entity:0123456789abcdef0123456789abcdef',
  protocolDid: 'did:ixo:entity:11111111111111111111111111111111',
  admin: ADMIN,
  title: 'Mapping local shops',
  startedAt: '2026-11-01T08:00:00.000Z',
  updatedAt: '2026-11-01T08:05:00.000Z',
  data: {},
  skipped: [],
  closedSections: [],
  evidence: [],
  cardAttempt: 0,
  submittedAt: '2026-11-01T08:06:00.000Z',
});

async function applied(kv: Kv, collectionId = '9787') {
  await updateDraft(kv, 'application', collectionId, () =>
    sentApplication(collectionId),
  );
  await recordSent(kv, {
    form: 'application',
    collectionId,
    title: 'Mapping local shops',
    submittedAt: '2026-11-01T08:06:00.000Z',
  });
}

beforeEach(resetUpstreamHealth);

describe('telling them they were accepted', () => {
  it('says it once, on the first message after the permission appears', async () => {
    const kv = memoryKv();
    await applied(kv);
    const { call } = chain({ allowed: true });
    const now = new Date('2026-11-02T10:00:00Z');
    expect(await newlyAccepted(kv, call, ADDRESS, now)).toEqual([
      { collectionId: '9787', title: 'Mapping local shops' },
    ]);
    const later = new Date(now.getTime() + 2 * ACCEPT_CHECK_EVERY_MS);
    expect(await newlyAccepted(kv, call, ADDRESS, later)).toEqual([]);
    const lookup = await getDraft(kv, 'application', '9787');
    expect(lookup.ok && lookup.draft?.acceptance?.announcedAt).toBe(
      now.toISOString(),
    );
  });

  it('asks the chain at most every few minutes while they wait, then tells them', async () => {
    const kv = memoryKv();
    await applied(kv);
    const state = { allowed: false };
    const { call, urls } = chain(state);
    const now = new Date('2026-11-02T10:00:00Z');
    expect(await newlyAccepted(kv, call, ADDRESS, now)).toEqual([]);
    expect(urls).toHaveLength(1);
    expect(urls[0]).toContain(`granter=${ADMIN}&grantee=${ADDRESS}`);
    state.allowed = true;
    const soon = new Date(now.getTime() + 60_000);
    expect(await newlyAccepted(kv, call, ADDRESS, soon)).toEqual([]);
    expect(urls).toHaveLength(1);
    const later = new Date(now.getTime() + ACCEPT_CHECK_EVERY_MS);
    expect(await newlyAccepted(kv, call, ADDRESS, later)).toHaveLength(1);
  });

  it('stays quiet when they already log work on the job', async () => {
    const kv = memoryKv();
    await applied(kv);
    await recordSent(kv, {
      form: 'claim',
      collectionId: '9787',
      title: 'Mapping local shops',
      submittedAt: '2026-11-02T09:00:00.000Z',
    });
    const { call, urls } = chain({ allowed: true });
    expect(
      await newlyAccepted(kv, call, ADDRESS, new Date('2026-11-02T10:00:00Z')),
    ).toEqual([]);
    expect(urls).toEqual([]);
    const lookup = await getDraft(kv, 'application', '9787');
    expect(lookup.ok && lookup.draft?.acceptance?.announcedAt).toBeTruthy();
  });

  it('asks the model to lead with the news and offer to log work', () => {
    const note = acceptedNote([
      { collectionId: '9787', title: 'Mapping local shops' },
    ]);
    expect(note).toContain('"Mapping local shops" (collectionId 9787)');
    expect(note).toContain('Good news: you were accepted for');
    expect(note).toContain('logging work');
  });
});

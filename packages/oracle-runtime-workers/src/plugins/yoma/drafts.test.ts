import { describe, expect, it } from 'vitest';
import {
  allDrafts,
  draftKey,
  getDraft,
  MAX_DRAFTS,
  MAX_SENT,
  recordSent,
  sentItems,
  updateDraft,
  type Draft,
  type Kv,
} from './drafts';

function memoryKv(): Kv & { rows: Map<string, unknown> } {
  const rows = new Map<string, unknown>();
  const copy = (v: unknown) =>
    v === undefined ? undefined : JSON.parse(JSON.stringify(v));
  return {
    rows,
    get: async (ns, k) => copy(rows.get(`${ns}/${k}`)),
    set: async (ns, k, v) => void rows.set(`${ns}/${k}`, copy(v)),
    update: async (ns, k, fn) => {
      const next = fn(copy(rows.get(`${ns}/${k}`)));
      if (next === undefined) rows.delete(`${ns}/${k}`);
      else rows.set(`${ns}/${k}`, copy(next));
      return copy(next);
    },
    delete: async (ns, k) => void rows.delete(`${ns}/${k}`),
  };
}

const draft = (collectionId: string, extra: Partial<Draft> = {}): Draft => ({
  v: 1,
  form: 'claim',
  collectionId,
  entityDid: 'did:ixo:entity:00000000000000000000000000000000',
  protocolDid: 'did:ixo:entity:11111111111111111111111111111111',
  admin: 'ixo1admin',
  title: 'Job',
  startedAt: '2026-10-30T00:00:00.000Z',
  updatedAt: '2026-10-30T00:00:00.000Z',
  data: {},
  skipped: [],
  closedSections: [],
  evidence: [],
  cardAttempt: 0,
  ...extra,
});

describe('drafts', () => {
  it('counts only open drafts towards the cap: a sent one leaves the index', async () => {
    const kv = memoryKv();
    for (let i = 1; i <= MAX_DRAFTS; i++)
      expect(
        (await updateDraft(kv, 'claim', String(i), () => draft(String(i)))).ok,
      ).toBe(true);
    expect(
      await updateDraft(kv, 'claim', '99', () => draft('99')),
    ).toMatchObject({
      ok: false,
      failure: { reason: 'too_large' },
    });
    expect(
      (await getDraft(kv, 'claim', '99')).ok &&
        (await getDraft(kv, 'claim', '99')),
    ).toMatchObject({ draft: undefined });
    // One is sent: it stays readable but no longer counts.
    await updateDraft(kv, 'claim', '1', (c) =>
      c ? { ...c, submittedAt: '2026-10-30T01:00:00.000Z' } : c,
    );
    expect((await allDrafts(kv)).length).toBe(MAX_DRAFTS - 1);
    expect((await getDraft(kv, 'claim', '1')).ok).toBe(true);
    expect((await updateDraft(kv, 'claim', '99', () => draft('99'))).ok).toBe(
      true,
    );
  });

  it('never overwrites an unreadable draft, and refuses a change that is not a draft', async () => {
    const kv = memoryKv();
    kv.rows.set(`yoma/${draftKey('claim', '5')}`, { v: 1, broken: true });
    expect(await updateDraft(kv, 'claim', '5', () => draft('5'))).toMatchObject(
      {
        ok: false,
        failure: { reason: 'unavailable' },
      },
    );
    expect(kv.rows.get(`yoma/${draftKey('claim', '5')}`)).toEqual({
      v: 1,
      broken: true,
    });
    // Deleting it is allowed.
    expect((await updateDraft(kv, 'claim', '5', () => undefined)).ok).toBe(
      true,
    );
    expect(kv.rows.has(`yoma/${draftKey('claim', '5')}`)).toBe(false);

    await updateDraft(kv, 'claim', '6', () => draft('6'));
    expect(
      await updateDraft(kv, 'claim', '6', (c) =>
        c ? { ...c, evidence: Array(31).fill(c.evidence[0]) } : c,
      ),
    ).toMatchObject({ ok: false });
    expect((await getDraft(kv, 'claim', '6')).ok).toBe(true);
  });

  it('lets a change refuse, leaving the draft as it is', async () => {
    const kv = memoryKv();
    await updateDraft(kv, 'claim', '7', () => draft('7'));
    const refused = await updateDraft(kv, 'claim', '7', () => ({
      refuse: { reason: 'invalid_input', detail: 'no', retryable: false },
    }));
    expect(refused).toEqual({
      ok: false,
      failure: { reason: 'invalid_input', detail: 'no', retryable: false },
    });
    expect(await getDraft(kv, 'claim', '7')).toMatchObject({
      ok: true,
      draft: { collectionId: '7' },
    });
  });

  it('records each sent card once, keeping the newest', async () => {
    const kv = memoryKv();
    const item = {
      form: 'claim' as const,
      collectionId: '1',
      title: 'Job',
      submittedAt: '2026-10-30T00:00:00.000Z',
      actionId: 'a1',
    };
    await recordSent(kv, item);
    await recordSent(kv, item);
    expect(await sentItems(kv)).toHaveLength(1);
    for (let i = 0; i < MAX_SENT + 5; i++)
      await recordSent(kv, { ...item, actionId: `b${i}` });
    const items = await sentItems(kv);
    expect(items).toHaveLength(MAX_SENT);
    expect(items.at(-1)?.actionId).toBe(`b${MAX_SENT + 4}`);
  });
});

import { describe, expect, it } from 'vitest';
import { HubActionClient } from './client';
import type { ActionReferenceV1, ActionOutcomeV1 } from '@ixo/action-protocol';

const id = 'B'.repeat(32);
const reference: ActionReferenceV1 = {
  version: 'ixo.auth-action/1',
  id,
  accountId: 'account-two',
  bindingId: 'chb_two',
  bindingRevision: 3,
  revision: 1,
  digest: 'c'.repeat(64),
  url: `https://hub.test/a/${id}`,
  expiresAt: 1999999999999,
  title: 'Review form',
};
const outcome: ActionOutcomeV1 = {
  version: 'ixo.auth-outcome/1',
  eventId: 'event-two',
  reference,
  ownerDid: 'did:ixo:second',
  authorizedRevision: 1,
  authorizedDigest: reference.digest,
  sequence: 1,
  status: 'declined',
  receipt: null,
  occurredAt: 1770000000001,
};

describe('Hub action HTTP client', () => {
  it('sends a registered operation with service authentication and reads its typed outcome', async () => {
    const seen: Request[] = [];
    const client = new HubActionClient({
      origin: 'https://hub.test/',
      key: 'oracle-secret',
      fetcher: {
        fetch: async (request) => {
          seen.push(request);
          if (request.method === 'POST') return Response.json({ reference });
          return Response.json({
            reference,
            ownerDid: outcome.ownerDid,
            revision: 1,
            digest: reference.digest,
            reviewStatus: 'declined',
            operationStatus: 'failed',
            outcome,
          });
        },
      },
    });
    const operation = {
      kind: 'form.submit.v1' as const,
      formId: 'form-one',
      destination: 'registered-form',
      fields: [
        {
          id: 'answer',
          label: 'Answer',
          type: 'text' as const,
          required: true,
          value: 'Yes',
          source: 'user' as const,
        },
      ],
      declaration: null,
    };
    expect(
      await client.request({
        bindingId: reference.bindingId,
        bindingRevision: reference.bindingRevision,
        requestKey: 'run:call',
        expiresAt: reference.expiresAt,
        operation,
      }),
    ).toEqual(reference);
    expect(await client.status(id)).toMatchObject({ outcome });
    expect(seen.map((r) => `${r.method} ${new URL(r.url).pathname}`)).toEqual([
      'POST /api/internal/actions/operations',
      `GET /api/internal/actions/operations/${id}`,
    ]);
    expect(
      seen.every(
        (r) => r.headers.get('x-channels-service-key') === 'oracle-secret',
      ),
    ).toBe(true);
    expect(await seen[0]?.json()).toMatchObject({
      bindingId: 'chb_two',
      operation,
    });
  });

  it('rejects a reference from a different Hub origin', async () => {
    const client = new HubActionClient({
      origin: 'https://hub.test/',
      key: 'oracle-secret',
      fetcher: {
        fetch: async () =>
          Response.json({
            reference: {
              ...reference,
              url: `https://other.test/a/${id}`,
            },
          }),
      },
    });
    await expect(
      client.request({
        bindingId: 'chb_two',
        bindingRevision: 3,
        requestKey: 'run:call',
        expiresAt: reference.expiresAt,
        operation: {
          kind: 'resource.read.v1',
          resourceId: 'file-one',
          ownerDid: 'did:ixo:second',
          url: 'https://files.test/file-one',
          version: 'v1',
          contentDigest: 'd'.repeat(64),
        },
      }),
    ).rejects.toThrow();
  });
});

import { env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import type { HubActionTestDO } from './test-do';
import type { ActionReferenceV1, ActionOutcomeV1 } from '@ixo/action-protocol';
import { HubActionClient } from './client';
import { prepareHubAction } from './request';

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace -- Cloudflare test binding augmentation
  namespace Cloudflare {
    interface Env {
      HUB_ACTION_TEST: DurableObjectNamespace<HubActionTestDO>;
    }
  }
}

const ownerDid = 'did:ixo:owner';
const id = 'A'.repeat(32);
const digest = 'a'.repeat(64);
const reference: ActionReferenceV1 = {
  version: 'ixo.auth-action/1',
  id,
  accountId: 'account-one',
  bindingId: 'chb_one',
  bindingRevision: 2,
  revision: 1,
  digest,
  url: `https://hub.test/a/${id}`,
  expiresAt: 1999999999999,
  title: 'Review form',
};
const origin = {
  ownerDid,
  sessionId: 'session-one',
  runId: 'run-one',
  requestId: 'request-one',
  bindingId: reference.bindingId,
  bindingRevision: reference.bindingRevision,
  requestKey: 'run-one:tool-one',
};
const outcome: ActionOutcomeV1 = {
  version: 'ixo.auth-outcome/1',
  eventId: 'event-one',
  reference,
  ownerDid,
  authorizedRevision: 1,
  authorizedDigest: digest,
  sequence: 2,
  status: 'succeeded',
  receipt: {
    kind: 'form.submission.v1',
    actionId: id,
    revision: 1,
    digest,
    valuesDigest: 'b'.repeat(64),
    submittedAt: 1770000000000,
    submissionId: 'submission-one',
  },
  occurredAt: 1770000000001,
};
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

describe('Hub action Durable Object store', () => {
  it('keeps original turn and typed outcome across reopen and scopes owner reads', async () => {
    const stub = env.HUB_ACTION_TEST.get(
      env.HUB_ACTION_TEST.idFromName('original-turn'),
    );
    expect(await stub.record(origin, reference)).toEqual(reference);
    expect(await stub.record(origin, reference)).toEqual(reference);
    await stub.outcome(outcome);
    await stub.outcome(outcome);
    await stub.reopen();
    expect(await stub.get(ownerDid, id)).toEqual({ origin, reference });
    expect(await stub.get('did:ixo:other', id)).toBeNull();
    expect(await stub.forRun(ownerDid, origin.sessionId, origin.runId)).toEqual(
      [outcome],
    );
    expect(await stub.forRun(ownerDid, origin.sessionId, 'other-run')).toEqual(
      [],
    );
  });

  it('never regresses on out-of-order events with the same timestamp', async () => {
    const stub = env.HUB_ACTION_TEST.get(
      env.HUB_ACTION_TEST.idFromName('outcome-sequence'),
    );
    await stub.record(origin, reference);
    expect(await stub.outcome(outcome)).toBe(true);
    // An older outcome than the latest stored changes nothing.
    expect(
      await stub.outcome({
        ...outcome,
        eventId: 'event-late-arrival',
        sequence: 1,
        status: 'submitted',
        receipt: null,
      }),
    ).toBe(false);
    await stub.reopen();
    expect(await stub.forRun(ownerDid, origin.sessionId, origin.runId)).toEqual(
      [outcome],
    );
  });

  it('retries lost HTTP response after reopen using the same reserved request bytes', async () => {
    const stub = env.HUB_ACTION_TEST.get(
      env.HUB_ACTION_TEST.idFromName('lost-response'),
    );
    const sent: unknown[] = [];
    const nowMs = Date.now();
    const replayReference = {
      ...reference,
      expiresAt: Math.floor(nowMs / 1000) + 900,
    };
    const client = new HubActionClient({
      origin: 'https://hub.test',
      key: 'oracle-secret',
      fetcher: {
        fetch: async (request) => {
          if (request.method === 'GET')
            return Response.json({
              version: 'ixo.auth-capabilities/1',
              accountId: reference.accountId,
              oracleDid: 'did:ixo:oracle',
              network: null,
              resourceOrigin: null,
              operations: ['form.submit.v1'],
              transfer: null,
              forms: [
                {
                  formId: 'form-one',
                  destination: 'registered-form',
                  fields: [
                    {
                      id: 'answer',
                      label: 'Answer',
                      type: 'text',
                      required: true,
                    },
                  ],
                  declaration: null,
                },
              ],
            });
          sent.push(await request.json());
          if (sent.length === 1)
            throw new Error('response lost after Hub committed');
          return Response.json({ reference: replayReference });
        },
      },
    });
    const input = { ...origin, provider: 'whatsapp', operation };
    await expect(prepareHubAction(client, stub, input, nowMs)).rejects.toThrow(
      'response lost',
    );
    await stub.reopen();
    expect(await prepareHubAction(client, stub, input, nowMs + 60_000)).toEqual(
      replayReference,
    );
    expect(sent).toHaveLength(2);
    expect(sent[0]).toEqual(sent[1]);
    expect(await stub.get(ownerDid, id)).toMatchObject({
      origin,
      reference: replayReference,
    });
  });

  it('has no per-run or per-user prepare cap and refuses a lapsed reservation instead of posting it', async () => {
    const stub = env.HUB_ACTION_TEST.get(
      env.HUB_ACTION_TEST.idFromName('no-caps-and-expiry'),
    );
    const now = Math.floor(Date.now() / 1000);
    await stub.reserve(origin, operation, now + 900);
    await stub.reserve(
      { ...origin, requestKey: 'run-one:tool-two' },
      operation,
      now + 900,
    );
    // A retry of a reserved key is not a new prepare.
    expect(await stub.reserve(origin, operation, now + 900)).toBe(now + 900);
    // A third, fourth, … request in the same run is reserved like the
    // first: no usage caps.
    for (const key of ['run-one:tool-three', 'run-one:tool-four'])
      expect(
        await stub.reserve(
          { ...origin, requestKey: key },
          operation,
          now + 900,
        ),
      ).toBe(now + 900);
    // A reservation that lapsed with no reference recorded: no POST.
    const posted: unknown[] = [];
    const client = {
      capabilities: async () => ({
        version: 'ixo.auth-capabilities/1' as const,
        accountId: reference.accountId,
        oracleDid: 'did:ixo:oracle',
        network: null,
        resourceOrigin: null,
        operations: ['form.submit.v1' as const],
        transfer: null,
        forms: [
          {
            formId: 'form-one',
            destination: 'registered-form',
            fields: [
              {
                id: 'answer',
                label: 'Answer',
                type: 'text' as const,
                required: true,
              },
            ],
            declaration: null,
          },
        ],
      }),
      request: async (body: unknown) => {
        posted.push(body);
        return reference;
      },
    };
    const late = Date.now() + 16 * 60_000;
    await expect(
      prepareHubAction(
        client,
        stub,
        { ...origin, provider: 'whatsapp', operation },
        late,
      ),
    ).rejects.toThrow('expired before it reached Auth Hub');
    expect(posted).toEqual([]);
  });

  it('prunes rows 30 days after their review expired', async () => {
    const stub = env.HUB_ACTION_TEST.get(
      env.HUB_ACTION_TEST.idFromName('prune'),
    );
    const old = Math.floor(Date.now() / 1000) - 31 * 24 * 60 * 60;
    const oldRef = { ...reference, expiresAt: old };
    await stub.reserve(origin, operation, old);
    await stub.record(origin, oldRef);
    await stub.outcome({ ...outcome, reference: oldRef });
    expect(await stub.prune()).toBe(2);
    expect(await stub.get(ownerDid, id)).toBeNull();
    expect(await stub.prune()).toBe(0);
  });
});

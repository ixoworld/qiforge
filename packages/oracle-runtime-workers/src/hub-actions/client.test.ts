import { describe, expect, it, vi } from 'vitest';
import { HUB_CHAIN_TX_PREPARE_TIMEOUT_MS, HubActionClient } from './client';
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
  it('requests version 3 options (with the owner tokens) at protocol version 4 for the trusted binding', async () => {
    const requests: Request[] = [];
    const options = {
      version: 'ixo.auth-options/3',
      accountId: reference.accountId,
      ownerDid: 'did:ixo:second',
      bindingId: reference.bindingId,
      bindingRevision: reference.bindingRevision,
      connections: [
        {
          service: 'gmail',
          id: 'gmail-one',
          label: 'sender@example.test',
          scopes: ['https://www.googleapis.com/auth/gmail.compose'],
        },
      ],
      targets: [],
      resources: [],
      transfer: {
        tokens: [
          {
            denom: 'uixo',
            symbol: 'IXO',
            decimals: 6,
            verified: true,
            balanceBaseUnits: '1000000',
          },
        ],
      },
    };
    const client = new HubActionClient({
      origin: 'https://hub.test',
      key: 'oracle-secret',
      fetcher: {
        fetch: async (request) => {
          requests.push(request);
          return Response.json(options);
        },
      },
    });
    expect(
      await client.options({
        bindingId: reference.bindingId,
        bindingRevision: reference.bindingRevision,
      }),
    ).toEqual(options);
    expect(new URL(requests[0]!.url).searchParams.get('version')).toBe('4');
    expect(new URL(requests[0]!.url).searchParams.get('bindingId')).toBe(
      'chb_two',
    );
  });

  it('rejects options older than version 3 (no token list) instead of guessing', async () => {
    const client = new HubActionClient({
      origin: 'https://hub.test',
      key: 'oracle-secret',
      fetcher: {
        fetch: async () =>
          Response.json({
            version: 'ixo.auth-options/2',
            accountId: reference.accountId,
            ownerDid: 'did:ixo:second',
            bindingId: reference.bindingId,
            bindingRevision: reference.bindingRevision,
            connections: [],
            targets: [],
            resources: [],
          }),
      },
    });
    await expect(
      client.options({
        bindingId: reference.bindingId,
        bindingRevision: reference.bindingRevision,
      }),
    ).rejects.toThrow('version 3');
  });
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

  it('declares protocol version 4 on capabilities, prepare and status, and reads v2 outcomes', async () => {
    const urls: string[] = [];
    const v2 = {
      ...outcome,
      version: 'ixo.auth-outcome/2' as const,
      sequence: 5,
      status: 'expired' as const,
    };
    const client = new HubActionClient({
      origin: 'https://hub.test',
      key: 'oracle-secret',
      fetcher: {
        fetch: async (request) => {
          const url = new URL(request.url);
          urls.push(`${request.method} ${url.pathname}${url.search}`);
          if (url.pathname.endsWith('/capabilities'))
            return Response.json({
              version: 'ixo.auth-capabilities/2',
              accountId: reference.accountId,
              oracleDid: 'did:ixo:oracle',
              network: null,
              resourceOrigin: null,
              operations: ['statement.sign.v1'],
              transfer: null,
              forms: [],
            });
          if (request.method === 'POST') return Response.json({ reference });
          return Response.json({
            reference,
            ownerDid: 'did:ixo:second',
            revision: 1,
            digest: reference.digest,
            reviewStatus: 'expired',
            operationStatus: 'not_started',
            outcome: v2,
          });
        },
      },
    });
    expect((await client.capabilities()).operations).toEqual([
      'statement.sign.v1',
    ]);
    await client.request({
      bindingId: reference.bindingId,
      bindingRevision: reference.bindingRevision,
      requestKey: 'k'.repeat(64),
      expiresAt: 1999999999,
      operation: {
        kind: 'statement.sign.v1',
        statement: 'These are my words.',
        purpose: 'Keep a signed record',
        audienceId: 'self',
      },
    });
    expect((await client.status(id)).outcome).toEqual(v2);
    expect(urls).toEqual([
      'GET /api/internal/actions/operations/capabilities?version=4',
      'POST /api/internal/actions/operations?version=4',
      `GET /api/internal/actions/operations/${id}?version=4`,
    ]);
  });

  it('turns a Hub transfer refusal (400) into a refusal the model can relay', async () => {
    let answer: unknown = {
      error: 'fee_above_ceiling',
      reason: 'fee 250000 > 100000',
    };
    let status = 400;
    const client = new HubActionClient({
      origin: 'https://hub.test',
      key: 'oracle-secret',
      fetcher: {
        fetch: async () => Response.json(answer, { status }),
      },
    });
    const send = () =>
      client.request({
        bindingId: reference.bindingId,
        bindingRevision: reference.bindingRevision,
        requestKey: 'k'.repeat(64),
        expiresAt: 1999999999,
        operation: {
          kind: 'ixo.bank.send.v1',
          chainId: 'pandora-8',
          network: 'ixo testnet',
          fromAddress: 'ixo1qyqszqgpqyqszqgpqyqszqgpqyqszqgpdxlvf0',
          toAddress: 'ixo1qgpqyqszqgpqyqszqgpqyqszqgpqyqszuzefze',
          amountBaseUnits: '5',
          denom: 'uixo',
          memo: '',
        },
      });
    await expect(send()).rejects.toMatchObject({
      name: 'HubActionRefused',
      kind: 'refused',
      message:
        "The network fee for this transfer is above this oracle's fee limit: fee 250000 > 100000.",
    });
    answer = { error: 'simulation_failed' };
    await expect(send()).rejects.toMatchObject({
      name: 'HubActionRefused',
      message: 'Auth Hub simulated this transfer and it would fail on chain.',
    });
    // Any other 400 stays a plain transport error.
    answer = { error: 'invalid_operation' };
    await expect(send()).rejects.toThrow('Hub action request returned 400');
    // Temporary: a sequence race (409) or the transfer path down (503).
    for (const [code, error] of [
      [409, 'sequence_mismatch'],
      [503, 'transfer_unavailable'],
    ] as const) {
      status = code;
      answer = { error };
      await expect(send()).rejects.toMatchObject({
        name: 'HubActionRefused',
        message: `Auth Hub is temporarily unavailable for this (${error}); try again shortly.`,
      });
    }
    // Deterministic: any other 409 is not available for this account.
    status = 409;
    answer = { error: 'operation_not_enabled' };
    await expect(send()).rejects.toMatchObject({
      name: 'HubActionRefused',
      message:
        'This operation is not available for this account (operation_not_enabled).',
    });
    // A 503 without a mapped code stays a transport error.
    status = 503;
    answer = { error: 'maintenance' };
    await expect(send()).rejects.toThrow('Hub action request returned 503');
    // No account or link for the owner, a rate limit: fixed words.
    status = 404;
    answer = { error: 'not_found' };
    await expect(send()).rejects.toMatchObject({
      name: 'HubActionRefused',
      message:
        'Auth Hub has no completed account or active channel link for this owner (not_found); retrying or changing the fields will not help.',
    });
    status = 429;
    answer = { error: 'channel_service_rate_limited' };
    await expect(send()).rejects.toMatchObject({
      name: 'HubActionRefused',
      message:
        'Auth Hub is limiting requests from this oracle right now (channel_service_rate_limited); try again later.',
    });
  });

  it('gives a chain-transaction prepare 15 s (Auth Hub bounds its own at about 8 s) and every other call 10 s', async () => {
    const timeout = vi.spyOn(AbortSignal, 'timeout');
    try {
      const client = new HubActionClient({
        origin: 'https://hub.test',
        key: 'oracle-secret',
        fetcher: {
          fetch: async () => Response.json({ reference }),
        },
      });
      const common = {
        bindingId: reference.bindingId,
        bindingRevision: reference.bindingRevision,
        requestKey: 'k'.repeat(64),
        expiresAt: 1999999999,
      };
      await client.request({
        ...common,
        operation: {
          kind: 'ixo.chain.tx.v1',
          chainId: 'pandora-8',
          network: 'ixo testnet',
          signer: 'ixo1qyqszqgpqyqszqgpqyqszqgpqyqszqgpdxlvf0',
          memo: '',
          messages: [
            {
              type: 'cosmos.bank.send',
              toAddress: 'ixo1qgpqyqszqgpqyqszqgpqyqszqgpqyqszuzefze',
              amountBaseUnits: '1',
            },
          ],
        },
      });
      expect(timeout).toHaveBeenLastCalledWith(HUB_CHAIN_TX_PREPARE_TIMEOUT_MS);
      expect(HUB_CHAIN_TX_PREPARE_TIMEOUT_MS).toBe(15_000);
      await client.request({
        ...common,
        operation: {
          kind: 'ixo.bank.send.v1',
          chainId: 'pandora-8',
          network: 'ixo testnet',
          fromAddress: 'ixo1qyqszqgpqyqszqgpqyqszqgpqyqszqgpdxlvf0',
          toAddress: 'ixo1qgpqyqszqgpqyqszqgpqyqszqgpqyqszuzefze',
          amountBaseUnits: '5',
          denom: 'uixo',
          memo: '',
        },
      });
      expect(timeout).toHaveBeenLastCalledWith(10_000);
    } finally {
      timeout.mockRestore();
    }
  });

  it('reads connection options at version 2 (no balances read) for the Gmail check', async () => {
    const urls: URL[] = [];
    const client = new HubActionClient({
      origin: 'https://hub.test',
      key: 'oracle-secret',
      fetcher: {
        fetch: async (request) => {
          urls.push(new URL(request.url));
          return Response.json({
            version: 'ixo.auth-options/2',
            accountId: reference.accountId,
            ownerDid: 'did:ixo:second',
            bindingId: reference.bindingId,
            bindingRevision: reference.bindingRevision,
            connections: [],
            targets: [],
            resources: [],
          });
        },
      },
    });
    expect(
      (
        await client.connectionOptions({
          bindingId: reference.bindingId,
          bindingRevision: reference.bindingRevision,
        })
      ).version,
    ).toBe('ixo.auth-options/2');
    expect(urls[0]?.searchParams.get('version')).toBe('2');
  });
});

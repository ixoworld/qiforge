import { describe, expect, it, vi } from 'vitest';
import { makeRuntimeContext } from '../../core/test-fixtures';
import { HUB_ACTION_CARD_NOTE, HubActionsPlugin } from './hub-actions.plugin';
import { HubActionClient } from '../../hub-actions/client';
import { prepareHubAction } from '../../hub-actions/request';
import type { HubActionOptionsV3, P2Operation } from '@ixo/action-protocol';
import { HubActionRefused } from '../../hub-actions/store';

const id = 'C'.repeat(32);
const reference = {
  version: 'ixo.auth-action/1' as const,
  id,
  accountId: 'account-three',
  bindingId: 'chb_three',
  bindingRevision: 4,
  revision: 1,
  digest: 'c'.repeat(64),
  url: `https://hub.test/a/${id}`,
  expiresAt: 1999999999999,
  title: 'Review form',
};
const operation = {
  kind: 'form.submit.v1' as const,
  formId: 'form-three',
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
const options: HubActionOptionsV3 = {
  version: 'ixo.auth-options/3',
  accountId: 'account-three',
  ownerDid: 'did:ixo:owner',
  bindingId: 'chb_three',
  bindingRevision: 4,
  connections: [],
  targets: [],
  resources: [],
  transfer: null,
};

describe('Hub actions Workers plugin', () => {
  it('uses only runtime channel identity and original tool invocation', async () => {
    const request = vi.fn(async () => reference);
    const ctx = makeRuntimeContext({
      config: { HUB_ACTIONS_ENABLED: 'true' },
      user: {
        did: 'did:ixo:owner',
        matrixUserId: '@owner:test',
        ucanDelegation: { raw: 'delegation' },
      },
      session: {
        id: 'session-three',
        client: 'channel',
        requestId: 'request-three',
        runId: 'run-three',
        channel: {
          provider: 'whatsapp',
          bindingId: 'chb_three',
          bindingRevision: 4,
        },
      },
      toolCallId: 'tool-three',
      hubActions: {
        options: async () => options,
        capabilities: async () => ({
          version: 'ixo.auth-capabilities/1',
          accountId: 'account-three',
          oracleDid: 'did:ixo:oracle',
          network: null,
          resourceOrigin: null,
          operations: ['form.submit.v1'],
          transfer: null,
          forms: [
            {
              formId: 'form-three',
              destination: 'registered-form',
              fields: [
                { id: 'answer', label: 'Answer', type: 'text', required: true },
              ],
              declaration: null,
            },
          ],
        }),
        request,
        transfer: async () => {
          throw new Error('unused');
        },
        status: async () => ({ outcome: null, summary: null }),
      },
    });
    const tool = new HubActionsPlugin()
      .getTools()
      .find((item) => item.name === 'request_hub_action');
    if (!tool) throw new Error('request tool missing');
    expect(await tool.handler({ operation }, ctx)).toEqual({
      status: 'prepared',
      actionReference: reference,
      summary: 'Review form',
    });
    expect(request).toHaveBeenCalledWith({
      ownerDid: 'did:ixo:owner',
      sessionId: 'session-three',
      runId: 'run-three',
      requestId: 'request-three',
      provider: 'whatsapp',
      bindingId: 'chb_three',
      bindingRevision: 4,
      // A fixed-length digest of run and tool call (the Hub allows 120
      // characters; a channel run id alone is 72).
      requestKey: Array.from(
        new Uint8Array(
          await crypto.subtle.digest(
            'SHA-256',
            new TextEncoder().encode('run-three:tool-three'),
          ),
        ),
        (b) => b.toString(16).padStart(2, '0'),
      ).join(''),
      operation,
    });
    const other = makeRuntimeContext({
      ...ctx,
      session: { ...ctx.session, channel: undefined },
    });
    expect(await tool.handler({ operation }, other)).toMatchObject({
      status: 'unavailable',
    });
    expect(request).toHaveBeenCalledTimes(1);
  });

  it('sends epoch-second expiry through the real tool and HTTP adapter', async () => {
    let sent: Record<string, unknown> | undefined;
    const client = new HubActionClient({
      origin: 'https://hub.test',
      key: 'oracle-secret',
      fetcher: {
        fetch: async (request) => {
          if (request.method === 'GET')
            return Response.json({
              version: 'ixo.auth-capabilities/1',
              accountId: 'account-three',
              oracleDid: 'did:ixo:oracle',
              network: null,
              resourceOrigin: null,
              operations: ['form.submit.v1'],
              transfer: null,
              forms: [
                {
                  formId: 'form-three',
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
          sent = (await request.json()) as Record<string, unknown>;
          return Response.json({ reference });
        },
      },
    });
    const ctx = makeRuntimeContext({
      config: { HUB_ACTIONS_ENABLED: 'true' },
      user: {
        did: 'did:ixo:owner',
        matrixUserId: '@owner:test',
        ucanDelegation: { raw: 'delegation' },
      },
      session: {
        id: 'session-three',
        client: 'channel',
        requestId: 'request-three',
        runId: 'run-three',
        channel: {
          provider: 'whatsapp',
          bindingId: 'chb_three',
          bindingRevision: 4,
        },
      },
      toolCallId: 'tool-three',
      hubActions: {
        options: async () => options,
        capabilities: () => client.capabilities(),
        request: (input) =>
          prepareHubAction(
            client,
            {
              reserve: async (_origin, _operation, expiry) => expiry,
              record: async (_origin, ref) => ref,
            },
            input,
            1_770_000_000_000,
          ),
        transfer: async () => {
          throw new Error('unused');
        },
        status: async () => ({ outcome: null, summary: null }),
      },
    });
    const tool = new HubActionsPlugin()
      .getTools()
      .find((item) => item.name === 'request_hub_action');
    if (!tool) throw new Error('request tool missing');
    expect(await tool.handler({ operation }, ctx)).toMatchObject({
      status: 'prepared',
    });
    expect(sent?.expiresAt).toBe(1_770_000_900);
    expect(sent?.bindingId).toBe('chb_three');
  });

  it('takes service discovery identity from the verified channel context', async () => {
    const discover = vi.fn(async () => options);
    const ctx = makeRuntimeContext({
      config: { HUB_ACTIONS_ENABLED: 'true' },
      user: {
        did: options.ownerDid,
        matrixUserId: '@owner:test',
        ucanDelegation: { raw: 'delegation' },
      },
      session: {
        id: 'session-three',
        client: 'channel',
        runId: 'run-three',
        requestId: 'request-three',
        channel: {
          provider: 'whatsapp',
          bindingId: options.bindingId,
          bindingRevision: options.bindingRevision,
        },
      },
      hubActions: {
        capabilities: async () => {
          throw new Error('not called');
        },
        options: discover,
        request: async () => reference,
        transfer: async () => {
          throw new Error('unused');
        },
        status: async () => ({ outcome: null, summary: null }),
      },
    });
    const tool = new HubActionsPlugin()
      .getTools()
      .find((item) => item.name === 'hub_action_options');
    if (!tool) throw new Error('Options tool missing');
    expect(await tool.handler({}, ctx)).toEqual(options);
    expect(discover).toHaveBeenCalledWith({
      ownerDid: options.ownerDid,
      provider: 'whatsapp',
      bindingId: options.bindingId,
      bindingRevision: 4,
    });
    await tool.handler(
      {},
      makeRuntimeContext({
        ...ctx,
        session: { ...ctx.session, client: 'portal' },
      }),
    );
    expect(discover).toHaveBeenCalledTimes(1);
  });

  it.each<P2Operation>([
    {
      kind: 'gmail.connect.v1',
      purpose: 'Send emails I review',
      connectionId: null,
      accountLabel: null,
      scopes: [],
    },
    {
      kind: 'gmail.disconnect.v1',
      connectionId: 'gmail-one',
      accountLabel: 'alex@example.test',
    },
    {
      kind: 'gmail.message.send.v1',
      connectionId: 'gmail-one',
      accountLabel: 'alex@example.test',
      to: 'sam@example.test',
      subject: 'Garden plans',
      body: 'Let’s meet on Tuesday.\nBring your ideas.',
    },
    {
      kind: 'statement.sign.v1',
      statement: 'These are my words.',
      purpose: 'Keep a signed record',
      audienceId: 'self',
    },
    {
      kind: 'calendar.connect.v1',
      purpose: 'Add events I review',
      connectionId: null,
      accountLabel: null,
      scopes: [],
    },
    {
      kind: 'calendar.disconnect.v1',
      connectionId: 'connection-one',
      accountLabel: 'alex@example.test',
    },
    {
      kind: 'calendar.event.create.v1',
      connectionId: 'connection-one',
      accountLabel: 'alex@example.test',
      calendarId: 'primary',
      title: 'Planning',
      description: '',
      startsAt: '2099-11-03T02:00:00Z',
      endsAt: '2099-11-03T02:30:00Z',
      timeZone: 'Asia/Singapore',
    },
    {
      kind: 'vfs.access.request.v1',
      targetId: 'target-one',
      title: 'Project notes',
      ability: 'read',
      purpose: 'Review the notes',
    },
    {
      kind: 'vfs.text.save.v1',
      filename: 'notes.txt',
      text: 'Keep these exact words.',
    },
  ])('uses the shared tool schema for $kind', (candidate) => {
    const tool = new HubActionsPlugin()
      .getTools()
      .find((item) => item.name === 'request_hub_action');
    if (!tool) throw new Error('Request tool missing');
    expect(tool.schema.safeParse({ operation: candidate }).success).toBe(true);
    expect(
      tool.schema.safeParse({
        operation: { ...candidate, executorUrl: 'https://evil.test' },
      }).success,
    ).toBe(false);
  });

  it('registers only with the flag, the Hub URL and the oracle key', () => {
    const plugin = new HubActionsPlugin();
    expect(plugin.autoDetect({ HUB_ACTIONS_ENABLED: 'true' })).toBe(false);
    expect(
      plugin.autoDetect({
        HUB_ACTIONS_ENABLED: 'true',
        AUTH_HUB_URL: 'https://hub.test',
      }),
    ).toBe(false);
    expect(
      plugin.autoDetect({
        HUB_ACTIONS_ENABLED: 'true',
        AUTH_HUB_URL: 'https://hub.test',
        AUTH_HUB_CHANNEL_SERVICE_KEY: 'oracle-secret',
      }),
    ).toBe(true);
  });

  it.each([
    ['limit', 'unavailable'],
    ['expired', 'expired'],
  ] as const)(
    'answers a %s refusal with a typed result the model can relay',
    async (kind, status) => {
      const ctx = makeRuntimeContext({
        config: { HUB_ACTIONS_ENABLED: 'true' },
        session: {
          id: 'session-three',
          client: 'channel',
          requestId: 'request-three',
          runId: 'run-three',
          channel: {
            provider: 'whatsapp',
            bindingId: 'chb_three',
            bindingRevision: 4,
          },
        },
        toolCallId: 'tool-three',
        hubActions: {
          capabilities: async () => {
            throw new Error('unused');
          },
          options: async () => {
            throw new Error('unused');
          },
          request: async () => {
            throw new HubActionRefused(kind, `refused: ${kind}`);
          },
          transfer: async () => {
            throw new Error('unused');
          },
          status: async () => ({ outcome: null, summary: null }),
        },
      });
      const tool = new HubActionsPlugin()
        .getTools()
        .find((item) => item.name === 'request_hub_action');
      if (!tool) throw new Error('request tool missing');
      expect(await tool.handler({ operation }, ctx)).toEqual({
        status,
        reason: `refused: ${kind}`,
      });
    },
  );

  it('names the field the protocol refused and the earlier action that blocks a send', async () => {
    const ctx = makeRuntimeContext({
      config: { HUB_ACTIONS_ENABLED: 'true' },
      session: {
        id: 'session-three',
        client: 'channel',
        requestId: 'request-three',
        runId: 'run-three',
        channel: {
          provider: 'whatsapp',
          bindingId: 'chb_three',
          bindingRevision: 4,
        },
      },
      toolCallId: 'tool-three',
      hubActions: {
        capabilities: async () => {
          throw new Error('unused');
        },
        options: async () => options,
        request: async () => {
          throw new HubActionRefused(
            'refused',
            'An earlier email is unconfirmed',
            'D'.repeat(32),
          );
        },
        transfer: async () => {
          throw new Error('unused');
        },
        status: async () => ({ outcome: null, summary: null }),
      },
    });
    const tool = new HubActionsPlugin()
      .getTools()
      .find((item) => item.name === 'request_hub_action');
    if (!tool) throw new Error('request tool missing');
    const bad = await tool.handler(
      {
        operation: {
          kind: 'ixo.bank.send.v1',
          chainId: 'pandora-8',
          network: 'ixo testnet',
          fromAddress: 'x',
          toAddress: 'x',
          amountBaseUnits: '1',
          denom: 'uixo',
          feeBaseUnits: '0',
          memo: '',
        },
      },
      ctx,
    );
    expect(bad).toMatchObject({ status: 'unavailable' });
    expect(JSON.stringify(bad)).toMatch(/Invalid/);
    expect(
      await tool.handler(
        {
          operation: {
            kind: 'gmail.message.send.v1',
            connectionId: 'gmail-one',
            accountLabel: 'alex@example.test',
            to: 'sam@example.test',
            subject: 'Garden plans',
            body: 'See you Tuesday.',
          },
        },
        ctx,
      ),
    ).toEqual({
      status: 'unavailable',
      reason: 'An earlier email is unconfirmed',
      priorActionId: 'D'.repeat(32),
    });
  });

  it('sends no bank transfer through the generic tool, base units and fee included', async () => {
    const request = vi.fn(async () => reference);
    const ctx = makeRuntimeContext({
      config: { HUB_ACTIONS_ENABLED: 'true' },
      session: {
        id: 'session-three',
        client: 'channel',
        requestId: 'request-three',
        runId: 'run-three',
        channel: {
          provider: 'whatsapp',
          bindingId: 'chb_three',
          bindingRevision: 4,
        },
      },
      toolCallId: 'tool-generic-bank',
      hubActions: {
        capabilities: async () => {
          throw new Error('unused');
        },
        options: async () => options,
        request,
        transfer: async () => reference,
        status: async () => ({ outcome: null, summary: null }),
      },
    });
    const tool = new HubActionsPlugin()
      .getTools()
      .find((item) => item.name === 'request_hub_action');
    if (!tool) throw new Error('request tool missing');
    expect(
      await tool.handler(
        {
          operation: {
            kind: 'ixo.bank.send.v1',
            chainId: 'ixo-5',
            network: 'ixo mainnet',
            fromAddress: 'ixo1qyqszqgpqyqszqgpqyqszqgpqyqszqgpdxlvf0',
            toAddress: 'ixo1qgpqyqszqgpqyqszqgpqyqszqgpqyqszuzefze',
            amountBaseUnits: '1000000',
            denom: 'uixo',
            feeBaseUnits: '5000',
            memo: '',
          },
        },
        ctx,
      ),
    ).toEqual({
      status: 'unavailable',
      reason:
        'Use request_hub_transfer with a token from hub_action_options for a transfer.',
    });
    expect(request).not.toHaveBeenCalled();
  });

  it('prepares a transfer from a listed denom and display amount with runtime identity only', async () => {
    const transfer = vi.fn(async () => reference);
    const ctx = makeRuntimeContext({
      config: { HUB_ACTIONS_ENABLED: 'true' },
      user: {
        did: 'did:ixo:owner',
        matrixUserId: '@owner:test',
        ucanDelegation: { raw: 'delegation' },
      },
      session: {
        id: 'session-three',
        client: 'channel',
        requestId: 'request-three',
        runId: 'run-three',
        channel: {
          provider: 'whatsapp',
          bindingId: 'chb_three',
          bindingRevision: 4,
        },
      },
      toolCallId: 'tool-transfer',
      hubActions: {
        capabilities: async () => {
          throw new Error('unused');
        },
        options: async () => options,
        request: async () => {
          throw new Error('unused');
        },
        transfer,
        status: async () => ({ outcome: null, summary: null }),
      },
    });
    const tool = new HubActionsPlugin()
      .getTools()
      .find((item) => item.name === 'request_hub_transfer');
    if (!tool) throw new Error('transfer tool missing');
    const input = {
      toAddress: 'ixo1qgpqyqszqgpqyqszqgpqyqszqgpqyqszuzefze',
      denom: `ibc/${'A'.repeat(64)}`,
      amount: '1.25',
    };
    // The model never names base units, a fee, a network or an owner.
    for (const extra of [
      { amountBaseUnits: '1250000' },
      { feeBaseUnits: '5000' },
      { network: 'ixo mainnet' },
      { ownerDid: 'did:ixo:other' },
    ])
      expect(tool.schema.safeParse({ ...input, ...extra }).success).toBe(false);
    expect(tool.schema.safeParse({ ...input, amount: '1e6' }).success).toBe(
      false,
    );
    expect(await tool.handler(input, ctx)).toEqual({
      status: 'prepared',
      actionReference: reference,
      summary: 'Review form',
    });
    expect(transfer).toHaveBeenCalledWith({
      ownerDid: 'did:ixo:owner',
      sessionId: 'session-three',
      runId: 'run-three',
      requestId: 'request-three',
      provider: 'whatsapp',
      bindingId: 'chb_three',
      bindingRevision: 4,
      requestKey: Array.from(
        new Uint8Array(
          await crypto.subtle.digest(
            'SHA-256',
            new TextEncoder().encode('run-three:tool-transfer'),
          ),
        ),
        (b) => b.toString(16).padStart(2, '0'),
      ).join(''),
      ...input,
      memo: '',
    });
    // Refusals (the runtime's or the Hub's) and protocol field errors
    // reach the model in words; anything else stays an error.
    transfer.mockRejectedValueOnce(
      new HubActionRefused(
        'refused',
        'The account does not hold enough to cover this transfer and its network fee.',
      ),
    );
    expect(await tool.handler(input, ctx)).toEqual({
      status: 'unavailable',
      reason:
        'The account does not hold enough to cover this transfer and its network fee.',
    });
    transfer.mockRejectedValueOnce(
      new HubActionRefused(
        'refused',
        'The transfer is incomplete (Invalid toAddress).',
      ),
    );
    expect(await tool.handler(input, ctx)).toEqual({
      status: 'unavailable',
      reason: 'The transfer is incomplete (Invalid toAddress).',
    });
    // A TypeError from anywhere else (a malformed Hub answer) is not the
    // model's to fix: it stays an error.
    transfer.mockRejectedValueOnce(new TypeError('Invalid reference.url'));
    await expect(tool.handler(input, ctx)).rejects.toThrow(
      'Invalid reference.url',
    );
    transfer.mockRejectedValueOnce(
      new Error('Hub action request returned 503'),
    );
    await expect(tool.handler(input, ctx)).rejects.toThrow('503');
    const portal = makeRuntimeContext({
      ...ctx,
      session: { ...ctx.session, client: 'portal', channel: undefined },
    });
    expect(await tool.handler(input, portal)).toMatchObject({
      status: 'unavailable',
    });
    expect(transfer).toHaveBeenCalledTimes(5);
  });

  it('tells the model on a chat surface that the review card is already delivered', async () => {
    const chat = makeRuntimeContext({
      config: { HUB_ACTIONS_ENABLED: 'true' },
      session: {
        id: 'session-three',
        client: 'channel',
        requestId: 'request-three',
        runId: 'run-three',
        channel: {
          provider: 'whatsapp',
          bindingId: 'chb_three',
          bindingRevision: 4,
        },
        surface: { kind: 'chat', surface: 'whatsapp', label: 'WhatsApp' },
      },
      toolCallId: 'tool-note',
      hubActions: {
        capabilities: async () => ({
          version: 'ixo.auth-capabilities/1',
          accountId: 'account-three',
          oracleDid: 'did:ixo:oracle',
          network: null,
          resourceOrigin: null,
          operations: ['form.submit.v1'],
          transfer: null,
          forms: [],
        }),
        options: async () => options,
        request: async () => reference,
        transfer: async () => reference,
        status: async () => ({ outcome: null, summary: null }),
      },
    });
    const tools = new HubActionsPlugin().getTools();
    const action = tools.find((item) => item.name === 'request_hub_action');
    const transfer = tools.find((item) => item.name === 'request_hub_transfer');
    if (!action || !transfer) throw new Error('request tools missing');
    const input = {
      toAddress: 'ixo1qgpqyqszqgpqyqszqgpqyqszqgpqyqszuzefze',
      denom: 'uixo',
      amount: '1',
    };
    const prepared = {
      status: 'prepared',
      actionReference: reference,
      // The Reply Plan builds its card from a summary equal to the title.
      summary: reference.title,
      note: HUB_ACTION_CARD_NOTE,
    };
    expect(await action.handler({ operation }, chat)).toEqual(prepared);
    expect(await transfer.handler(input, chat)).toEqual(prepared);
    expect(HUB_ACTION_CARD_NOTE).toBe(
      'The user is shown this action automatically as a card with its title and a Review action button that opens it in Auth Hub. Do not repeat the link or the title, and do not say that you have not executed or signed anything. Reply with one short line, or nothing.',
    );
    // A turn without a Reply Plan gets no card, so it gets no note either.
    const stream = makeRuntimeContext({
      ...chat,
      session: { ...chat.session, surface: { kind: 'stream' } },
    });
    expect(await transfer.handler(input, stream)).toEqual({
      status: 'prepared',
      actionReference: reference,
      summary: reference.title,
    });
  });

  it('returns the transfer summary line with the status', async () => {
    const ctx = makeRuntimeContext({
      config: { HUB_ACTIONS_ENABLED: 'true' },
      hubActions: {
        capabilities: async () => {
          throw new Error('unused');
        },
        options: async () => options,
        request: async () => reference,
        transfer: async () => reference,
        status: async () => ({
          outcome: null,
          summary: 'Transfer of 1.25 USDC confirmed on chain.',
        }),
      },
    });
    const tool = new HubActionsPlugin()
      .getTools()
      .find((item) => item.name === 'hub_action_status');
    if (!tool) throw new Error('status tool missing');
    expect(await tool.handler({ actionId: id }, ctx)).toEqual({
      status: 'known',
      outcome: null,
      summary: 'Transfer of 1.25 USDC confirmed on chain.',
    });
  });
});

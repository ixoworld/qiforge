import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { ToolInputParsingException } from '@langchain/core/tools';
import { CHAIN_TX_MESSAGE_TYPES, operationKinds } from '@ixo/action-protocol';
import { makeRuntimeContext } from '../../core/test-fixtures';
import { createNoopAmbient } from '../../core/runtime-context';
import { wrapPluginTool } from '../../core/wrap-plugin-tool';
import {
  CHAIN_TRANSACTION_TOOL_DESCRIPTION,
  CHAIN_TX_CATALOG,
  CHAIN_TX_GENERAL_RULES,
  HUB_ACTION_CARD_NOTE,
  HubActionsPlugin,
  chainTransactionDescription,
  chainTransactionSchemaFor,
  requestOperationJsonSchema,
} from './hub-actions.plugin';
import { HubActionClient } from '../../hub-actions/client';
import { prepareHubAction } from '../../hub-actions/request';
import type {
  ActionCapabilitiesV1,
  ChainTxCapabilities,
  HubActionOptionsV3,
  P2Operation,
} from '@ixo/action-protocol';
import { HubActionRefused } from '../../hub-actions/store';
import type { RuntimeContext } from '../../plugin-api/types';

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
        chainTransaction: async () => {
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
        chainTransaction: async () => {
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
        chainTransaction: async () => {
          throw new Error('unused');
        },
        status: async () => ({ outcome: null, summary: null }),
      },
    });
    const tool = new HubActionsPlugin()
      .getTools()
      .find((item) => item.name === 'hub_action_options');
    if (!tool) throw new Error('Options tool missing');
    // `did:ixo:owner` names no IXO account.
    expect(await tool.handler({}, ctx)).toEqual({
      ...options,
      ownerAddress: null,
    });
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

  it("adds the owner's IXO account address, read off their DID, to the Hub's options", async () => {
    const address = 'ixo1qypqxpq9qcrsszg2pvxq6rs0zqg3yyc5lzv7xu';
    const owned: HubActionOptionsV3 = {
      ...options,
      ownerDid: `did:ixo:${address}`,
    };
    const ctx = makeRuntimeContext({
      config: { HUB_ACTIONS_ENABLED: 'true' },
      user: {
        did: owned.ownerDid,
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
          bindingId: owned.bindingId,
          bindingRevision: owned.bindingRevision,
        },
      },
      hubActions: {
        capabilities: async () => {
          throw new Error('not called');
        },
        options: async () => owned,
        request: async () => reference,
        chainTransaction: async () => {
          throw new Error('not called');
        },
        status: async () => ({ outcome: null, summary: null }),
      },
    });
    const tool = new HubActionsPlugin()
      .getTools()
      .find((item) => item.name === 'hub_action_options');
    if (!tool) throw new Error('Options tool missing');
    expect(await tool.handler({}, ctx)).toEqual({
      ...owned,
      ownerAddress: address,
    });
    expect(tool.description).toContain(
      "ownerDid is the authenticated user's DID and ownerAddress their IXO account address.",
    );
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
          chainTransaction: async () => {
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
        chainTransaction: async () => {
          throw new Error('unused');
        },
        status: async () => ({ outcome: null, summary: null }),
      },
    });
    const tool = new HubActionsPlugin()
      .getTools()
      .find((item) => item.name === 'request_hub_action');
    if (!tool) throw new Error('request tool missing');
    // The schema passes it; the protocol refuses the field.
    const bad = await tool.handler(
      {
        operation: {
          kind: 'gmail.message.send.v1',
          connectionId: 'gmail-one',
          accountLabel: `${'a'.repeat(65)}@example.test`,
          to: 'sam@example.test',
          subject: 'Garden plans',
          body: 'See you Tuesday.',
        },
      },
      ctx,
    );
    expect(bad).toEqual({
      status: 'unavailable',
      reason:
        'The requested operation is unsupported or incomplete (Invalid accountLabel).',
    });
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
        chainTransaction: async () => {
          throw new Error('unused');
        },
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
        'Use request_chain_transaction with one cosmos.bank.send message (a token from hub_action_options and the amount in its display units) for a coin send.',
    });
    expect(request).not.toHaveBeenCalled();
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
        chainTransaction: async () => reference,
        status: async () => ({ outcome: null, summary: null }),
      },
    });
    const tools = new HubActionsPlugin().getTools();
    const action = tools.find((item) => item.name === 'request_hub_action');
    const chain = tools.find(
      (item) => item.name === 'request_chain_transaction',
    );
    if (!action || !chain) throw new Error('request tools missing');
    const input = {
      messages: [
        {
          type: 'cosmos.bank.send',
          toAddress: 'ixo1qgpqyqszqgpqyqszqgpqyqszqgpqyqszuzefze',
          amount: '1',
        },
      ],
    };
    const prepared = {
      status: 'prepared',
      actionReference: reference,
      // The Reply Plan builds its card from a summary equal to the title.
      summary: reference.title,
      note: HUB_ACTION_CARD_NOTE,
    };
    expect(await action.handler({ operation }, chat)).toEqual(prepared);
    expect(await chain.handler(input, chat)).toEqual(prepared);
    expect(HUB_ACTION_CARD_NOTE).toBe(
      'The user is shown this action automatically as a card with its title and a Review action button that opens it in Auth Hub. Do not repeat the link or the title, and do not say that you have not executed or signed anything. Reply with one short line, or nothing.',
    );
    // A turn without a Reply Plan gets no card, so it gets no note either.
    const stream = makeRuntimeContext({
      ...chat,
      session: { ...chat.session, surface: { kind: 'stream' } },
    });
    expect(await chain.handler(input, stream)).toEqual({
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
        chainTransaction: async () => {
          throw new Error('unused');
        },
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

describe('request_chain_transaction', () => {
  const RECIPIENT = 'ixo1qgpqyqszqgpqyqszqgpqyqszqgpqyqszuzefze';
  const ADMIN = 'ixo1qyqszqgpqyqszqgpqyqszqgpqyqszqgpdxlvf0';
  const bank = {
    type: 'cosmos.bank.send' as const,
    toAddress: RECIPIENT,
    // A display amount: the owner object converts it to base units.
    amount: '1.5',
  };
  // The model names no owner identity: no `agentDid`, no `agentAddress`.
  const submit = {
    type: 'ixo.claims.submit' as const,
    collectionId: '42',
    claimId: 'bafyclaimone',
    adminAddress: ADMIN,
  };
  const evaluate = {
    type: 'ixo.claims.evaluate' as const,
    claimId: 'bafyclaimtwo',
    collectionId: '42',
    oracle: 'did:ixo:entity:evaluator',
    adminAddress: ADMIN,
    status: 1 as const,
  };
  const token = {
    type: 'ixo.token.transfer' as const,
    recipient: RECIPIENT,
    tokens: [{ id: 'CARBON:bafytoken', amount: '3' }],
  };
  // A 32-byte (contract) address: `ixo1` and 59 characters.
  const CONTRACT = `ixo1${'q'.repeat(59)}`;

  function chainTool() {
    const tool = new HubActionsPlugin()
      .getTools()
      .find((item) => item.name === 'request_chain_transaction');
    if (!tool) throw new Error('chain transaction tool missing');
    return tool;
  }

  function channelContext(
    chainTransaction: NonNullable<
      RuntimeContext['hubActions']
    >['chainTransaction'],
  ) {
    return makeRuntimeContext({
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
      toolCallId: 'tool-chain',
      hubActions: {
        capabilities: async () => {
          throw new Error('unused');
        },
        options: async () => options,
        request: async () => {
          throw new Error('unused');
        },
        chainTransaction,
        status: async () => ({ outcome: null, summary: null }),
      },
    });
  }

  it('accepts each of the four message types alone and a batch of eight, and hands them to the host as written', async () => {
    const tool = chainTool();
    const chainTransaction = vi.fn(async () => reference);
    const ctx = channelContext(chainTransaction);
    for (const message of [
      bank,
      { ...bank, denom: `ibc/${'A'.repeat(64)}` },
      { ...bank, amount: '1000000000000000000000.000000000000000001' },
      { ...bank, amount: '7' },
      submit,
      { ...submit, useIntent: true },
      evaluate,
      {
        ...evaluate,
        status: 4,
        reason: 7,
        verificationProof: 'bafyproof',
      },
      { ...evaluate, oracle: 'did:web:example.com%3A8443:oracle' },
      token,
      {
        ...token,
        tokens: [{ id: 'a1b2c3d4e5f60718293a4b5c6d7e8f90', amount: '1' }],
      },
      { ...submit, claimId: 'collection/42:claim_one-2.json' },
    ]) {
      expect(tool.schema.safeParse({ messages: [message] }).success).toBe(true);
      expect(await tool.handler({ messages: [message] }, ctx)).toMatchObject({
        status: 'prepared',
      });
      expect(chainTransaction).toHaveBeenLastCalledWith(
        expect.objectContaining({ messages: [message] }),
      );
    }
    const eight = [
      bank,
      submit,
      evaluate,
      token,
      bank,
      submit,
      evaluate,
      token,
    ];
    expect(
      await tool.handler({ messages: eight, memo: 'é'.repeat(128) }, ctx),
    ).toMatchObject({ status: 'prepared' });
    expect(chainTransaction).toHaveBeenLastCalledWith(
      expect.objectContaining({ messages: eight, memo: 'é'.repeat(128) }),
    );
  });

  it.each<[string, unknown]>([
    ['no messages', { messages: [] }],
    ['nine messages', { messages: Array.from({ length: 9 }, () => bank) }],
    [
      'an unknown type',
      { messages: [{ ...bank, type: 'cosmos.staking.delegate' }] },
    ],
    [
      'a recipient on another chain',
      {
        messages: [
          {
            ...bank,
            toAddress: 'cosmos1qgpqyqszqgpqyqszqgpqyqszqgpqyqszuzefze',
          },
        ],
      },
    ],
    [
      'an upper-case address',
      { messages: [{ ...bank, toAddress: RECIPIENT.toUpperCase() }] },
    ],
    // A bank step names a display amount, never base units.
    [
      'base units instead of an amount',
      {
        messages: [
          {
            type: 'cosmos.bank.send',
            toAddress: RECIPIENT,
            amountBaseUnits: '1',
          },
        ],
      },
    ],
    [
      'base units next to an amount',
      { messages: [{ ...bank, amountBaseUnits: '1500000' }] },
    ],
    [
      'no amount',
      { messages: [{ type: 'cosmos.bank.send', toAddress: RECIPIENT }] },
    ],
    [
      'an amount in scientific notation',
      { messages: [{ ...bank, amount: '1e6' }] },
    ],
    ['a negative amount', { messages: [{ ...bank, amount: '-1' }] }],
    ['an amount with a comma', { messages: [{ ...bank, amount: '1,5' }] }],
    [
      'an amount with a leading zero',
      { messages: [{ ...bank, amount: '01.5' }] },
    ],
    ['a numeric amount', { messages: [{ ...bank, amount: 1.5 }] }],
    ['a bad denom', { messages: [{ ...bank, denom: '1x' }] }],
    [
      'a short admin address',
      { messages: [{ ...submit, adminAddress: 'ixo1qyqszqgp' }] },
    ],
    [
      'a collection id that is not digits',
      { messages: [{ ...submit, collectionId: 'abc' }] },
    ],
    ['an empty claim id', { messages: [{ ...submit, claimId: '' }] }],
    [
      'a claim id with a bidi override',
      { messages: [{ ...submit, claimId: 'claim\u202eone' }] },
    ],
    // Ids: letters, digits and : . _ / - only.
    ['a claim id with a space', { messages: [{ ...submit, claimId: 'a b' }] }],
    [
      'a claim id with a quote',
      { messages: [{ ...evaluate, claimId: 'claim"one' }] },
    ],
    [
      'a claim id with markup',
      { messages: [{ ...submit, claimId: '<b>claim</b>' }] },
    ],
    [
      'a token id with a zero-width space',
      {
        messages: [
          { ...token, tokens: [{ id: 'CARBON\u200bone', amount: '1' }] },
        ],
      },
    ],
    [
      'a verification proof with a space',
      { messages: [{ ...evaluate, verificationProof: 'bafy proof' }] },
    ],
    [
      'a verification proof over 300 characters',
      { messages: [{ ...evaluate, verificationProof: 'a'.repeat(301) }] },
    ],
    [
      'an empty verification proof',
      { messages: [{ ...evaluate, verificationProof: '' }] },
    ],
    // Addresses: 20 bytes (ixo1 + 38), never a contract.
    ['a contract recipient', { messages: [{ ...token, recipient: CONTRACT }] }],
    [
      'a contract bank recipient',
      { messages: [{ ...bank, toAddress: CONTRACT }] },
    ],
    [
      'an address one character long',
      { messages: [{ ...bank, toAddress: `${RECIPIENT}q` }] },
    ],
    [
      'an address one character short',
      { messages: [{ ...submit, adminAddress: ADMIN.slice(0, -1) }] },
    ],
    // DIDs: `%` only as a `%xx` escape.
    [
      'an oracle DID with a bare %',
      { messages: [{ ...evaluate, oracle: 'did:web:example.com%' }] },
    ],
    [
      'an oracle DID with a % and one hex digit',
      { messages: [{ ...evaluate, oracle: 'did:web:example.com%3' }] },
    ],
    [
      'an oracle DID with a % and non-hex digits',
      { messages: [{ ...evaluate, oracle: 'did:web:example.com%zz' }] },
    ],
    ['a pending evaluation', { messages: [{ ...evaluate, status: 0 }] }],
    [
      'an evaluation status above 4',
      { messages: [{ ...evaluate, status: 5 }] },
    ],
    ['a fractional reason', { messages: [{ ...evaluate, reason: 1.5 }] }],
    ['no token lines', { messages: [{ ...token, tokens: [] }] }],
    [
      '33 token lines',
      {
        messages: [
          {
            ...token,
            tokens: Array.from({ length: 33 }, () => token.tokens[0]),
          },
        ],
      },
    ],
    [
      'a zero token amount',
      {
        messages: [
          { ...token, tokens: [{ id: 'CARBON:bafytoken', amount: '0' }] },
        ],
      },
    ],
    ['a memo over 256 bytes', { messages: [bank], memo: 'é'.repeat(129) }],
    // The memo: no control, invisible or text-direction characters.
    ...[
      ['NUL', '\u0000'],
      ['a newline', '\n'],
      ['DEL', '\u007f'],
      ['a C1 control', '\u0085'],
      ['the Arabic letter mark', '\u061c'],
      ['a zero-width space', '\u200b'],
      ['a right-to-left mark', '\u200f'],
      ['a line separator', '\u2028'],
      ['a paragraph separator', '\u2029'],
      ['a bidi embedding', '\u202a'],
      ['a bidi override', '\u202e'],
      ['a bidi isolate', '\u2066'],
      ['a pop directional isolate', '\u2069'],
      ['a byte order mark', '\ufeff'],
    ].map(([name, char]): [string, unknown] => [
      `a memo with ${name}`,
      { messages: [bank], memo: `Lunch${char}` },
    ]),
    // The runtime fills these: the model never names them.
    ['a signer', { messages: [bank], signer: ADMIN }],
    ['a chain id', { messages: [bank], chainId: 'ixo-5' }],
    ['a network', { messages: [bank], network: 'ixo mainnet' }],
    [
      'a submit agentAddress',
      { messages: [{ ...submit, agentAddress: ADMIN }] },
    ],
    [
      'a submit agentDid',
      { messages: [{ ...submit, agentDid: 'did:ixo:ixo1owner' }] },
    ],
    [
      'an evaluation agentDid',
      { messages: [{ ...evaluate, agentDid: 'did:ixo:ixo1owner' }] },
    ],
    [
      'an evaluation agentAddress',
      { messages: [{ ...evaluate, agentAddress: ADMIN }] },
    ],
    ['a token owner', { messages: [{ ...token, owner: ADMIN }] }],
    ['a fee', { messages: [{ ...bank, feeBaseUnits: '5000' }] }],
  ])('refuses %s before any Hub call', async (_name, args) => {
    const chainTransaction = vi.fn(async () => reference);
    const ctx = channelContext(chainTransaction);
    const refusal = {
      status: 'unavailable',
      reason: expect.stringMatching(
        /^The messages do not match a supported message shape \(check .+\)\.$/,
      ),
    };
    // A direct handler call...
    expect(await chainTool().handler(args, ctx)).toMatchObject(refusal);
    // ...and the production path, through wrapPluginTool: LangChain refuses
    // what the model-facing schema covers (the batch, each type, the memo),
    // the handler refuses each message's fields against its type.
    const outcome: unknown = await wrapForModel(ctx)
      .invoke(args)
      .catch((caught: unknown) => caught);
    const refusedAs =
      outcome instanceof ToolInputParsingException
        ? outcome.message
        : JSON.stringify(outcome);
    expect(refusedAs).toMatch(
      /Received tool input did not match expected schema|^\{"status":"unavailable","reason":"The messages do not match a supported message shape \(check .+\)\."\}$/,
    );
    expect(chainTransaction).not.toHaveBeenCalled();
  });

  function wrapForModel(ctx: RuntimeContext) {
    return wrapPluginTool(chainTool(), {
      ambient: createNoopAmbient(),
      state: { messages: [] },
      fallbackContext: { user: ctx.user, session: ctx.session } as never,
    });
  }

  it('on a model turn, LangChain refuses the batch shape and the handler each message, naming messages[i].field', async () => {
    // Production path: the tool is bound through wrapPluginTool, and
    // LangChain parses the arguments against the model-facing schema
    // first (types, batch size, memo), so the model reads zod's issues.
    const chainTransaction = vi.fn(async () => reference);
    const ctx = channelContext(chainTransaction);
    const error: unknown = await wrapForModel(ctx)
      .invoke({
        messages: [bank, { ...bank, type: 'cosmos.staking.delegate' }],
        memo: 'Lunch\u202e',
      })
      .catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(ToolInputParsingException);
    const message = (error as Error).message;
    for (const words of [
      'Received tool input did not match expected schema',
      '→ at messages[1].type',
      '✖ No control, invisible or text-direction characters.\n  → at memo',
    ])
      expect(message).toContain(words);
    // Each message's own fields: checked strictly against its type by the
    // handler, which names every refused field.
    expect(
      await wrapForModel(ctx).invoke({
        messages: [
          { ...bank, amountBaseUnits: '1500000' },
          { ...bank, toAddress: CONTRACT },
          { ...submit, claimId: 'a b' },
          { ...evaluate, agentDid: 'did:ixo:ixo1owner' },
        ],
      }),
    ).toEqual({
      status: 'unavailable',
      reason:
        "The messages do not match a supported message shape (check messages[0].amountBaseUnits: not a field here (describe_chain_messages lists each type's fields); messages[1].toAddress: A 20-byte ixo1… account address (42 characters); contract addresses are refused; messages[2].claimId: Only letters, digits and : . _ / - (copied exactly); messages[3].agentDid: not a field here (describe_chain_messages lists each type's fields)).",
    });
    expect(chainTransaction).not.toHaveBeenCalled();
  });

  it('names the refused field as a path into the arguments (a direct handler call)', async () => {
    const result = await chainTool().handler(
      { messages: [bank, { ...bank, toAddress: 'ixo1nope' }] },
      channelContext(async () => reference),
    );
    expect(result).toEqual({
      status: 'unavailable',
      reason:
        'The messages do not match a supported message shape (check messages[1].toAddress: A 20-byte ixo1… account address (42 characters); contract addresses are refused).',
    });
    // The batch itself: the model-facing schema's paths, the same way.
    expect(
      await chainTool().handler(
        { messages: [], signer: ADMIN },
        channelContext(async () => reference),
      ),
    ).toEqual({
      status: 'unavailable',
      reason: expect.stringMatching(
        /^The messages do not match a supported message shape \(check messages: .+; signer: not a field here .+\)\.$/,
      ),
    });
  });

  it('prepares the messages with runtime identity only and relays a Hub refusal', async () => {
    const chainTransaction = vi.fn(async () => reference);
    const ctx = channelContext(chainTransaction);
    const tool = chainTool();
    const input = { messages: [submit, evaluate, token] };
    expect(await tool.handler(input, ctx)).toEqual({
      status: 'prepared',
      actionReference: reference,
      summary: reference.title,
    });
    expect(chainTransaction).toHaveBeenCalledWith({
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
            new TextEncoder().encode('run-three:tool-chain'),
          ),
        ),
        (b) => b.toString(16).padStart(2, '0'),
      ).join(''),
      messages: [submit, evaluate, token],
      memo: '',
    });
    chainTransaction.mockRejectedValueOnce(
      new HubActionRefused(
        'refused',
        'Auth Hub did not accept this transaction as written: invalid_message: messages[1].toAddress.',
      ),
    );
    expect(await tool.handler(input, ctx)).toEqual({
      status: 'unavailable',
      reason:
        'Auth Hub did not accept this transaction as written: invalid_message: messages[1].toAddress.',
    });
    // Anything that is not a typed refusal stays an error.
    chainTransaction.mockRejectedValueOnce(
      new Error('Hub action request returned 500'),
    );
    await expect(tool.handler(input, ctx)).rejects.toThrow('500');
    // Not a verified channel turn: nothing reaches the host.
    const portal = makeRuntimeContext({
      ...ctx,
      session: { ...ctx.session, client: 'portal', channel: undefined },
    });
    expect(await tool.handler(input, portal)).toEqual({
      status: 'unavailable',
      reason: 'A verified channel turn is required.',
    });
    expect(chainTransaction).toHaveBeenCalledTimes(3);
  });

  it('describes the tool in a few lines: discovery first, one summary line per type, batches', () => {
    const tool = chainTool();
    expect(tool.effect).toBe('write');
    expect(tool.description).toBe(CHAIN_TRANSACTION_TOOL_DESCRIPTION);
    expect(CHAIN_TRANSACTION_TOOL_DESCRIPTION).toBe(
      [
        'Prepare one chain transaction for the owner (the person you are talking to) to review and sign in Auth Hub; it never signs or executes. A single coin send is one `cosmos.bank.send` message. Before the first use in a conversation, call describe_chain_messages for the types you need and give exactly the fields it lists. Message types:',
        ...CHAIN_TX_MESSAGE_TYPES.map(
          (type) => `- \`${type}\`: ${CHAIN_TX_CATALOG[type].summary}`,
        ),
        'Up to 8 messages run in order as one transaction: all succeed or none do. Never invent ids or addresses (ask the owner or use other tools); coin amounts are display units ("1.5"), never base units. When the result is unavailable, tell the owner its reason in plain words; when it says retrying or changing the fields will not help, do not retry.',
      ].join('\n'),
    );
    // The model never names the owner's identity.
    expect(tool.description).not.toMatch(/`agentDid`|`agentAddress`/);
    // The JSON Schema the model is given: the type enum, the batch bound,
    // the memo, and no per-type field.
    const json = z.toJSONSchema(tool.schema);
    expect(json).toMatchObject({
      properties: {
        messages: {
          minItems: 1,
          maxItems: 8,
          items: {
            properties: { type: { enum: [...CHAIN_TX_MESSAGE_TYPES] } },
            required: ['type'],
          },
        },
        memo: { type: 'string' },
      },
      additionalProperties: false,
    });
    const text = JSON.stringify(json);
    for (const field of [
      '"toAddress"',
      '"claimId"',
      '"tokens"',
      '"signer"',
      '"chainId"',
      '"network"',
      '"agentDid"',
      '"agentAddress"',
    ])
      expect(text).not.toContain(field);
    expect(
      new HubActionsPlugin()
        .getTools()
        .some((item) => item.name === 'request_hub_transfer'),
    ).toBe(false);
  });

  it('costs one summary line and one enum value per type: a fifth type grows the per-call cost by about a line', () => {
    const size = (catalog: Record<string, { summary: string }>) => {
      const types = Object.keys(catalog) as [string, ...string[]];
      return (
        chainTransactionDescription(catalog).length +
        JSON.stringify(z.toJSONSchema(chainTransactionSchemaFor(types))).length
      );
    };
    const fifth = {
      ...CHAIN_TX_CATALOG,
      'ixo.entity.update': {
        summary: "update one of the owner's entities.",
      },
    };
    const line = "- `ixo.entity.update`: update one of the owner's entities.";
    expect(chainTransactionDescription(fifth)).toBe(
      `${chainTransactionDescription(CHAIN_TX_CATALOG).replace(
        '\nUp to 8 messages',
        `\n${line}\nUp to 8 messages`,
      )}`,
    );
    // The line, its newline, and the enum value with its quotes and comma.
    expect(size(fifth) - size(CHAIN_TX_CATALOG)).toBe(
      line.length + 1 + '"ixo.entity.update",'.length,
    );
  });

  it('leaves the runtime-built kinds out of the generic tool schema', () => {
    const kinds = requestOperationJsonSchema.oneOf.map(
      (branch) => (branch.properties as { kind: { const: string } }).kind.const,
    );
    expect([...kinds].sort()).toEqual(
      operationKinds
        .filter(
          (kind) => kind !== 'ixo.bank.send.v1' && kind !== 'ixo.chain.tx.v1',
        )
        .sort(),
    );
    const tool = new HubActionsPlugin()
      .getTools()
      .find((item) => item.name === 'request_hub_action');
    if (!tool) throw new Error('request tool missing');
    const text = JSON.stringify(z.toJSONSchema(tool.schema));
    expect(text).not.toContain('ixo.bank.send.v1');
    expect(text).not.toContain('ixo.chain.tx.v1');
    expect(text).toContain('gmail.message.send.v1');
    expect(tool.description).toContain(
      'Coin sends and other chain transactions have their own tool (request_chain_transaction).',
    );
  });

  it('refuses a chain transaction through the generic tool: the runtime fills chain, network and signer', async () => {
    const request = vi.fn(async () => reference);
    const ctx = channelContext(async () => reference);
    const generic = makeRuntimeContext({
      ...ctx,
      hubActions: { ...ctx.hubActions!, request },
    });
    const tool = new HubActionsPlugin()
      .getTools()
      .find((item) => item.name === 'request_hub_action');
    if (!tool) throw new Error('request tool missing');
    expect(
      await tool.handler(
        {
          operation: {
            kind: 'ixo.chain.tx.v1',
            chainId: 'ixo-5',
            network: 'ixo mainnet',
            signer: ADMIN,
            memo: '',
            messages: [bank],
          },
        },
        generic,
      ),
    ).toEqual({
      status: 'unavailable',
      reason:
        'Use request_chain_transaction with only the messages for a chain transaction.',
    });
    expect(request).not.toHaveBeenCalled();
  });

  it('surfaces the Hub chainTx capability read at protocol version 4', async () => {
    const urls: string[] = [];
    const capabilities = {
      version: 'ixo.auth-capabilities/2',
      accountId: 'account-three',
      oracleDid: 'did:ixo:oracle',
      network: 'ixo testnet',
      resourceOrigin: null,
      operations: ['ixo.bank.send.v1', 'ixo.chain.tx.v1'],
      forms: [],
      transfer: { limits: [], maxFeeUixo: '100000' },
      chainTx: {
        messageTypes: [
          'cosmos.bank.send',
          'ixo.claims.submit',
          'ixo.claims.evaluate',
          'ixo.token.transfer',
        ],
        maxMessages: 8,
      },
    };
    const client = new HubActionClient({
      origin: 'https://hub.test',
      key: 'oracle-secret',
      fetcher: {
        fetch: async (request) => {
          urls.push(request.url);
          return Response.json(capabilities);
        },
      },
    });
    const ctx = channelContext(async () => reference);
    const withClient = makeRuntimeContext({
      ...ctx,
      hubActions: {
        ...ctx.hubActions!,
        capabilities: () => client.capabilities(),
      },
    });
    const tool = new HubActionsPlugin()
      .getTools()
      .find((item) => item.name === 'hub_action_capabilities');
    if (!tool) throw new Error('capabilities tool missing');
    expect(await tool.handler({}, withClient)).toEqual(capabilities);
    expect(urls).toEqual([
      'https://hub.test/api/internal/actions/operations/capabilities?version=4',
    ]);
  });
});

describe('describe_chain_messages', () => {
  const chainTx: ChainTxCapabilities = {
    messageTypes: ['cosmos.bank.send', 'ixo.token.transfer'],
    maxMessages: 8,
  };
  function describeTool() {
    const tool = new HubActionsPlugin()
      .getTools()
      .find((item) => item.name === 'describe_chain_messages');
    if (!tool) throw new Error('describe tool missing');
    return tool;
  }
  function context(
    capabilities: NonNullable<RuntimeContext['hubActions']>['capabilities'],
    client: 'channel' | 'portal' = 'channel',
  ) {
    const unused = async () => {
      throw new Error('unused');
    };
    return makeRuntimeContext({
      config: { HUB_ACTIONS_ENABLED: 'true' },
      session: {
        id: 'session-three',
        client,
        requestId: 'request-three',
        runId: 'run-three',
        ...(client === 'channel'
          ? {
              channel: {
                provider: 'whatsapp',
                bindingId: 'chb_three',
                bindingRevision: 4,
              },
            }
          : {}),
      },
      hubActions: {
        capabilities,
        options: unused,
        request: unused,
        chainTransaction: unused,
        status: unused,
      },
    });
  }
  const accountCapabilities = (value: ChainTxCapabilities | null) =>
    vi.fn(
      async (): Promise<ActionCapabilitiesV1> => ({
        version: 'ixo.auth-capabilities/2',
        accountId: 'account-three',
        oracleDid: 'did:ixo:oracle',
        network: 'ixo testnet',
        resourceOrigin: null,
        operations: value ? ['ixo.chain.tx.v1'] : [],
        forms: [],
        transfer: null,
        chainTx: value,
      }),
    );

  it('returns one type with its full rules and fields, and the types the account may use', async () => {
    const tool = describeTool();
    expect(tool.effect).toBe('read');
    const capabilities = accountCapabilities(chainTx);
    const result = (await tool.handler(
      { types: ['cosmos.bank.send'] },
      context(capabilities),
    )) as {
      status: string;
      general: string;
      messages: {
        type: string;
        rules: string;
        fields: {
          properties: Record<string, { description?: string }>;
          required: string[];
        };
      }[];
      availableTypes: string[];
    };
    expect(result.status).toBe('known');
    expect(result.general).toBe(CHAIN_TX_GENERAL_RULES);
    for (const words of [
      '20-byte `ixo1…` account addresses (contract addresses are refused)',
      'only letters, digits and `: . _ / -`',
      'never invent them',
      'Auth Hub sets the fee',
      'all succeed or none do',
    ])
      expect(result.general).toContain(words);
    expect(result.messages).toHaveLength(1);
    const [bank] = result.messages;
    expect(bank?.type).toBe('cosmos.bank.send');
    expect(bank?.rules).toBe(CHAIN_TX_CATALOG['cosmos.bank.send'].rules);
    for (const words of [
      'a single coin send',
      'display units ("1.5" for 1.5 IXO)',
      'never base units',
      'converts the amount with the listed `decimals`',
      'refuses a token not in the list, more digits after the point than the token has, zero, and more than the listed balance',
      'defaults to uixo (IXO, 6 decimals)',
      'never guess an `ibc/…` hash',
      'say when the token is unverified',
    ])
      expect(bank?.rules).toContain(words);
    expect(Object.keys(bank?.fields.properties ?? {}).sort()).toEqual(
      ['amount', 'denom', 'toAddress', 'type'].sort(),
    );
    expect(bank?.fields.required.sort()).toEqual(
      ['amount', 'toAddress', 'type'].sort(),
    );
    expect(bank?.fields.properties.amount?.description).toContain(
      'display units',
    );
    expect(result.availableTypes).toEqual([
      'cosmos.bank.send',
      'ixo.token.transfer',
    ]);
    expect(capabilities).toHaveBeenCalledTimes(1);
  });

  it('returns several types in the order asked, with the rules moved out of the request tool', async () => {
    const result = (await describeTool().handler(
      {
        types: [
          'ixo.token.transfer',
          'ixo.claims.evaluate',
          'ixo.claims.submit',
        ],
      },
      context(accountCapabilities(chainTx)),
    )) as {
      messages: {
        type: string;
        rules: string;
        fields: { properties: Record<string, unknown> };
      }[];
    };
    expect(result.messages.map((message) => message.type)).toEqual([
      'ixo.token.transfer',
      'ixo.claims.evaluate',
      'ixo.claims.submit',
    ]);
    const rules = Object.fromEntries(
      result.messages.map((message) => [message.type, message.rules]),
    );
    for (const [type, words] of [
      ['ixo.token.transfer', '32 hex characters'],
      [
        'ixo.token.transfer',
        'All tokens in one message must come from one token contract',
      ],
      ['ixo.token.transfer', 'not the IXO coin'],
      [
        'ixo.claims.evaluate',
        '1 approve, 2 reject, 3 dispute (the chain may refuse it as deprecated), 4 invalidate',
      ],
      [
        'ixo.claims.evaluate',
        'the runtime adds their DID and address, never the claimant’s',
      ],
      ['ixo.claims.evaluate', 'An approval can pay the claimant'],
      [
        'ixo.claims.submit',
        'Collections with member budgets cannot be filed into here',
      ],
      [
        'ixo.claims.submit',
        'The collection admin must have authorized the owner',
      ],
    ] as const) {
      expect(rules[type]).toContain(words);
      // Moved, not duplicated: the request tool carries only the summaries.
      expect(CHAIN_TRANSACTION_TOOL_DESCRIPTION).not.toContain(words);
    }
    // The fields the runtime fills are never listed.
    const text = JSON.stringify(result.messages.map((m) => m.fields));
    expect(text).not.toContain('agentDid');
    expect(text).not.toContain('agentAddress');
    expect(text).toContain('"verificationProof"');
  });

  it.each<[string, unknown]>([
    ['an unknown type', { types: ['cosmos.staking.delegate'] }],
    ['no types', { types: [] }],
    ['a type twice', { types: ['cosmos.bank.send', 'cosmos.bank.send'] }],
    ['no arguments', {}],
    ['an extra argument', { types: ['cosmos.bank.send'], all: true }],
  ])('refuses %s', async (_name, args) => {
    const tool = describeTool();
    expect(tool.schema.safeParse(args).success).toBe(false);
    const capabilities = accountCapabilities(chainTx);
    expect(await tool.handler(args, context(capabilities))).toEqual({
      status: 'unavailable',
      reason:
        'Name 1 to 8 different message types, each one of: cosmos.bank.send, ixo.claims.submit, ixo.claims.evaluate, ixo.token.transfer.',
    });
    expect(capabilities).not.toHaveBeenCalled();
  });

  it('filters availableTypes by the account capabilities, and falls back to the catalogue when they cannot be read', async () => {
    const tool = describeTool();
    const args = { types: ['ixo.claims.submit'] };
    const available = async (ctx: RuntimeContext) =>
      ((await tool.handler(args, ctx)) as { availableTypes: string[] })
        .availableTypes;
    expect(
      await available(
        context(
          accountCapabilities({
            messageTypes: ['ixo.claims.evaluate'],
            maxMessages: 4,
          }),
        ),
      ),
    ).toEqual(['ixo.claims.evaluate']);
    // Chain transactions off for the account: none.
    expect(await available(context(accountCapabilities(null)))).toEqual([]);
    // The Hub not answering: the static catalogue.
    expect(
      await available(
        context(async () => {
          throw new Error('Hub action capabilities returned 503');
        }),
      ),
    ).toEqual([...CHAIN_TX_MESSAGE_TYPES]);
    // Not a channel turn: the catalogue, without a Hub read.
    const capabilities = accountCapabilities(chainTx);
    expect(await available(context(capabilities, 'portal'))).toEqual([
      ...CHAIN_TX_MESSAGE_TYPES,
    ]);
    expect(capabilities).not.toHaveBeenCalled();
  });
});

import { describe, expect, it, vi } from 'vitest';
import { makeRuntimeContext } from '../../core/test-fixtures';
import { HubActionsPlugin } from './hub-actions.plugin';
import { HubActionClient } from '../../hub-actions/client';
import { prepareHubAction } from '../../hub-actions/request';
import type { HubActionOptionsV1, P2Operation } from '@ixo/action-protocol';

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
const options: HubActionOptionsV1 = {
  version: 'ixo.auth-options/1',
  accountId: 'account-three',
  ownerDid: 'did:ixo:owner',
  bindingId: 'chb_three',
  bindingRevision: 4,
  connections: [],
  targets: [],
  resources: [],
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
        status: async () => null,
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
      requestKey: 'run-three:tool-three',
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
        status: async () => null,
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
        status: async () => null,
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
});

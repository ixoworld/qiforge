import {
  HumanMessage,
  type BaseMessage,
  type ToolMessage,
} from '@langchain/core/messages';
import { MemorySaver } from '@langchain/langgraph';
import { FakeToolCallingModel } from 'langchain';
import {
  createDelegation,
  createUCANValidator,
  defineCapability,
  generateKeypair,
  parseDelegation,
  serializeDelegation,
  signerFromMnemonic,
} from '@ixo/ucan';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createRuntimeCore } from '../src/core';
import { createMainAgent } from '../src/core/main-agent';
import { createNoopAmbient } from '../src/core/runtime-context';
import { makeEnv } from '../src/core/test-fixtures';
import { createUcanAdapter } from '../src/do/ambient';
import { WorkersUcanService } from '../src/do/ucan-service';
import { GmailConnectorPlugin } from '../src/plugins/gmail-connectors';
import {
  gmailProfileResource,
  gmailRequestHash,
} from '../src/plugins/gmail-connectors/contract';

const MNEMONIC =
  'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';
const PROXY = 'https://gmail-proxy.example';
const OWNER_URL = 'https://portal.example/settings/agents/gmail';
const ACCOUNT = 'ca_workerd';

afterEach(() => vi.unstubAllGlobals());

describe('Gmail connector in a workerd agent turn', () => {
  it('loads on demand, verifies real signed HTTP requests, and keeps proofs out of checkpoints and logs', async () => {
    const oracle = (await signerFromMnemonic(MNEMONIC)).signer;
    const owner = (await generateKeypair()).signer;
    const proxy = (await generateKeypair()).signer;
    const expiresAt = Math.floor(Date.now() / 1000) + 3600;
    const delegation = await serializeDelegation(
      await createDelegation({
        issuer: owner,
        audience: oracle.did(),
        expiration: expiresAt,
        capabilities: [
          { can: 'tool/execute', with: gmailProfileResource(ACCOUNT) },
        ],
      }),
    );
    const requests: string[] = [];
    const requestErrors: unknown[] = [];
    const profile = {
      emailAddress: 'owner@example.com',
      messagesTotal: 2,
      threadsTotal: 1,
    };
    vi.stubGlobal(
      'fetch',
      vi.fn<typeof fetch>(async (input, init) => {
        const req = new Request(input, init);
        if (req.url.endsWith('/.well-known/did.json'))
          return Response.json({ id: proxy.did() });
        requests.push(req.url);
        try {
          const status = req.url.endsWith('/status');
          expect(req.headers.get('x-auth-type')).toBe('ucan');
          expect(req.headers.get('x-ixo-network')).toBe('testnet');
          expect(await req.json()).toEqual(
            status
              ? { ownerDid: owner.did() }
              : { ownerDid: owner.did(), connectedAccountId: ACCOUNT },
          );
          const token = (req.headers.get('authorization') ?? '').replace(
            /^Bearer /,
            '',
          );
          const validator = await createUCANValidator({
            serverDid: proxy.did(),
            rootIssuers: [status ? oracle.did() : owner.did()],
            requireExpiration: true,
          });
          const resource = status
            ? `composio://agent/${oracle.did()}/toolkit/gmail`
            : gmailProfileResource(ACCOUNT);
          const valid = await validator.validate(
            token,
            defineCapability({
              can: status ? 'connector/status' : 'tool/execute',
              protocol: 'composio:',
            }),
            resource,
          );
          expect(valid.ok).toBe(true);
          const parsed = await parseDelegation(token);
          expect(parsed.proofs).toHaveLength(status ? 0 : 1);
          expect(parsed.expiration).toBeLessThanOrEqual(
            Math.floor(Date.now() / 1000) + 60,
          );
          expect(parsed.capabilities[0]?.nb).toEqual({
            requestHash: await gmailRequestHash({
              action: status ? 'status' : 'profile',
              ownerDid: owner.did(),
              oracleDid: oracle.did(),
              connectedAccountId: status ? null : ACCOUNT,
            }),
          });
          return Response.json(
            status
              ? {
                  status: 'ready',
                  connectedAccountId: ACCOUNT,
                  delegation,
                  expiresAt,
                }
              : { status: 'ready', profile, delegation: 'SECRET_RESPONSE' },
          );
        } catch (error) {
          requestErrors.push(error);
          return Response.json({ status: 'unavailable' }, { status: 503 });
        }
      }),
    );
    const core = createRuntimeCore({
      config: { name: 'Gmail test oracle' },
      plugins: [new GmailConnectorPlugin()],
      features: { 'gmail-connectors': true },
      env: makeEnv({
        ORACLE_DID: oracle.did(),
        NETWORK: 'testnet',
        GMAIL_CONNECTOR_URL: PROXY,
        GMAIL_CONNECTOR_OWNER_URL: OWNER_URL,
      }),
    });
    await core.warm();
    const service = new WorkersUcanService({
      oracleDid: oracle.did(),
      signingMnemonic: MNEMONIC,
    });
    const logs = { log: vi.fn(), warn: vi.fn(), error: vi.fn() };
    const script = [
      [{ name: 'read_gmail_profile', args: {}, id: 'before-load' }],
      [
        {
          name: 'load_capability',
          args: { names: ['gmail-connectors'] },
          id: 'load',
        },
      ],
      [{ name: 'gmail_connection_status', args: {}, id: 'status' }],
      [{ name: 'read_gmail_profile', args: {}, id: 'profile' }],
      [{ name: 'disconnect_gmail', args: {}, id: 'disconnect' }],
      [],
    ];
    const ambient = createNoopAmbient({
      config: core.validatedEnv,
      identity: core.identity,
      availablePlugins: core.availablePlugins,
      ucan: createUcanAdapter(service, () => undefined),
      llm: { get: () => new FakeToolCallingModel({ toolCalls: script }) },
      logger: logs,
    });
    const built = await createMainAgent({
      registries: core.registries,
      identity: core.identity,
      config: core.validatedEnv,
      availablePlugins: core.availablePlugins,
      ambient,
      requestCtx: {
        user: {
          did: owner.did(),
          matrixUserId: '@owner:test',
          ucanDelegation: { raw: 'chat-authorization' },
        },
        session: {
          id: 'gmail-test',
          client: 'channel',
          requestId: 'gmail-test',
        },
      },
      state: {},
      checkpointer: new MemorySaver(),
    });
    const config = { configurable: { thread_id: 'gmail-workerd' } };
    const result = await built.agent.invoke(
      { messages: [new HumanMessage('Read my connected Gmail profile.')] },
      config,
    );
    const messages: BaseMessage[] = result.messages;
    const tools = new Map(
      messages
        .filter((message): message is ToolMessage => message.type === 'tool')
        .map((message) => [message.tool_call_id, message]),
    );
    expect(requestErrors).toEqual([]);
    expect(String(tools.get('before-load')?.content)).toContain('not loaded');
    expect(JSON.parse(String(tools.get('status')?.content))).toEqual({
      status: 'ready',
      connectedAccountId: ACCOUNT,
      expiresAt,
      permission: 'gmail.profile.read',
    });
    expect(JSON.parse(String(tools.get('profile')?.content))).toEqual({
      status: 'ready',
      profile,
    });
    expect(JSON.parse(String(tools.get('disconnect')?.content))).toMatchObject({
      status: 'owner_action_required',
      action: 'disconnect',
    });
    expect(requests).toEqual([
      `${PROXY}/v1/agent-connectors/gmail/status`,
      `${PROXY}/v1/agent-connectors/gmail/status`,
      `${PROXY}/v1/agent-connectors/gmail/profile`,
    ]);
    expect(requestErrors).toEqual([]);
    for (const name of [
      'gmail_connection_status',
      'connect_gmail',
      'read_gmail_profile',
      'disconnect_gmail',
    ])
      expect(built.toolEffects.get(name)).toBe('read');
    const checkpoint = JSON.stringify(await built.agent.getState(config));
    expect(checkpoint).not.toContain(delegation);
    expect(checkpoint).not.toContain('SECRET_RESPONSE');
    expect(
      JSON.stringify([
        logs.log.mock.calls,
        logs.warn.mock.calls,
        logs.error.mock.calls,
      ]),
    ).not.toContain(delegation);
  });

  it('honors an explicit feature disable and fails enabled boot with missing connector config', async () => {
    const core = createRuntimeCore({
      config: { name: 'Gmail test oracle' },
      plugins: [new GmailConnectorPlugin()],
      features: { 'gmail-connectors': false },
      env: makeEnv(),
    });
    await core.warm();
    expect(core.availablePlugins.has('gmail-connectors')).toBe(false);
    expect(() =>
      createRuntimeCore({
        config: { name: 'Gmail test oracle' },
        plugins: [new GmailConnectorPlugin()],
        features: { 'gmail-connectors': true },
        env: makeEnv(),
      }),
    ).toThrow(/GMAIL_CONNECTOR_URL/);
  });
});

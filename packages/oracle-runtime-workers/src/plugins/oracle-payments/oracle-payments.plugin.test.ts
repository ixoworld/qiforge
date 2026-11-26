import { FakeListChatModel } from '@langchain/core/utils/testing';
import { describe, expect, it } from 'vitest';
import { createRuntimeCore } from '../../core';
import { createMainAgent } from '../../core/main-agent';
import { WeatherPlugin } from '../../core/plugins/weather';
import { createNoopAmbient } from '../../core/runtime-context';
import { makeEnv } from '../../core/test-fixtures';
import { createMemoryUserKv } from '../../core/user-kv';
import type { UserKvSurface } from '../../plugin-api/types';
import { EngagementStore, type Engagement } from './engagements';
import { OraclePaymentsPlugin } from './oracle-payments.plugin';
import { ADMIN, BUYER, CARD, COLLECTION } from './test-fixtures';

const OPEN_JOB: Engagement = {
  status: 'active',
  serviceId: 'mrv-plan',
  serviceName: 'MRV plan design',
  priceUsd: 2000,
  collectionId: COLLECTION,
  adminAddress: ADMIN,
  userDid: `did:ixo:${BUYER}`,
  startedAt: '2026-10-19T10:00:00Z',
  amount: { denom: 'upay', amount: '2000000000' },
  homeServer: null,
  intentTxHash: 'TX1',
  request: 'Design my MRV plan',
};

/** Build one turn of an oracle selling `CARD`, next to an ordinary plugin. */
async function buildTurn(
  kv: UserKvSurface,
  env = makeEnv({ AGENT_CARD_JSON: JSON.stringify(CARD) }),
) {
  const core = createRuntimeCore({
    config: { name: 'Verde', org: 'Verde', description: 'MRV studio' },
    plugins: [new WeatherPlugin(), new OraclePaymentsPlugin()],
    env,
  });
  return createMainAgent({
    registries: core.registries,
    identity: core.identity,
    config: core.validatedEnv,
    availablePlugins: core.availablePlugins,
    ambient: createNoopAmbient({
      config: core.validatedEnv,
      identity: core.identity,
      availablePlugins: core.availablePlugins,
      llm: { get: () => new FakeListChatModel({ responses: ['ok'] }) },
      kv,
    }),
    requestCtx: {
      user: {
        did: `did:ixo:${BUYER}`,
        matrixUserId: '@buyer:devmx.ixo.earth',
        ucanDelegation: { raw: 'ucan' },
      },
      session: { id: 's1', client: 'matrix', requestId: 'r1', roomId: '!room' },
    },
    state: {},
  });
}

describe('OraclePaymentsPlugin turn scope', () => {
  it('support mode binds only the front desk: no other plugin, no meta-tools, no paid-work tools', async () => {
    const { boundToolNames, systemPrompt, context } =
      await buildTurn(createMemoryUserKv());
    expect(boundToolNames).toEqual(
      expect.arrayContaining([
        'list_services',
        'show_contract',
        'get_contract_status',
        'start_work',
      ]),
    );
    expect(boundToolNames).not.toContain('get_current_weather');
    expect(boundToolNames).not.toContain('load_capability');
    expect(boundToolNames).not.toContain('deliver_work');
    expect(systemPrompt).toContain('You do NOT do the work in support mode');
    expect(context.commerce).toEqual({ mode: 'support' });
  });

  it('an open job switches the turn to work mode with the full tool surface', async () => {
    const kv = createMemoryUserKv();
    await new EngagementStore(kv).save(OPEN_JOB);
    const { boundToolNames, systemPrompt, context } = await buildTurn(kv);
    expect(boundToolNames).toEqual(
      expect.arrayContaining([
        'deliver_work',
        'cancel_work',
        'get_current_weather',
      ]),
    );
    expect(boundToolNames).not.toContain('start_work');
    expect(systemPrompt).toContain('You are performing "MRV plan design"');
    expect(context.commerce).toMatchObject({
      mode: 'work',
      engagement: { serviceId: 'mrv-plan' },
    });
  });

  it('without an agent card the plugin stays off and the oracle is unrestricted', async () => {
    const { boundToolNames, context } = await buildTurn(
      createMemoryUserKv(),
      makeEnv(),
    );
    expect(boundToolNames).toContain('get_current_weather');
    expect(boundToolNames).not.toContain('start_work');
    expect(context.commerce).toBeUndefined();
  });
});

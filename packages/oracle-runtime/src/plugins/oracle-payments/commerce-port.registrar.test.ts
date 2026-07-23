import { afterEach, describe, expect, it, vi } from 'vitest';
import { getCommerceRouterPort } from '../../modules/messages/commerce-router-port.js';
import { makeConfig } from '../../testing/nest-doubles.js';
import {
  makeCardService,
  makeContractRecord,
  makeContractRecordService,
  makeEngagementService,
  ORACLE_ENTITY_DID,
  USER_DID,
} from './__test-fixtures__/oracle-payments-fixtures.js';
import { CommerceRouterPortRegistrar } from './commerce-port.registrar.js';
import { ContractGateService } from './contract-gate.service.js';
import { WorkIntentService } from './work-intent.service.js';

function makeRegistrar(config: Record<string, unknown>) {
  const engagement = makeEngagementService();
  const gate = new ContractGateService({
    contractRecord: makeContractRecordService(makeContractRecord()).service,
    engagement,
    engineUrl: 'https://engine.example',
    network: 'devnet',
  });
  const sendIntent = vi.fn(async () => ({
    code: 0,
    transactionHash: 'INTENT-TX',
  }));
  const registrar = new CommerceRouterPortRegistrar(
    makeConfig(config),
    makeCardService(),
    engagement,
    gate,
    new WorkIntentService({
      engagement,
      network: 'devnet',
      chain: { sendIntent },
      clock: () => new Date('2026-07-22T12:00:00.000Z'),
    }),
  );
  return { registrar, sendIntent };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('CommerceRouterPortRegistrar', () => {
  it('registers a working port on init and clears it on destroy', async () => {
    const { registrar, sendIntent } = makeRegistrar({
      ORACLE_ENTITY_DID,
      ORACLE_PAYMENTS_ROUTER_MODEL: 'openai/custom-router',
    });
    expect(getCommerceRouterPort()).toBeNull();

    registrar.onModuleInit();
    const port = getCommerceRouterPort();
    expect(port).not.toBeNull();
    expect(port?.routerModel).toBe('openai/custom-router');

    // Services are reduced from the card views to the routed shape.
    const services = await port!.getServices();
    expect(services).toContainEqual({
      id: 'tax-report',
      name: 'Tax report',
      description: 'A full tax report for the year',
      tags: ['tax', 'finance'],
      examples: ['File my 2025 taxes'],
      priceUsd: 20,
    });

    // Engagement start reserves payment, then round-trips through the plugin's
    // store. (The port exposes no way to END an engagement — that is the
    // agent's cancel_work/deliver_work decision, not the router's.)
    const started = await port!.startEngagement('!room:home', 'thread-1', {
      serviceId: 'tax-report',
      serviceName: 'Tax report',
      priceUsd: 20,
      collectionId: '42',
      adminAddress: 'ixo1admin',
    });
    expect(sendIntent).toHaveBeenCalledWith({
      collectionId: '42',
      amount: [{ denom: 'uixo', amount: '20000000' }],
    });
    expect(started.ok).toBe(true);
    expect(started.ok && started.engagement.status).toBe('active');
    expect(
      await port!.getActiveEngagement('!room:home', 'thread-1'),
    ).toMatchObject({ serviceId: 'tax-report' });

    // The gate consults the contract record service. Checked from the working
    // thread itself, the live engagement is not a conflict with itself.
    const gateResult = await port!.checkContractGate({
      roomId: '!room:home',
      threadId: 'thread-1',
      senderDid: USER_DID,
      service: { id: 'tax-report', name: 'Tax report', priceUsd: 20 },
    });
    expect(gateResult.ok).toBe(true);

    // From a second thread the same live engagement blocks a new job — the
    // chain would refuse its reservation anyway.
    const secondThread = await port!.checkContractGate({
      roomId: '!room:home',
      threadId: 'thread-2',
      senderDid: USER_DID,
      service: { id: 'tax-report', name: 'Tax report', priceUsd: 20 },
    });
    expect(secondThread).toEqual({
      ok: false,
      reason: 'engagement_in_progress',
      inProgress: {
        serviceId: 'tax-report',
        serviceName: 'Tax report',
        threadId: 'thread-1',
      },
    });

    registrar.onModuleDestroy();
    expect(getCommerceRouterPort()).toBeNull();
  });

  it('refuses to register without the base-required ORACLE_ENTITY_DID', () => {
    const { registrar } = makeRegistrar({});

    expect(() => registrar.onModuleInit()).toThrow(/ORACLE_ENTITY_DID/);
    expect(getCommerceRouterPort()).toBeNull();
  });
});

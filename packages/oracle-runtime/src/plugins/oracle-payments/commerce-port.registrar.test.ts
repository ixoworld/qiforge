import { afterEach, describe, expect, it, vi } from 'vitest';
import { getCommerceRouterPort } from '../../modules/messages/commerce-router-port.js';
import { MessageRouterService } from '../../modules/messages/message-router.service.js';
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
      userDid: USER_DID,
    });
    expect(sendIntent).toHaveBeenCalledWith({
      collectionId: '42',
      amount: [{ denom: 'uixo', amount: '20000000' }],
    });
    expect(started.ok).toBe(true);
    expect(started.ok && started.engagement.status).toBe('active');
    expect(
      await port!.findActiveEngagement({
        senderDid: USER_DID,
        roomId: '!room:home',
        threadId: 'thread-1',
      }),
    ).toMatchObject({
      roomId: '!room:home',
      threadId: 'thread-1',
      engagement: { serviceId: 'tax-report' },
    });

    // The same live job is found from another room entirely: engagements are
    // one-per-user, and the user's next message may land anywhere.
    expect(
      await port!.findActiveEngagement({
        senderDid: USER_DID,
        roomId: '!elsewhere:home',
        threadId: 'thread-9',
      }),
    ).toMatchObject({ roomId: '!room:home', threadId: 'thread-1' });

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

  it('persists work mode, so the next turn routes to work with no classifier call', async () => {
    // The sequence a live run wedged on: a contracted user starts a job, then
    // types again. The engagement IS the persisted mode, and the router reads
    // it before anything else — if it were not durable (or not user-keyed) the
    // second message would re-classify and land back in support.
    const { registrar } = makeRegistrar({ ORACLE_ENTITY_DID });
    registrar.onModuleInit();

    const classify = vi.fn(async () => ({
      intent: 'work',
      serviceId: 'tax-report',
      confidence: 0.95,
    }));
    const router = new MessageRouterService({
      getModel: () => ({
        withStructuredOutput: () => ({ invoke: classify }),
      }),
      producer: { emit: vi.fn() },
      logger: { log: vi.fn(), warn: vi.fn(), debug: vi.fn() },
    });

    const first = await router.route({
      roomId: '!room:home',
      threadId: 'thread-1',
      senderDid: USER_DID,
      text: 'file my 2025 taxes',
      requestId: 'req-1',
    });

    expect(first?.mode).toBe('work');
    expect(first?.engagement?.status).toBe('active');
    expect(classify).toHaveBeenCalledTimes(1);

    // A different room AND a different thread — the message a user types on
    // the main timeline, which is its own thread root.
    const second = await router.route({
      roomId: '!elsewhere:home',
      threadId: 'thread-9',
      senderDid: USER_DID,
      text: 'also include my rental income',
      requestId: 'req-2',
    });

    expect(second).toMatchObject({
      mode: 'work',
      engagementRoomId: '!room:home',
      engagementThreadId: 'thread-1',
    });
    // The whole point: the classifier is never consulted again.
    expect(classify).toHaveBeenCalledTimes(1);

    registrar.onModuleDestroy();
  });

  it('refuses to register without the base-required ORACLE_ENTITY_DID', () => {
    const { registrar } = makeRegistrar({});

    expect(() => registrar.onModuleInit()).toThrow(/ORACLE_ENTITY_DID/);
    expect(getCommerceRouterPort()).toBeNull();
  });
});

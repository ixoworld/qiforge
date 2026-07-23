import type { BaseMessage } from '@langchain/core/messages';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { CommerceEngagement } from '../../plugin-api/types.js';
import {
  clearCommerceRouterPort,
  setCommerceRouterPort,
  type CommerceGateResult,
  type CommerceRoutedService,
  type CommerceRouterPort,
} from './commerce-router-port.js';
import {
  MessageRouterService,
  type RoutingModelFactory,
} from './message-router.service.js';

const ROOM_ID = '!room:home.server';
const THREAD_ID = 'evt-thread-root';
const SENDER_DID = 'did:ixo:user-1';
const REQUEST_ID = 'req-1';

const TAX_SERVICE: CommerceRoutedService = {
  id: 'tax-report',
  name: 'Tax report',
  description: 'A full tax report',
  tags: ['tax'],
  examples: ['File my 2025 taxes'],
  priceUsd: 20,
};

const ENGAGEMENT: CommerceEngagement = {
  status: 'active',
  serviceId: 'tax-report',
  serviceName: 'Tax report',
  priceUsd: 20,
  collectionId: '42',
  adminAddress: 'ixo1admin',
  startedAt: '2026-07-22T00:00:00.000Z',
};

function makePort(overrides: Partial<CommerceRouterPort> = {}): {
  port: CommerceRouterPort;
  spies: {
    getServices: ReturnType<typeof vi.fn>;
    getActiveEngagement: ReturnType<typeof vi.fn>;
    checkContractGate: ReturnType<typeof vi.fn>;
    startEngagement: ReturnType<typeof vi.fn>;
  };
} {
  const spies = {
    getServices: vi.fn(async () => [TAX_SERVICE]),
    getActiveEngagement: vi.fn(async () => null),
    checkContractGate: vi.fn(
      async (): Promise<CommerceGateResult> => ({
        ok: true,
        start: {
          serviceId: 'tax-report',
          serviceName: 'Tax report',
          priceUsd: 20,
          collectionId: '42',
          adminAddress: 'ixo1admin',
        },
      }),
    ),
    startEngagement: vi.fn(async () => ({
      ok: true as const,
      engagement: ENGAGEMENT,
    })),
  };
  const port: CommerceRouterPort = { ...spies, ...overrides };
  setCommerceRouterPort(port);
  return { port, spies };
}

/**
 * A model factory whose structured-output invocations return the queued
 * verdicts in order (a thrown Error entry rejects that invocation).
 */
function makeModelFactory(verdicts: Array<unknown | Error>): {
  factory: RoutingModelFactory;
  invocations: BaseMessage[][];
  modelParams: Array<{ model?: string } | undefined>;
} {
  const invocations: BaseMessage[][] = [];
  const modelParams: Array<{ model?: string } | undefined> = [];
  const factory: RoutingModelFactory = (params) => {
    modelParams.push(params);
    return {
      withStructuredOutput: () => ({
        invoke: async (messages) => {
          invocations.push(messages);
          const verdict = verdicts.shift();
          if (verdict instanceof Error) throw verdict;
          return verdict;
        },
      }),
    };
  };
  return { factory, invocations, modelParams };
}

function makeRouter(verdicts: Array<unknown | Error> = []): {
  router: MessageRouterService;
  invocations: BaseMessage[][];
  modelParams: Array<{ model?: string } | undefined>;
  producerEmit: ReturnType<typeof vi.fn>;
} {
  const { factory, invocations, modelParams } = makeModelFactory(verdicts);
  const producerEmit = vi.fn();
  const router = new MessageRouterService({
    getModel: factory,
    producer: { emit: producerEmit },
    logger: { warn: vi.fn(), debug: vi.fn() },
  });
  return { router, invocations, modelParams, producerEmit };
}

function turn(text: string) {
  return {
    roomId: ROOM_ID,
    threadId: THREAD_ID,
    senderDid: SENDER_DID,
    text,
    requestId: REQUEST_ID,
  };
}

afterEach(() => {
  clearCommerceRouterPort();
});

describe('MessageRouterService', () => {
  it('returns undefined (inert) when no port is registered', async () => {
    const { router, invocations } = makeRouter();

    expect(router.isActive()).toBe(false);
    const result = await router.route(turn('do my taxes'));

    expect(result).toBeUndefined();
    expect(invocations).toHaveLength(0);
  });

  it('routes to support with NO model call when the port has no services', async () => {
    makePort({ getServices: vi.fn(async () => null) });
    const { router, invocations, producerEmit } = makeRouter();

    const result = await router.route(turn('do my taxes'));

    expect(result).toEqual({ mode: 'support' });
    expect(invocations).toHaveLength(0);
    expect(producerEmit).not.toHaveBeenCalled();
  });

  it('classifies and routes a support verdict to support mode', async () => {
    const { spies } = makePort();
    const { router, producerEmit } = makeRouter([
      { intent: 'support', confidence: 0.9 },
    ]);

    const result = await router.route(turn('how much is a tax report?'));

    expect(result).toEqual({ mode: 'support' });
    expect(spies.checkContractGate).not.toHaveBeenCalled();
    // The routing phase is announced on the status card when classifying.
    expect(producerEmit).toHaveBeenCalledWith(REQUEST_ID, 'routing');
  });

  it('routes a confident work verdict through the gate and starts the engagement', async () => {
    const { spies } = makePort();
    const { router } = makeRouter([
      { intent: 'work', serviceId: 'tax-report', confidence: 0.95 },
    ]);

    const result = await router.route(turn('file my 2025 taxes now'));

    expect(spies.checkContractGate).toHaveBeenCalledWith({
      roomId: ROOM_ID,
      threadId: THREAD_ID,
      senderDid: SENDER_DID,
      service: TAX_SERVICE,
    });
    expect(spies.startEngagement).toHaveBeenCalledWith(ROOM_ID, THREAD_ID, {
      serviceId: 'tax-report',
      serviceName: 'Tax report',
      priceUsd: 20,
      collectionId: '42',
      adminAddress: 'ixo1admin',
    });
    expect(result).toEqual({ mode: 'work', engagement: ENGAGEMENT });
  });

  it('falls open to support when work confidence is below 0.6', async () => {
    const { spies } = makePort();
    const { router } = makeRouter([
      { intent: 'work', serviceId: 'tax-report', confidence: 0.5 },
    ]);

    const result = await router.route(turn('maybe taxes?'));

    expect(result).toEqual({ mode: 'support' });
    expect(spies.checkContractGate).not.toHaveBeenCalled();
    expect(spies.startEngagement).not.toHaveBeenCalled();
  });

  it('routes a gate failure to support with the failure context', async () => {
    const { spies } = makePort({
      checkContractGate: vi.fn(
        async (): Promise<CommerceGateResult> => ({
          ok: false,
          reason: 'quota_exhausted',
        }),
      ),
    });
    const { router } = makeRouter([
      { intent: 'work', serviceId: 'tax-report', confidence: 0.9 },
    ]);

    const result = await router.route(turn('file my taxes'));

    expect(result).toEqual({
      mode: 'support',
      gate: {
        reason: 'quota_exhausted',
        serviceId: 'tax-report',
        serviceName: 'Tax report',
      },
    });
    expect(spies.startEngagement).not.toHaveBeenCalled();
  });

  it('carries the blocking job through an engagement_in_progress refusal, without starting anything', async () => {
    const { spies } = makePort({
      checkContractGate: vi.fn(
        async (): Promise<CommerceGateResult> => ({
          ok: false,
          reason: 'engagement_in_progress',
          inProgress: {
            serviceId: 'bookkeeping',
            serviceName: 'Bookkeeping cleanup',
            threadId: 'evt-other-thread',
          },
        }),
      ),
    });
    const { router } = makeRouter([
      { intent: 'work', serviceId: 'tax-report', confidence: 0.9 },
    ]);

    const result = await router.route(turn('file my taxes'));

    expect(result).toEqual({
      mode: 'support',
      gate: {
        reason: 'engagement_in_progress',
        serviceId: 'tax-report',
        serviceName: 'Tax report',
        inProgress: {
          serviceId: 'bookkeeping',
          serviceName: 'Bookkeeping cleanup',
          threadId: 'evt-other-thread',
        },
      },
    });
    // No second reservation is ever attempted — the chain would refuse it.
    expect(spies.startEngagement).not.toHaveBeenCalled();
  });

  it('routes to support with intent_failed when the engagement cannot be started', async () => {
    const { spies } = makePort({
      startEngagement: vi.fn(async () => ({
        ok: false as const,
        reason: 'intent_failed' as const,
      })),
    });
    const { router } = makeRouter([
      { intent: 'work', serviceId: 'tax-report', confidence: 0.9 },
    ]);

    const result = await router.route(turn('file my taxes'));

    // The gate passed — the payment reservation is what failed — so the turn
    // must not run as work.
    expect(spies.checkContractGate).toHaveBeenCalled();
    expect(result).toEqual({
      mode: 'support',
      gate: {
        reason: 'intent_failed',
        serviceId: 'tax-report',
        serviceName: 'Tax report',
      },
    });
  });

  it('routes to support when the classifier picks an unknown serviceId', async () => {
    const { spies } = makePort();
    const { router } = makeRouter([
      { intent: 'work', serviceId: 'no-such-service', confidence: 0.9 },
    ]);

    const result = await router.route(turn('do the thing'));

    expect(result).toEqual({ mode: 'support' });
    expect(spies.checkContractGate).not.toHaveBeenCalled();
  });

  it('fails open to support when the classifier throws', async () => {
    makePort();
    const { router } = makeRouter([new Error('model down')]);

    const result = await router.route(turn('file my taxes'));

    expect(result).toEqual({ mode: 'support' });
  });

  it('fails open to support when the classifier returns a malformed verdict', async () => {
    makePort();
    const { router } = makeRouter([{ nonsense: true }]);

    const result = await router.route(turn('file my taxes'));

    expect(result).toEqual({ mode: 'support' });
  });

  it('fails open to support when a port lookup throws', async () => {
    makePort({
      getActiveEngagement: vi.fn(async () => {
        throw new Error('state read failed');
      }),
    });
    const { router } = makeRouter();

    const result = await router.route(turn('hello'));

    expect(result).toEqual({ mode: 'support' });
  });

  it('threads the port routerModel override into the model factory', async () => {
    makePort({ routerModel: 'openai/custom-router' });
    const { router, modelParams } = makeRouter([
      { intent: 'support', confidence: 0.9 },
    ]);

    await router.route(turn('what do you offer?'));

    expect(modelParams[0]).toEqual({ model: 'openai/custom-router' });
  });

  describe('sticky work mode (no transport-level cancel detection)', () => {
    it('stays in work mode without a classifier call while the engagement is active', async () => {
      const { spies } = makePort({
        getActiveEngagement: vi.fn(async () => ENGAGEMENT),
      });
      const { router, invocations, producerEmit } = makeRouter();

      const result = await router.route(turn('also include my Q3 invoices'));

      expect(result).toEqual({ mode: 'work', engagement: ENGAGEMENT });
      expect(invocations).toHaveLength(0);
      expect(spies.getServices).not.toHaveBeenCalled();
      expect(producerEmit).not.toHaveBeenCalled();
    });

    it('routes even cancel-sounding messages to the work agent — the router never cancels', async () => {
      // "cancel the meeting row in the sheet" is an INSTRUCTION, not a
      // cancellation; ending an engagement is the agent's call (cancel_work).
      const { spies } = makePort({
        getActiveEngagement: vi.fn(async () => ENGAGEMENT),
      });
      const { router, invocations } = makeRouter();

      for (const text of [
        'cancel',
        'never mind',
        'stop',
        'cancel the meeting row in the sheet',
      ]) {
        const result = await router.route(turn(text));
        expect(result).toEqual({ mode: 'work', engagement: ENGAGEMENT });
      }
      expect(invocations).toHaveLength(0);
      expect(spies.startEngagement).not.toHaveBeenCalled();
    });
  });
});

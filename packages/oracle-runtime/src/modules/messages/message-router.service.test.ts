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
  userDid: SENDER_DID,
};

/** The user's engagement, living in the room and thread the turn arrived in. */
const STICKY_HERE = {
  roomId: ROOM_ID,
  threadId: THREAD_ID,
  engagement: ENGAGEMENT,
};

const OTHER_ROOM_ID = '!other-room:home.server';
const OTHER_THREAD_ID = 'evt-other-thread-root';

/** The same user's engagement, living somewhere else entirely. */
const STICKY_ELSEWHERE = {
  roomId: OTHER_ROOM_ID,
  threadId: OTHER_THREAD_ID,
  engagement: ENGAGEMENT,
};

function makePort(overrides: Partial<CommerceRouterPort> = {}): {
  port: CommerceRouterPort;
  spies: {
    getServices: ReturnType<typeof vi.fn>;
    findActiveEngagement: ReturnType<typeof vi.fn>;
    checkContractGate: ReturnType<typeof vi.fn>;
    startEngagement: ReturnType<typeof vi.fn>;
  };
} {
  const spies = {
    getServices: vi.fn(async () => [TAX_SERVICE]),
    findActiveEngagement: vi.fn(async () => null),
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

interface LoggerSpies {
  log: ReturnType<typeof vi.fn>;
  warn: ReturnType<typeof vi.fn>;
  debug: ReturnType<typeof vi.fn>;
}

function makeRouter(verdicts: Array<unknown | Error> = []): {
  router: MessageRouterService;
  invocations: BaseMessage[][];
  modelParams: Array<{ model?: string } | undefined>;
  logger: LoggerSpies;
} {
  const { factory, invocations, modelParams } = makeModelFactory(verdicts);
  const logger: LoggerSpies = { log: vi.fn(), warn: vi.fn(), debug: vi.fn() };
  const router = new MessageRouterService({ getModel: factory, logger });
  return { router, invocations, modelParams, logger };
}

/** The single decision line the router emits for a routed turn. */
function decisionLine(logger: LoggerSpies): string {
  const call = logger.log.mock.calls
    .map(([line]) => String(line))
    .find((line) => line.includes('decision='));
  return call ?? '';
}

function turn(text: string) {
  return {
    roomId: ROOM_ID,
    threadId: THREAD_ID,
    senderDid: SENDER_DID,
    text,
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
    const { router, invocations } = makeRouter();

    const result = await router.route(turn('do my taxes'));

    expect(result).toEqual({ mode: 'support' });
    expect(invocations).toHaveLength(0);
  });

  it('classifies and routes a support verdict to support mode', async () => {
    const { spies } = makePort();
    const { router } = makeRouter([{ intent: 'support', confidence: 0.9 }]);

    const result = await router.route(turn('how much is a tax report?'));

    expect(result).toEqual({ mode: 'support' });
    expect(spies.checkContractGate).not.toHaveBeenCalled();
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
    expect(result).toEqual({
      mode: 'work',
      engagement: ENGAGEMENT,
      engagementRoomId: ROOM_ID,
      engagementThreadId: THREAD_ID,
    });
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
      findActiveEngagement: vi.fn(async () => {
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

  describe('routing decision logs', () => {
    it('announces an inert router once, not once per turn', async () => {
      const { router, logger } = makeRouter();

      expect(router.isActive()).toBe(false);
      expect(router.isActive()).toBe(false);

      const notices = logger.log.mock.calls
        .map(([line]) => String(line))
        .filter((line) => line.includes('inactive'));
      expect(notices).toHaveLength(1);
      expect(notices[0]).toContain('no commerce router port is registered');
    });

    it('names the sticky engagement that kept the turn in work mode', async () => {
      makePort({ findActiveEngagement: vi.fn(async () => STICKY_HERE) });
      const { router, logger } = makeRouter();

      await router.route(turn('also include my Q3 invoices'));

      // `classifier=skipped` is the unambiguous part: a locked-in user is
      // never classified again, and the line has to say so rather than leave
      // it to be inferred from an absent field.
      expect(decisionLine(logger)).toBe(
        `[commerce-router] thread=${THREAD_ID} mode=work decision=sticky-engagement service=tax-report classifier=skipped`,
      );
    });

    it('distinguishes a continued engagement from a same-thread sticky one', async () => {
      makePort({ findActiveEngagement: vi.fn(async () => STICKY_ELSEWHERE) });
      const { router, logger } = makeRouter();

      await router.route(turn('any progress on that report?'));

      expect(decisionLine(logger)).toBe(
        `[commerce-router] thread=${THREAD_ID} mode=work decision=continued-engagement service=tax-report classifier=skipped engagementRoom=${OTHER_ROOM_ID} engagementThread=${OTHER_THREAD_ID}`,
      );
    });

    it('records that no published services meant no classifier call', async () => {
      makePort({ getServices: vi.fn(async () => null) });
      const { router, logger } = makeRouter();

      await router.route(turn('do my taxes'));

      expect(decisionLine(logger)).toBe(
        `[commerce-router] thread=${THREAD_ID} mode=support decision=no-services`,
      );
    });

    it("records the classifier's verdict and confidence on a support turn", async () => {
      makePort();
      const { router, logger } = makeRouter([
        { intent: 'support', confidence: 0.88 },
      ]);

      await router.route(turn('how much is a tax report?'));

      expect(decisionLine(logger)).toBe(
        `[commerce-router] thread=${THREAD_ID} mode=support decision=classifier-support classifier=support/0.88`,
      );
    });

    it('reports the raw verdict when a work call was refused for low confidence', async () => {
      makePort();
      const { router, logger } = makeRouter([
        { intent: 'work', serviceId: 'tax-report', confidence: 0.5 },
      ]);

      await router.route(turn('maybe taxes?'));

      // The pre-threshold verdict is what explains the downgrade — logging the
      // post-threshold value would just say "support" and hide the reason.
      expect(decisionLine(logger)).toBe(
        `[commerce-router] thread=${THREAD_ID} mode=support decision=low-confidence service=tax-report classifier=work/0.5`,
      );
    });

    it('names the gate failure reason that sent a work request to support', async () => {
      makePort({
        checkContractGate: vi.fn(
          async (): Promise<CommerceGateResult> => ({
            ok: false,
            reason: 'not_contracted',
          }),
        ),
      });
      const { router, logger } = makeRouter([
        { intent: 'work', serviceId: 'tax-report', confidence: 0.9 },
      ]);

      await router.route(turn('file my taxes'));

      expect(decisionLine(logger)).toBe(
        `[commerce-router] thread=${THREAD_ID} mode=support decision=gate-failed service=tax-report reason=not_contracted classifier=work/0.9`,
      );
    });

    it('names the reason a passed gate still failed to start the job', async () => {
      makePort({
        startEngagement: vi.fn(async () => ({
          ok: false as const,
          reason: 'intent_failed' as const,
        })),
      });
      const { router, logger } = makeRouter([
        { intent: 'work', serviceId: 'tax-report', confidence: 0.9 },
      ]);

      await router.route(turn('file my taxes'));

      expect(decisionLine(logger)).toBe(
        `[commerce-router] thread=${THREAD_ID} mode=support decision=start-failed service=tax-report reason=intent_failed classifier=work/0.9`,
      );
    });

    it('records the engagement that put the turn into work mode', async () => {
      makePort();
      const { router, logger } = makeRouter([
        { intent: 'work', serviceId: 'tax-report', confidence: 0.95 },
      ]);

      await router.route(turn('file my 2025 taxes now'));

      expect(decisionLine(logger)).toBe(
        `[commerce-router] thread=${THREAD_ID} mode=work decision=engagement-started service=tax-report classifier=work/0.95`,
      );
    });

    it('records a fail-open after an unexpected routing error', async () => {
      makePort({
        findActiveEngagement: vi.fn(async () => {
          throw new Error('state read failed');
        }),
      });
      const { router, logger } = makeRouter();

      await router.route(turn('hello'));

      expect(decisionLine(logger)).toBe(
        `[commerce-router] thread=${THREAD_ID} mode=support decision=error`,
      );
      expect(logger.warn).toHaveBeenCalledWith(
        expect.stringContaining('state read failed'),
      );
    });

    it('never puts the user message into a routing log', async () => {
      makePort();
      const secret = 'my SSN is 123-45-6789';
      const { router, logger } = makeRouter([
        { intent: 'work', serviceId: 'tax-report', confidence: 0.95 },
      ]);

      await router.route(turn(secret));

      const everything = [
        ...logger.log.mock.calls,
        ...logger.warn.mock.calls,
        ...logger.debug.mock.calls,
      ]
        .map((args) => args.map(String).join(' '))
        .join('\n');
      expect(everything).not.toContain(secret);
    });
  });

  describe('sticky work mode (no transport-level cancel detection)', () => {
    it('stays in work mode without a classifier call while the engagement is active', async () => {
      const findActiveEngagement = vi.fn(async () => STICKY_HERE);
      const { spies } = makePort({ findActiveEngagement });
      const { router, invocations } = makeRouter();

      const result = await router.route(turn('also include my Q3 invoices'));

      expect(result).toEqual({
        mode: 'work',
        engagement: ENGAGEMENT,
        engagementRoomId: ROOM_ID,
        engagementThreadId: THREAD_ID,
      });
      expect(findActiveEngagement).toHaveBeenCalledWith({
        senderDid: SENDER_DID,
        roomId: ROOM_ID,
        threadId: THREAD_ID,
      });
      expect(invocations).toHaveLength(0);
      expect(spies.getServices).not.toHaveBeenCalled();
    });

    it('classifies exactly once across the turn that starts a job and the turn after it', async () => {
      // The classifier runs to OPEN a job and never again while it is open —
      // not for the rest of that turn, not for any later one. A second call
      // here would mean a locked-in user's message reached the model, which is
      // both a needless cost and the only way work could be misrouted back to
      // the free persona mid-job.
      let active: typeof STICKY_HERE | null = null;
      const { spies } = makePort({
        findActiveEngagement: vi.fn(async () => active),
        startEngagement: vi.fn(async () => {
          active = STICKY_HERE;
          return { ok: true as const, engagement: ENGAGEMENT };
        }),
      });
      const { router, invocations } = makeRouter([
        { intent: 'work', serviceId: 'tax-report', confidence: 0.95 },
      ]);

      const first = await router.route(turn('file my 2025 taxes now'));
      expect(first).toMatchObject({ mode: 'work' });
      expect(invocations).toHaveLength(1);

      const second = await router.route(turn('use the joint account too'));
      expect(second).toMatchObject({ mode: 'work' });
      expect(invocations).toHaveLength(1);
      expect(spies.getServices).toHaveBeenCalledTimes(1);
    });

    it('continues the live engagement when the turn arrives in another thread', async () => {
      // A bare main-timeline message is its own thread root, so a
      // thread-scoped lookup would miss and re-classify — dropping a paid job
      // back to the free support persona mid-flight.
      const { spies } = makePort({
        findActiveEngagement: vi.fn(async () => ({
          roomId: ROOM_ID,
          threadId: OTHER_THREAD_ID,
          engagement: ENGAGEMENT,
        })),
      });
      const { router, invocations } = makeRouter();

      const result = await router.route(turn('and add my Q3 invoices'));

      expect(result).toEqual({
        mode: 'work',
        engagement: ENGAGEMENT,
        engagementRoomId: ROOM_ID,
        engagementThreadId: OTHER_THREAD_ID,
      });
      expect(invocations).toHaveLength(0);
      expect(spies.getServices).not.toHaveBeenCalled();
      expect(spies.startEngagement).not.toHaveBeenCalled();
    });

    it('continues the live engagement when the turn arrives in another room', async () => {
      const { spies } = makePort({
        findActiveEngagement: vi.fn(async () => STICKY_ELSEWHERE),
      });
      const { router, invocations } = makeRouter();

      const result = await router.route(turn('any progress on that report?'));

      // The engagement is addressed where it lives, not where the message
      // landed — that is what deliver_work / cancel_work settle against.
      expect(result).toEqual({
        mode: 'work',
        engagement: ENGAGEMENT,
        engagementRoomId: OTHER_ROOM_ID,
        engagementThreadId: OTHER_THREAD_ID,
      });
      expect(invocations).toHaveLength(0);
      expect(spies.getServices).not.toHaveBeenCalled();
    });

    it('routes even cancel-sounding messages to the work agent — the router never cancels', async () => {
      // "cancel the meeting row in the sheet" is an INSTRUCTION, not a
      // cancellation; ending an engagement is the agent's call (cancel_work).
      const { spies } = makePort({
        findActiveEngagement: vi.fn(async () => STICKY_HERE),
      });
      const { router, invocations } = makeRouter();

      for (const text of [
        'cancel',
        'never mind',
        'stop',
        'cancel the meeting row in the sheet',
      ]) {
        const result = await router.route(turn(text));
        expect(result).toEqual({
          mode: 'work',
          engagement: ENGAGEMENT,
          engagementRoomId: ROOM_ID,
          engagementThreadId: THREAD_ID,
        });
      }
      expect(invocations).toHaveLength(0);
      expect(spies.startEngagement).not.toHaveBeenCalled();
    });
  });
});

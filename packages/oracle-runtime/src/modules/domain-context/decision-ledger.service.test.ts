/**
 * @fileoverview Tests for the half of the ledger that deals with the world.
 *
 * The behaviours worth testing here are all about failure: Matrix arriving
 * late, sends failing, the buffer filling. In each case the question is the
 * same — does the chain published to the room stay something an auditor can
 * verify, and does the runtime tell the truth about whether it can record?
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  AuthorizationDecision,
  AuthorizationRequest,
} from '../../constitution/authorize.js';
import {
  verifyChain,
  type DecisionRecord,
} from '../../constitution/decision-record.js';
import type { GateDecisionRecord } from '../../graph/middlewares/constitution-gate-middleware.js';
import type { Logger } from '../../plugin-api/types.js';
import { mockDomain } from '../../testing/mocks.js';
import {
  DECISION_EVENT_TYPE,
  DECISION_HEAD_EVENT_TYPE,
  DecisionLedgerService,
  type DecisionTransport,
} from './decision-ledger.service.js';

const ROOM = '!decisions:ixo.world';

function silentLogger(): Logger {
  return { log: vi.fn(), warn: vi.fn(), error: vi.fn() };
}

function gateDecision(
  overrides: Partial<AuthorizationRequest> = {},
  verdict: Partial<AuthorizationDecision> = {},
): GateDecisionRecord {
  const request: AuthorizationRequest = {
    principal: { did: 'did:ixo:entity:test', sessionId: 'sess-1' },
    action: 'write',
    operation: 'vfs_write',
    object: 'ixo:oracle/workspace/notes.md',
    ...overrides,
  };
  return {
    toolName: 'vfs_write',
    request,
    effectAssumed: false,
    decision: {
      outcome: 'permit',
      reasonCodes: [],
      ruleRefs: ['right:test:write'],
      obligations: [],
      time: {
        instant: '2026-08-03T00:00:00.000Z',
        epochMs: Date.parse('2026-08-03T00:00:00.000Z'),
        source: 'system_clock',
        trusted: true,
      },
      ...verdict,
    },
  };
}

interface Recording extends DecisionTransport {
  events: Array<{ type: string; content: object }>;
  state: Array<{ type: string; content: object }>;
  failNextSends: number;
}

function transport(): Recording {
  const it: Recording = {
    events: [],
    state: [],
    failNextSends: 0,
    sendEvent: async (roomId, type, content) => {
      expect(roomId).toBe(ROOM);
      if (it.failNextSends > 0) {
        it.failNextSends -= 1;
        throw new Error('matrix unreachable');
      }
      it.events.push({ type, content });
      return `$event-${it.events.length}`;
    },
    setState: async (roomId, type, _stateKey, content) => {
      expect(roomId).toBe(ROOM);
      it.state.push({ type, content });
    },
  };
  return it;
}

function ledger(
  options: {
    transport?: Recording;
    roomId?: string | null;
    maxBuffered?: number;
    logger?: Logger;
  } = {},
): { service: DecisionLedgerService; io: Recording; logger: Logger } {
  const io = options.transport ?? transport();
  const logger = options.logger ?? silentLogger();
  const service = new DecisionLedgerService({
    domain: mockDomain(),
    roomId: options.roomId === undefined ? ROOM : options.roomId,
    transport: io,
    logger,
    maxBuffered: options.maxBuffered,
    // No real waiting: the backoff is behaviour under test, not latency.
    delay: async () => undefined,
  });
  return { service, io, logger };
}

/** The records as an auditor reading the room would see them. */
function publishedChain(io: Recording): DecisionRecord[] {
  return io.events
    .filter((event) => event.type === DECISION_EVENT_TYPE)
    .map((event) => event.content as DecisionRecord);
}

describe('recording', () => {
  it('records permits and refusals alike', async () => {
    const { service, io } = ledger();
    service.markTransportReady();
    service.record(gateDecision());
    service.record(
      gateDecision({}, { outcome: 'deny', reasonCodes: ['no_matching_grant'] }),
    );
    await service.flush();

    const chain = publishedChain(io);
    expect(chain.map((r) => r.verdict.outcome)).toEqual(['permit', 'deny']);
    expect(verifyChain(chain)).toBeNull();
  });

  it('names the constitution that decided, by cid and revision', () => {
    const { service } = ledger();
    const record = service.record(gateDecision());
    const domain = mockDomain();
    expect(record?.rub).toEqual({
      authority: domain.subject,
      id: `${domain.domainMdCid}@${domain.documentRevision}`,
    });
  });

  it('publishes a head pointer once the queue drains', async () => {
    const { service, io } = ledger();
    service.markTransportReady();
    service.record(gateDecision());
    service.record(gateDecision());
    await service.flush();

    const head = io.state.filter((s) => s.type === DECISION_HEAD_EVENT_TYPE);
    expect(head.length).toBeGreaterThan(0);
    expect(head[head.length - 1].content).toMatchObject({
      seq: 1,
      count: 2,
      hash: service.tip?.hash,
    });
  });
});

describe('the window before Matrix is up', () => {
  // Matrix initialises in the background, well after the gate starts
  // deciding. Refusing everything until it lands would make the runtime
  // unusable for the first seconds of every boot.
  it('buffers decisions and publishes them in order once it arrives', async () => {
    const { service, io } = ledger();
    service.record(gateDecision({ object: 'ixo:a' }));
    service.record(gateDecision({ object: 'ixo:b' }));
    expect(io.events).toEqual([]);
    expect(service.available).toBe(true);

    service.markTransportReady();
    await service.flush();

    const chain = publishedChain(io);
    expect(chain.map((r) => r.request.object)).toEqual(['ixo:a', 'ixo:b']);
    expect(verifyChain(chain)).toBeNull();
  });
});

describe('when the ledger cannot record', () => {
  it('reports unavailable with no room to publish to', () => {
    const { service } = ledger({ roomId: null });
    expect(service.available).toBe(false);
    expect(service.record(gateDecision())).toBeNull();
  });

  // The gate turns a null into a refusal for effectful actions. That only
  // works if the ledger says null rather than accepting a record it will
  // silently drop.
  it('refuses to accept records once the buffer is full', () => {
    const { service, logger } = ledger({ maxBuffered: 2 });
    expect(service.record(gateDecision())).not.toBeNull();
    expect(service.record(gateDecision())).not.toBeNull();
    expect(service.record(gateDecision())).toBeNull();
    expect(service.available).toBe(false);
    expect(logger.error).toHaveBeenCalledWith(
      expect.stringContaining('constitution.ledger.unavailable'),
    );
  });

  // A gap would read to an auditor exactly like a deleted record.
  it('leaves no gap in the chain when it turns a record away', async () => {
    const { service, io } = ledger({ maxBuffered: 2 });
    service.record(gateDecision({ object: 'ixo:a' }));
    service.record(gateDecision({ object: 'ixo:b' }));
    service.record(gateDecision({ object: 'ixo:dropped' }));

    service.markTransportReady();
    await service.flush();

    const chain = publishedChain(io);
    expect(chain.map((r) => r.seq)).toEqual([0, 1]);
    expect(chain.map((r) => r.request.object)).toEqual(['ixo:a', 'ixo:b']);
    expect(verifyChain(chain)).toBeNull();
  });

  it('becomes available again once the backlog drains', async () => {
    const { service } = ledger({ maxBuffered: 1 });
    service.record(gateDecision());
    expect(service.record(gateDecision())).toBeNull();

    service.markTransportReady();
    await service.flush();

    expect(service.available).toBe(true);
    expect(service.record(gateDecision())).not.toBeNull();
  });
});

describe('publishing failures', () => {
  it('retries a failed send and carries on', async () => {
    const { service, io } = ledger();
    io.failNextSends = 2;
    service.markTransportReady();
    service.record(gateDecision());
    await service.flush();

    expect(publishedChain(io)).toHaveLength(1);
  });

  // Publishing record 2 while record 1 is still missing puts a record in the
  // room before the one it names as its predecessor — which reads to anyone
  // verifying as a broken chain rather than an incomplete one.
  it('holds the queue rather than publishing out of order', async () => {
    const { service, io, logger } = ledger();
    service.markTransportReady();
    io.failNextSends = 99;
    service.record(gateDecision({ object: 'ixo:a' }));
    service.record(gateDecision({ object: 'ixo:b' }));
    await service.flush();

    expect(publishedChain(io)).toEqual([]);
    expect(logger.error).toHaveBeenCalledWith(
      expect.stringContaining('constitution.ledger.publish_failed'),
    );

    io.failNextSends = 0;
    await service.flush();
    const chain = publishedChain(io);
    expect(chain.map((r) => r.request.object)).toEqual(['ixo:a', 'ixo:b']);
    expect(verifyChain(chain)).toBeNull();
  });

  it('treats a failed head pointer as recoverable, not as a lost record', async () => {
    const { service, io, logger } = ledger();
    io.setState = async () => {
      throw new Error('state rejected');
    };
    service.markTransportReady();
    service.record(gateDecision());
    await service.flush();

    expect(publishedChain(io)).toHaveLength(1);
    expect(logger.warn).toHaveBeenCalled();
  });
});

describe('ordering under concurrency', () => {
  let service: DecisionLedgerService;
  let io: Recording;

  beforeEach(() => {
    ({ service, io } = ledger());
  });

  // Two drains running at once would interleave sends, and the chain in the
  // room would no longer be in chain order.
  it('publishes in chain order when records arrive together', async () => {
    service.markTransportReady();
    const objects = Array.from({ length: 25 }, (_, i) => `ixo:item-${i}`);
    for (const object of objects) service.record(gateDecision({ object }));
    await service.flush();

    const chain = publishedChain(io);
    expect(chain.map((r) => r.request.object)).toEqual(objects);
    expect(chain.map((r) => r.seq)).toEqual(objects.map((_, i) => i));
    expect(verifyChain(chain)).toBeNull();
  });
});

import { Logger as NestLogger } from '@nestjs/common';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AgentCardService } from './agent-card.service.js';
import { ContractGateService } from './contract-gate.service.js';
import { ContractRecordService } from './contract-record.service.js';
import { EngagementService } from './engagement.service.js';

/**
 * Every one of these services used to declare `logger?: Logger` with no
 * default, so `this.logger?.warn?.(…)` was a no-op in production: the plugin
 * constructs them without a logger, and each of these failure lanes returns
 * `null` rather than throwing. The result was a commerce lane whose every
 * degradation — no agent card, an unreadable engagement, a contract lookup
 * that could not run — was completely invisible in the logs, which is what
 * made a live routing problem impossible to diagnose.
 *
 * These lock the invariant behaviourally: constructed with NO injected
 * logger, a service that hits a failure lane still writes to the Nest logger.
 */
describe('oracle-payments services are never silent by default', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  function spyOnNestWarn(): ReturnType<typeof vi.fn> {
    const warn = vi.fn();
    vi.spyOn(NestLogger.prototype, 'warn').mockImplementation(warn);
    return warn;
  }

  it('ContractRecordService reports a disabled lookup lane', async () => {
    const warn = spyOnNestWarn();

    const { record } = await new ContractRecordService().lookup({
      subscriberDid: 'did:ixo:user-1',
    });

    expect(record).toBeNull();
    expect(String(warn.mock.calls[0]?.[0])).toContain('EVAL_ENGINE_URL');
  });

  it('AgentCardService reports a card that cannot be resolved', async () => {
    const warn = spyOnNestWarn();

    const { card } = await new AgentCardService({
      getEntity: async () => {
        throw new Error('blocksync unreachable');
      },
    }).getCard('did:ixo:entity-1');

    expect(card).toBeNull();
    expect(String(warn.mock.calls[0]?.[0])).toContain('blocksync unreachable');
  });

  it('AgentCardService names an entity that publishes no #acard resource', async () => {
    const warn = spyOnNestWarn();

    const services = await new AgentCardService({
      getEntity: async () => ({ linkedResource: [] }),
    }).getServices('did:ixo:entity-1');

    // No card means the router skips its classifier and every Matrix turn
    // runs as support — the single most likely reason commerce "does nothing".
    expect(services).toBeNull();
    expect(String(warn.mock.calls[0]?.[0])).toContain('#acard');
  });

  it('EngagementService reports an engagement state read it could not complete', async () => {
    const warn = spyOnNestWarn();

    const engagement = await new EngagementService({
      stateStore: () => ({
        getState: async () => {
          throw new Error('matrix state unavailable');
        },
        setState: async () => undefined,
      }),
    }).getActive('!room:ixo', 'thread-1');

    expect(engagement).toBeNull();
    expect(String(warn.mock.calls[0]?.[0])).toContain(
      'matrix state unavailable',
    );
  });

  it('ContractGateService reports a lookup that threw under it', async () => {
    const warn = spyOnNestWarn();

    const gate = new ContractGateService({
      contractRecord: new ContractRecordService({
        fetchImpl: async () => {
          throw new Error('should not be reached');
        },
      }),
      engagement: { findActiveForUser: async () => null },
      network: 'devnet',
    });
    // Reach the record lane through a stub that throws where the service
    // contract says it never does — the belt-and-braces warn.
    vi.spyOn(ContractRecordService.prototype, 'lookup').mockRejectedValue(
      new Error('lookup blew up'),
    );

    const result = await gate.check({
      roomId: '!room:ixo',
      threadId: 'thread-1',
      senderDid: 'did:ixo:user-1',
      service: { id: 'tax-report', name: 'Tax report', priceUsd: 20 },
    });

    expect(result.ok).toBe(false);
    expect(String(warn.mock.calls[0]?.[0])).toContain('lookup blew up');
  });
});

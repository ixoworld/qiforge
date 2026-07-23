import { MatrixError } from '@ixo/matrix';
import { describe, expect, it, vi } from 'vitest';
import { ORACLE_COMPONENT_EVENT_TYPE } from '../../matrix/oracle-component-event.js';
import { validateManifest } from '../../manifest/validator.js';
import type { RuntimeContext } from '../../plugin-api/types.js';
import { makeRuntimeContext } from '../../registries/test-fixtures.js';
import { createTestRuntime } from '../../testing/create-test-runtime.js';
import { AgentCardService } from './agent-card.service.js';
import { EngagementService } from './engagement.service.js';
import { ContractGateService } from './contract-gate.service.js';
import { OraclePaymentsPlugin } from './oracle-payments.plugin.js';
import { WorkClaimService } from './work-claim.service.js';
import { WorkSummaryExtractor } from './work-summary-extractor.js';
import {
  componentContent,
  makeCardService,
  makeCommerceCtx,
  makeEngagement,
  makeEngagementService,
  makeContractRecord,
  makeContractRecordService,
  ORACLE_ENTITY_DID,
  type PostedEvent,
} from './__test-fixtures__/oracle-payments-fixtures.js';
import { ContractRecordService } from './contract-record.service.js';

/** A card service that always resolves to no card (no published services). */
function makeNullCardService(): AgentCardService {
  return new AgentCardService({
    getEntity: async () => null,
    fetchCard: async () => null,
  });
}

function toolsOf(plugin: OraclePaymentsPlugin, ctx: RuntimeContext) {
  const tools = plugin.getRequestTools(ctx);
  const byName = new Map(tools.map((t) => [t.name, t] as const));
  return {
    tools,
    get: (name: string) => {
      const tool = byName.get(name);
      if (!tool) throw new Error(`tool ${name} missing`);
      return tool;
    },
  };
}

/**
 * A work-claim service wired to in-memory collaborators. The lanes themselves
 * are spied on — these tests are about the tool wiring, not the chain.
 */
function makeStubbedWorkClaim(): WorkClaimService {
  const engagement = makeEngagementService();
  return new WorkClaimService({
    engagement,
    contractGate: new ContractGateService({
      contractRecord: makeContractRecordService(makeContractRecord()).service,
      engagement,
      network: 'devnet',
    }),
    extractor: new WorkSummaryExtractor(),
  });
}

describe('OraclePaymentsPlugin — registration', () => {
  it('has the expected name, version, and manifest shape', () => {
    const plugin = new OraclePaymentsPlugin();
    expect(plugin.name).toBe('oracle-payments');
    expect(plugin.version).toBe('1.0.0');
    expect(plugin.manifest.title).toBe('Oracle Payments');
    expect(plugin.manifest.visibility).toBe('always');
    expect(plugin.manifest.category).toBe('ui');
  });

  it('manifest passes validateManifest', () => {
    const plugin = new OraclePaymentsPlugin();
    const result = validateManifest(plugin.manifest, plugin.name);
    expect(result.errors).toEqual([]);
    expect(result.valid).toBe(true);
  });

  it('autoDetect is on by default and off when ORACLE_PAYMENTS_DISABLED=true', () => {
    const plugin = new OraclePaymentsPlugin();
    expect(plugin.autoDetect({})).toBe(true);
    expect(plugin.autoDetect({ ORACLE_PAYMENTS_DISABLED: 'true' })).toBe(false);
    expect(plugin.autoDetect({ ORACLE_PAYMENTS_DISABLED: 'false' })).toBe(true);
  });

  it('loads via createTestRuntime with no registry collisions', async () => {
    const rt = await createTestRuntime({
      plugins: [
        new OraclePaymentsPlugin({
          agentCard: makeCardService(),
          contractRecord: new ContractRecordService(),
        }),
      ],
    });
    rt.assertNoCollisions();
    rt.assertManifestValid();
    const listing = rt
      .listCapabilities()
      .find((c) => c.name === 'oracle-payments');
    expect(listing?.visibility).toBe('always');
    await rt.close();
  });

  it('is skipped when ORACLE_PAYMENTS_DISABLED=true', async () => {
    const rt = await createTestRuntime({
      plugins: [new OraclePaymentsPlugin({ agentCard: makeCardService() })],
      config: { ORACLE_PAYMENTS_DISABLED: 'true' },
    });
    expect(
      rt.listCapabilities().find((c) => c.name === 'oracle-payments'),
    ).toBeUndefined();
    await rt.close();
  });
});

describe('OraclePaymentsPlugin — commerce mode gating', () => {
  it('exposes the support tools without a commerce context', () => {
    const plugin = new OraclePaymentsPlugin({ agentCard: makeCardService() });
    const { tools } = toolsOf(plugin, makeCommerceCtx());
    expect(tools.map((t) => t.name).sort()).toEqual([
      'get_contract_status',
      'get_thread_attachment',
      'list_services',
      'show_contract',
    ]);
  });

  it('exposes the same support tools in support mode', () => {
    const plugin = new OraclePaymentsPlugin({ agentCard: makeCardService() });
    const ctx = makeRuntimeContext({ commerce: { mode: 'support' } });
    expect(
      plugin
        .getRequestTools(ctx)
        .map((t) => t.name)
        .sort(),
    ).toEqual([
      'get_contract_status',
      'get_thread_attachment',
      'list_services',
      'show_contract',
    ]);
  });

  it('swaps to the work surface in work mode', () => {
    const plugin = new OraclePaymentsPlugin({ agentCard: makeCardService() });
    const ctx = makeRuntimeContext({
      commerce: {
        mode: 'work',
        engagement: {
          status: 'active',
          serviceId: 'tax-report',
          serviceName: 'Tax report',
          priceUsd: 20,
          collectionId: '42',
          adminAddress: 'ixo1admin',
          startedAt: '2026-07-22T00:00:00.000Z',
        },
      },
    });
    expect(plugin.getRequestTools(ctx).map((t) => t.name)).toEqual([
      'deliver_work',
      'cancel_work',
      'get_thread_attachment',
    ]);
  });
});

describe('OraclePaymentsPlugin — cancel_work wiring', () => {
  function workCtx(): RuntimeContext {
    return makeCommerceCtx({
      commerce: { mode: 'work', engagement: makeEngagement() },
    });
  }

  it('validates the args and hands them to the release lane', async () => {
    const workClaim = makeStubbedWorkClaim();
    const release = vi.spyOn(workClaim, 'release').mockResolvedValue({
      cancelled: true,
      serviceId: 'tax-report',
      serviceName: 'Tax report',
      claimId: 'claim-cid-1',
      txHash: 'TX-1',
      note: 'released',
    });
    const plugin = new OraclePaymentsPlugin({
      agentCard: makeCardService(),
      workClaim,
    });
    const ctx = workCtx();

    const result = await toolsOf(plugin, ctx)
      .get('cancel_work')
      .handler({ reason: 'found an accountant' }, ctx);

    expect(result).toMatchObject({ cancelled: true, claimId: 'claim-cid-1' });
    expect(release).toHaveBeenCalledWith(
      { reason: 'found an accountant' },
      ctx,
    );
  });

  it('accepts a bare cancellation with no reason', async () => {
    const workClaim = makeStubbedWorkClaim();
    const release = vi
      .spyOn(workClaim, 'release')
      .mockResolvedValue({ cancelled: false, note: 'nothing to cancel' });
    const plugin = new OraclePaymentsPlugin({
      agentCard: makeCardService(),
      workClaim,
    });
    const ctx = workCtx();

    const result = await toolsOf(plugin, ctx)
      .get('cancel_work')
      .handler({}, ctx);

    expect(result).toMatchObject({ cancelled: false });
    expect(release).toHaveBeenCalledWith({}, ctx);
  });

  it('rejects a non-string reason before touching the release lane', async () => {
    const workClaim = makeStubbedWorkClaim();
    const release = vi.spyOn(workClaim, 'release');
    const plugin = new OraclePaymentsPlugin({
      agentCard: makeCardService(),
      workClaim,
    });
    const ctx = workCtx();

    await expect(
      toolsOf(plugin, ctx).get('cancel_work').handler({ reason: 7 }, ctx),
    ).rejects.toThrow();
    expect(release).not.toHaveBeenCalled();
  });
});

describe('OraclePaymentsPlugin — getSharedState.oraclePayments.services()', () => {
  function hasServices(
    value: unknown,
  ): value is { services: () => Promise<unknown> } {
    return (
      typeof value === 'object' &&
      value !== null &&
      'services' in value &&
      typeof value.services === 'function'
    );
  }

  it('exposes the resolved card services', async () => {
    const plugin = new OraclePaymentsPlugin({ agentCard: makeCardService() });
    const accessor = plugin.getSharedState().oraclePayments;
    const runCtx = makeRuntimeContext({ config: { ORACLE_ENTITY_DID } });
    const value = accessor({}, runCtx);
    if (!hasServices(value)) throw new Error('expected a services() accessor');
    const services = await value.services();
    expect(Array.isArray(services)).toBe(true);
  });

  it('returns null when ORACLE_ENTITY_DID is absent from config', async () => {
    const plugin = new OraclePaymentsPlugin({ agentCard: makeCardService() });
    const accessor = plugin.getSharedState().oraclePayments;
    const value = accessor({}, makeRuntimeContext({ config: {} }));
    if (!hasServices(value)) throw new Error('expected a services() accessor');
    expect(await value.services()).toBeNull();
  });

  it('exposes the thread engagement through oraclePayments.engagement()', async () => {
    const store = new Map<string, unknown>();
    const engagement = new EngagementService({
      stateStore: () => ({
        getState: async (_roomId, stateKey) => {
          if (!store.has(stateKey)) {
            throw new MatrixError(
              { errcode: 'M_NOT_FOUND', error: 'Not found' },
              404,
            );
          }
          return store.get(stateKey);
        },
        setState: async (payload) => {
          store.set(payload.stateKey, payload.data);
        },
      }),
    });
    await engagement.start('!room:home', 'thread-1', {
      serviceId: 'tax-report',
      serviceName: 'Tax report',
      priceUsd: 20,
      collectionId: '42',
      adminAddress: 'ixo1admin',
    });

    const plugin = new OraclePaymentsPlugin({
      agentCard: makeCardService(),
      engagement,
    });
    const accessor = plugin.getSharedState().oraclePayments;
    const value = accessor({}, makeRuntimeContext({}));
    const hasEngagement = (
      v: unknown,
    ): v is { engagement: (r: string, t: string) => Promise<unknown> } =>
      typeof v === 'object' &&
      v !== null &&
      'engagement' in v &&
      typeof v.engagement === 'function';
    if (!hasEngagement(value)) {
      throw new Error('expected an engagement() accessor');
    }

    const active = await value.engagement('!room:home', 'thread-1');
    expect(active).toMatchObject({ status: 'active', serviceId: 'tax-report' });
    expect(await value.engagement('!room:home', 'other-thread')).toBeNull();
  });
});

describe('OraclePaymentsPlugin — tools', () => {
  it('list_services posts a list_services component and returns the service list', async () => {
    const posted: PostedEvent[] = [];
    const plugin = new OraclePaymentsPlugin({ agentCard: makeCardService() });
    const ctx = makeCommerceCtx({ posted });
    const result = await toolsOf(plugin, ctx)
      .get('list_services')
      .handler({}, ctx);

    expect(posted).toHaveLength(1);
    expect(posted[0]?.eventType).toBe(ORACLE_COMPONENT_EVENT_TYPE);
    const content = componentContent(posted[0]!);
    expect(content.component).toBe('list_services');
    expect(content.props.oracleEntityDid).toBe(ORACLE_ENTITY_DID);
    expect(content['m.relates_to']).toEqual({
      rel_type: 'm.thread',
      event_id: '$thread-root:ixo.world',
    });
    const services = content.props.services;
    expect(Array.isArray(services)).toBe(true);
    expect(result).toMatchObject({ services: expect.any(Array) });
  });

  it('list_services returns a plain "no services" message when there is no card', async () => {
    const posted: PostedEvent[] = [];
    const emptyPlugin = new OraclePaymentsPlugin({
      agentCard: makeNullCardService(),
    });
    const ctx = makeCommerceCtx({ posted });
    const result = await toolsOf(emptyPlugin, ctx)
      .get('list_services')
      .handler({}, ctx);
    expect(result).toMatch(/no published services/i);
    expect(posted).toHaveLength(0);
  });

  it('show_contract posts a show_contract component with reason=user_asked and returns posted:true', async () => {
    const posted: PostedEvent[] = [];
    const plugin = new OraclePaymentsPlugin({ agentCard: makeCardService() });
    const ctx = makeCommerceCtx({ posted });
    const result = await toolsOf(plugin, ctx)
      .get('show_contract')
      .handler({ serviceId: 'tax-report' }, ctx);

    expect(result).toEqual({ posted: true });
    expect(posted).toHaveLength(1);
    const content = componentContent(posted[0]!);
    expect(content.component).toBe('show_contract');
    expect(content.props.reason).toBe('user_asked');
    expect(content.props.oracleAddress).toBe('ixo1oracleaddr');
    expect(content.props.service).toMatchObject({ id: 'tax-report' });
  });

  it('show_contract carries the gate-failure reason from ctx.commerce', async () => {
    const posted: PostedEvent[] = [];
    const plugin = new OraclePaymentsPlugin({ agentCard: makeCardService() });
    const base = makeCommerceCtx({ posted });
    const ctx: RuntimeContext = {
      ...base,
      commerce: {
        mode: 'support',
        gate: { reason: 'quota_exhausted', serviceId: 'tax-report' },
      },
    };
    await toolsOf(plugin, ctx)
      .get('show_contract')
      .handler({ serviceId: 'tax-report' }, ctx);

    const content = componentContent(posted[0]!);
    expect(content.props.reason).toBe('quota_exhausted');
  });

  it('show_contract throws with the valid ids for an unknown serviceId', async () => {
    const posted: PostedEvent[] = [];
    const plugin = new OraclePaymentsPlugin({ agentCard: makeCardService() });
    const ctx = makeCommerceCtx({ posted });
    await expect(
      toolsOf(plugin, ctx)
        .get('show_contract')
        .handler({ serviceId: 'nope' }, ctx),
    ).rejects.toThrow(/tax-report/);
    expect(posted).toHaveLength(0);
  });

  it('get_contract_status returns a compact status from the contract record', async () => {
    const plugin = new OraclePaymentsPlugin({
      agentCard: makeCardService(),
      contractRecord: makeContractRecordService(makeContractRecord()).service,
    });
    const ctx = makeCommerceCtx();
    const result = await toolsOf(plugin, ctx)
      .get('get_contract_status')
      .handler({}, ctx);

    expect(result).toEqual({
      contracted: true,
      status: 'active',
      serviceIds: ['tax-report'],
      quotaRemaining: 3,
      maxAmount: { amount: '20000000', denom: 'uixo' },
    });
  });

  it('get_contract_status returns { contracted: false } when there is no contract', async () => {
    const plugin = new OraclePaymentsPlugin({
      agentCard: makeCardService(),
      contractRecord: makeContractRecordService(null).service,
    });
    const ctx = makeCommerceCtx();
    const result = await toolsOf(plugin, ctx)
      .get('get_contract_status')
      .handler({}, ctx);
    expect(result).toEqual({ contracted: false });
  });
});

describe('OraclePaymentsPlugin — deliver_work wiring', () => {
  function workCtxWithEngagement(): RuntimeContext {
    return makeCommerceCtx({
      commerce: { mode: 'work', engagement: makeEngagement() },
    });
  }

  it('validates the args and hands them to the delivery lane', async () => {
    const workClaim = makeStubbedWorkClaim();
    const deliver = vi
      .spyOn(workClaim, 'deliver')
      .mockResolvedValue({ claimId: 'cid', txHash: 'tx', delivered: true });
    const plugin = new OraclePaymentsPlugin({
      agentCard: makeCardService(),
      workClaim,
    });
    const ctx = workCtxWithEngagement();

    const args = {
      description: 'Report ready.',
      resultStatus: 'completed' as const,
      deliverable: { kind: 'text' as const, text: '# report' },
    };
    const result = await toolsOf(plugin, ctx)
      .get('deliver_work')
      .handler(args, ctx);

    expect(result).toEqual({ claimId: 'cid', txHash: 'tx', delivered: true });
    expect(deliver).toHaveBeenCalledWith(args, ctx);
  });

  it('rejects an unknown resultStatus before touching the delivery lane', async () => {
    const workClaim = makeStubbedWorkClaim();
    const deliver = vi.spyOn(workClaim, 'deliver');
    const plugin = new OraclePaymentsPlugin({
      agentCard: makeCardService(),
      workClaim,
    });
    const ctx = workCtxWithEngagement();

    await expect(
      toolsOf(plugin, ctx)
        .get('deliver_work')
        .handler(
          {
            description: 'Report ready.',
            resultStatus: 'amazing',
            deliverable: { kind: 'text', text: '# report' },
          },
          ctx,
        ),
    ).rejects.toThrow();
    expect(deliver).not.toHaveBeenCalled();
  });
});

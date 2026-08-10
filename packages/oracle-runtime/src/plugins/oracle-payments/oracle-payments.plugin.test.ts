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
  ROOM_ID,
  THREAD_ID,
  type PostedEvent,
} from './__test-fixtures__/oracle-payments-fixtures.js';
import { ContractRecordService } from './contract-record.service.js';
import type { ContractRecord } from './types.js';
import { WorkIntentService } from './work-intent.service.js';

/** A card service that always resolves to no card (no published services). */
/** An oracle whose entity doc reads fine but anchors no agent card. */
function makeNullCardService(): AgentCardService {
  return new AgentCardService({
    getEntity: async () => ({ linkedResource: [] }),
    fetchCard: async () => null,
  });
}

/** An oracle that publishes a card but cannot reach it right now. */
function makeUnreachableCardService(): AgentCardService {
  return new AgentCardService({
    getEntity: async () => {
      throw new Error('blocksync unreachable');
    },
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
  /** The read-only surface both Matrix modes carry. */
  const SHARED_TOOLS = [
    'get_contract_status',
    'get_thread_attachment',
    'list_services',
    'show_contract',
  ];

  it('contributes NOTHING on a non-Matrix turn', () => {
    // Every tool here speaks Matrix — component cards, thread-keyed
    // engagements, room uploads. On HTTP/portal/Slack they are meaningless at
    // best, so the plugin stays out of the surface entirely.
    const plugin = new OraclePaymentsPlugin({ agentCard: makeCardService() });
    for (const client of ['http', 'portal', 'slack'] as const) {
      const ctx = makeRuntimeContext({
        session: { id: 's1', client, requestId: 'r1' },
        commerce: { mode: 'support' },
      });
      expect(plugin.getRequestTools(ctx)).toEqual([]);
    }
  });

  it('exposes the read-only tools on a Matrix turn the router left inert', () => {
    // No commerce context (no agent card yet): the user can still ask what is
    // on offer, but `start_work` — which would open an escrowed engagement
    // nothing reads — is not there.
    const plugin = new OraclePaymentsPlugin({ agentCard: makeCardService() });
    const { tools } = toolsOf(plugin, makeCommerceCtx());
    expect(tools.map((t) => t.name).sort()).toEqual(SHARED_TOOLS);
  });

  it('adds start_work — the only route into work mode — in support mode', () => {
    const plugin = new OraclePaymentsPlugin({ agentCard: makeCardService() });
    const ctx = makeCommerceCtx({ commerce: { mode: 'support' } });
    expect(
      plugin
        .getRequestTools(ctx)
        .map((t) => t.name)
        .sort(),
    ).toEqual([...SHARED_TOOLS, 'start_work'].sort());
  });

  it('keeps the read-only tools in work mode and adds delivery + cancellation', () => {
    // A locked-in user still gets to ask "what am I paying for?" without
    // abandoning the job — so the shared surface travels into work mode.
    const plugin = new OraclePaymentsPlugin({ agentCard: makeCardService() });
    const ctx = makeCommerceCtx({
      commerce: { mode: 'work', engagement: makeEngagement() },
    });
    const names = plugin.getRequestTools(ctx).map((t) => t.name);
    expect(names.slice(0, 2)).toEqual(['deliver_work', 'cancel_work']);
    expect(names.slice(2).sort()).toEqual(SHARED_TOOLS);
    expect(names).not.toContain('start_work');
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

/**
 * `start_work` is the ONLY route from support mode into work mode, and it runs
 * the same gate + escrow lane the router runs. These pin both halves: a job
 * really opens when the gate passes, and NOTHING happens — no chain write, no
 * engagement — when it does not.
 */
describe('OraclePaymentsPlugin — start_work', () => {
  /** `intentCode` non-zero models the chain rejecting the reservation. */
  function makeStartWorkPlugin(
    record: ContractRecord | null,
    intentCode = 0,
    /** An engine that fails instead of answering the contract lookup. */
    fetchImpl?: typeof fetch,
    /** The chain's own words for a rejected reservation. */
    intentRawLog = 'out of gas',
  ): {
    plugin: OraclePaymentsPlugin;
    engagement: EngagementService;
    sendIntent: ReturnType<typeof vi.fn>;
  } {
    const engagement = makeEngagementService();
    const contractGate = new ContractGateService({
      contractRecord: makeContractRecordService(record, fetchImpl).service,
      engagement,
      engineUrl: 'https://engine.example',
    });
    const sendIntent = vi.fn(async () => ({
      code: intentCode,
      transactionHash: intentCode === 0 ? 'TX-INTENT-1' : '',
      rawLog: intentCode === 0 ? '' : intentRawLog,
    }));
    const workIntent = new WorkIntentService({
      engagement,
      chain: { sendIntent },
      clock: () => new Date('2026-07-22T12:00:00.000Z'),
    });
    const plugin = new OraclePaymentsPlugin({
      agentCard: makeCardService(),
      engagement,
      contractGate,
      workIntent,
    });
    return { plugin, engagement, sendIntent };
  }

  const supportCtx = (): RuntimeContext =>
    makeCommerceCtx({ commerce: { mode: 'support' } });

  it('opens the engagement when the contract gate passes', async () => {
    const { plugin, engagement, sendIntent } =
      makeStartWorkPlugin(makeContractRecord());
    const ctx = supportCtx();

    const result = await toolsOf(plugin, ctx)
      .get('start_work')
      .handler({ serviceId: 'tax-report' }, ctx);

    expect(result).toMatchObject({
      started: true,
      serviceId: 'tax-report',
      serviceName: 'Tax report',
    });
    expect(sendIntent).toHaveBeenCalledTimes(1);
    // The engagement is live from here on, so the NEXT turn routes to work.
    const active = await engagement.getActive(ROOM_ID, THREAD_ID);
    expect(active).toMatchObject({
      status: 'active',
      serviceId: 'tax-report',
      intent: { txHash: 'TX-INTENT-1' },
    });
    // …but this turn's tools were bound in support mode, and the result has to
    // say so or the model will narrate work it cannot do.
    expect(String((result as { note: string }).note)).toContain(
      'not bound in this reply',
    );
  });

  it('starts nothing and reports the gate reason when the user is not contracted', async () => {
    const { plugin, engagement, sendIntent } = makeStartWorkPlugin(null);
    const ctx = supportCtx();

    const result = await toolsOf(plugin, ctx)
      .get('start_work')
      .handler({ serviceId: 'tax-report' }, ctx);

    expect(result).toMatchObject({
      started: false,
      reason: 'not_contracted',
      serviceId: 'tax-report',
    });
    // The refusal is the router's own wording, so a gate failure reads the
    // same whether it happened before the turn or inside it.
    expect(String((result as { message: string }).message)).toContain(
      'show_contract',
    );
    expect(sendIntent).not.toHaveBeenCalled();
    expect(await engagement.getActive(ROOM_ID, THREAD_ID)).toBeNull();
  });

  it('reports service_not_contracted for a service outside the contract', async () => {
    const { plugin, sendIntent } = makeStartWorkPlugin(
      makeContractRecord({ serviceIds: ['something-else'] }),
    );
    const ctx = supportCtx();

    const result = await toolsOf(plugin, ctx)
      .get('start_work')
      .handler({ serviceId: 'tax-report' }, ctx);

    expect(result).toMatchObject({
      started: false,
      reason: 'service_not_contracted',
    });
    expect(sendIntent).not.toHaveBeenCalled();
  });

  it("reports intent_failed WITH the chain's reason and starts nothing when the reservation is rejected", async () => {
    // The contract is fine; the escrow write is what failed. Nothing may be
    // left behind — an engagement with no reservation would route the user
    // into work mode for a job that was never paid for.
    const { plugin, engagement } = makeStartWorkPlugin(makeContractRecord(), 5);
    const ctx = supportCtx();

    const result = await toolsOf(plugin, ctx)
      .get('start_work')
      .handler({ serviceId: 'tax-report' }, ctx);

    // `intent_failed` on its own is what leaves the agent saying "the tool
    // responded with intent_failed and didn't provide a more specific error".
    // The chain's rawLog rides along, on the result AND in the instruction.
    expect(result).toMatchObject({
      started: false,
      reason: 'intent_failed',
      detail: expect.stringContaining('out of gas'),
      message: expect.stringContaining('out of gas'),
    });
    expect(await engagement.getActive(ROOM_ID, THREAD_ID)).toBeNull();
  });

  it('refuses with insufficient_funds and tells the user to top up', async () => {
    // The contract is fine and the chain is fine — their balance is short, so
    // the one instruction that helps is "top up", not "try again shortly".
    const { plugin, engagement } = makeStartWorkPlugin(
      makeContractRecord(),
      5,
      undefined,
      'spendable balance 1000000upay is smaller than 20000000upay: insufficient funds',
    );
    const ctx = supportCtx();

    const result = await toolsOf(plugin, ctx)
      .get('start_work')
      .handler({ serviceId: 'tax-report' }, ctx);

    expect(result).toMatchObject({
      started: false,
      reason: 'insufficient_funds',
      detail: expect.stringContaining('2,000 credits'),
      message: expect.stringContaining('top up'),
    });
    // Neither the chain's denom nor a contract card: the first is jargon, the
    // second would tell a contracted user their contract is the problem.
    const message = JSON.stringify(result);
    expect(message).not.toContain('upay');
    expect(message).toContain('do not call `show_contract`');
    expect(await engagement.getActive(ROOM_ID, THREAD_ID)).toBeNull();
  });

  it('refuses with contract_check_failed — not not_contracted — when the engine cannot be reached', async () => {
    const { plugin, sendIntent } = makeStartWorkPlugin(null, 0, async () => {
      throw new Error('ECONNREFUSED');
    });
    const ctx = supportCtx();

    const result = await toolsOf(plugin, ctx)
      .get('start_work')
      .handler({ serviceId: 'tax-report' }, ctx);

    expect(result).toMatchObject({
      started: false,
      reason: 'contract_check_failed',
      detail: expect.stringContaining('ECONNREFUSED'),
    });
    // The user may well be contracted — nothing here establishes otherwise, so
    // the instruction has to forbid the contract card rather than prescribe it.
    expect(String((result as { message: string }).message)).toMatch(
      /do NOT call `show_contract`/,
    );
    expect(sendIntent).not.toHaveBeenCalled();
  });

  it('throws with the valid ids for an unknown serviceId', async () => {
    const { plugin, sendIntent } = makeStartWorkPlugin(makeContractRecord());
    const ctx = supportCtx();

    await expect(
      toolsOf(plugin, ctx)
        .get('start_work')
        .handler({ serviceId: 'not-a-service' }, ctx),
    ).rejects.toThrow(/tax-report, quick-estimate/);
    expect(sendIntent).not.toHaveBeenCalled();
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
    // The body is what a client with no component renderer shows the user, so
    // it prices in credits like every other sentence they read.
    expect(content.body).toContain('2,000 credits');
    expect(content.body).not.toContain('PAY');
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

  it('list_services reports WHY the catalogue is unavailable instead of claiming there are no services', async () => {
    // "This oracle has no published services" for what is really an outage
    // tells the user something false and leaves the agent nothing to explain.
    const posted: PostedEvent[] = [];
    const plugin = new OraclePaymentsPlugin({
      agentCard: makeUnreachableCardService(),
    });
    const ctx = makeCommerceCtx({ posted });
    const result = await toolsOf(plugin, ctx)
      .get('list_services')
      .handler({}, ctx);

    expect(result).toMatchObject({
      error: expect.stringContaining('blocksync unreachable'),
    });
    expect(String(result)).not.toMatch(/no published services/i);
    expect(posted).toHaveLength(0);
  });

  it('show_contract blames the outage, not the service id, when the card cannot be read', async () => {
    const plugin = new OraclePaymentsPlugin({
      agentCard: makeUnreachableCardService(),
    });
    const ctx = makeCommerceCtx();

    await expect(
      toolsOf(plugin, ctx)
        .get('show_contract')
        .handler({ serviceId: 'tax-report' }, ctx),
    ).rejects.toThrow(/blocksync unreachable/);
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

    // The per-job cap in credits, never the grant's raw `{amount, denom}`:
    // the model reads this straight out to the user.
    expect(result).toEqual({
      contracted: true,
      status: 'active',
      serviceIds: ['tax-report'],
      quotaRemaining: 3,
      perJobLimitCredits: 2000,
    });
  });

  it('get_contract_status reports "unknown" — never contracted:false — when the check fails', async () => {
    // A contracted user told "you have no contract" because the engine was
    // down is the worst answer this tool can give, so the failure lane says
    // what happened instead of guessing an answer.
    const plugin = new OraclePaymentsPlugin({
      agentCard: makeCardService(),
      contractRecord: makeContractRecordService(null, async () => {
        throw new Error('ECONNREFUSED');
      }).service,
    });
    const ctx = makeCommerceCtx();
    const result = await toolsOf(plugin, ctx)
      .get('get_contract_status')
      .handler({}, ctx);

    expect(result).toMatchObject({
      error: expect.stringContaining('ECONNREFUSED'),
    });
    expect(result).not.toHaveProperty('contracted');
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

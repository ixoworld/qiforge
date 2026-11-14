import { MsgExec } from '@ixo/impactxclient-sdk/module/codegen/cosmos/authz/v1beta1/tx.js';
import {
  MsgClaimIntent,
  MsgSubmitClaim,
} from '@ixo/impactxclient-sdk/module/codegen/ixo/claims/v1beta1/tx.js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createMemoryUserKv } from '../../core/user-kv';
import type { ChainMessage, UserKvSurface } from '../../plugin-api/types';
import { EngagementStore } from './engagements';
import { cancelWork, deliverWork, startWork } from './lane';
import { resolvePaymentsEnv } from './config';
import { supportTools } from './tools';
import {
  ADMIN,
  COLLECTION,
  ORACLE,
  PAYMENTS_ENV,
  CARD,
  buyerCtx,
  devnetState,
  recordingChain,
  stubDevnetFetch,
  type DevnetState,
  type RecordingChain,
} from './test-fixtures';

function isMsgExec(value: unknown): value is MsgExec {
  return (
    typeof value === 'object' &&
    value !== null &&
    'grantee' in value &&
    'msgs' in value &&
    Array.isArray(value.msgs)
  );
}

/** The single inner msg of an authz `MsgExec`, after a real encode/decode round trip. */
function inner(message: ChainMessage | undefined): {
  typeUrl: string;
  value: Uint8Array;
} {
  if (
    message?.typeUrl !== '/cosmos.authz.v1beta1.MsgExec' ||
    !isMsgExec(message.value)
  ) {
    throw new Error(`expected a MsgExec, got ${message?.typeUrl}`);
  }
  const exec = MsgExec.decode(MsgExec.encode(message.value).finish());
  const first = exec.msgs[0];
  if (!first) throw new Error('empty MsgExec');
  return { typeUrl: first.typeUrl, value: first.value };
}

const deliver = {
  description: 'Designed the MRV plan.',
  resultStatus: 'completed' as const,
  // Multibyte on purpose: bytes ≠ chars is what broke the bot's size guess.
  text: '# MRV plan — mangroves\n\n40 ha · CO₂e ≥ 10 t…',
};

describe('oracle-payments lane', () => {
  let state: DevnetState;
  let chain: RecordingChain;
  let kv: UserKvSurface;
  const deps = () => ({ ctx: buyerCtx({ chain, kv }), env: PAYMENTS_ENV });

  beforeEach(() => {
    state = devnetState();
    stubDevnetFetch(state);
    chain = recordingChain();
    kv = createMemoryUserKv();
  });
  afterEach(() => vi.unstubAllGlobals());

  it('start_work reserves the agreed price on the gated collection and records the job', async () => {
    const res = await startWork(deps(), 'mrv-plan');
    expect(res).toMatchObject({ started: true });

    const msg = inner(chain.sent[0]?.messages[0]);
    expect(msg.typeUrl).toBe('/ixo.claims.v1beta1.MsgClaimIntent');
    expect(MsgClaimIntent.decode(msg.value)).toMatchObject({
      agentAddress: ORACLE,
      agentDid: `did:ixo:${ORACLE}`,
      collectionId: COLLECTION,
      amount: [{ denom: 'upay', amount: '2000000000' }],
    });
    expect(await new EngagementStore(kv).active()).toMatchObject({
      serviceId: 'mrv-plan',
      adminAddress: ADMIN,
      intentTxHash: 'TX1',
      request: 'Please design the MRV plan for my mangrove project.',
    });
  });

  it('start_work refuses a second job while one is open', async () => {
    await startWork(deps(), 'mrv-plan');
    expect(await startWork(deps(), 'mrv-plan')).toMatchObject({
      started: false,
      reason: 'engagement_in_progress',
    });
    expect(chain.sent).toHaveLength(1);
  });

  it('start_work reports a reservation the chain refused, and records nothing', async () => {
    chain.queue.push({
      code: 5,
      transactionHash: 'BAD',
      gasUsed: 0n,
      rawLog: 'insufficient funds',
    });
    expect(await startWork(deps(), 'mrv-plan')).toMatchObject({
      started: false,
      reason: 'insufficient_funds',
    });
    expect(await new EngagementStore(kv).active()).toBeNull();
  });

  it('deliver_work uploads, saves the six-field claim and submits it against the escrow', async () => {
    await startWork(deps(), 'mrv-plan');
    const res = await deliverWork(deps(), deliver);
    expect(res).toMatchObject({
      ok: true,
      claimId: 'bafkclaim1',
      txHash: 'TX2',
    });

    expect(state.savedClaims[0]).toMatchObject({
      service: 'mrv-plan',
      request: 'Please design the MRV plan for my mangrove project.',
      workSummary: 'Designed the MRV plan.',
      resultStatus: 'completed',
      deliverables: [{ name: 'mrv-plan-design.md', type: 'text/markdown' }],
    });
    const msg = inner(chain.sent[1]?.messages[0]);
    expect(msg.typeUrl).toBe('/ixo.claims.v1beta1.MsgSubmitClaim');
    expect(MsgSubmitClaim.decode(msg.value)).toMatchObject({
      adminAddress: ADMIN,
      agentAddress: ORACLE,
      claimId: 'bafkclaim1',
      collectionId: COLLECTION,
      useIntent: true,
      amount: [{ denom: 'upay', amount: '2000000000' }],
    });
    const bytes = new TextEncoder().encode(deliver.text).byteLength;
    expect(state.uploadSizes).toEqual([
      { declared: String(bytes), actual: bytes },
    ]);
    const store = new EngagementStore(kv);
    expect(await store.active()).toBeNull();
    expect(await store.lastSettled()).toMatchObject({
      outcome: 'delivered',
      claimId: 'bafkclaim1',
    });
  });

  it('a failed submit keeps the saved claim, and the retry re-submits it without re-uploading', async () => {
    await startWork(deps(), 'mrv-plan');
    chain.queue.push({
      code: 11,
      transactionHash: 'OOG',
      gasUsed: 0n,
      rawLog: 'out of gas',
    });
    expect(await deliverWork(deps(), deliver)).toMatchObject({
      ok: false,
      reason: 'claim_failed',
    });
    expect(await new EngagementStore(kv).active()).toMatchObject({
      claimId: 'bafkclaim1',
    });

    expect(await deliverWork(deps(), deliver)).toMatchObject({
      ok: true,
      claimId: 'bafkclaim1',
    });
    expect(state.uploads).toBe(1);
    expect(state.savedClaims).toHaveLength(1);
  });

  it('re-reserves once when the reservation lapsed before the claim landed', async () => {
    await startWork(deps(), 'mrv-plan');
    chain.queue.push(new Error('claim intent not found for agent'));
    expect(await deliverWork(deps(), deliver)).toMatchObject({ ok: true });
    expect(chain.sent.map((s) => inner(s.messages[0]).typeUrl)).toEqual([
      '/ixo.claims.v1beta1.MsgClaimIntent',
      '/ixo.claims.v1beta1.MsgSubmitClaim',
      '/ixo.claims.v1beta1.MsgClaimIntent',
      '/ixo.claims.v1beta1.MsgSubmitClaim',
    ]);
  });

  it('cancel_work releases the escrow with an "unable" claim that delivers nothing', async () => {
    await startWork(deps(), 'mrv-plan');
    expect(await cancelWork(deps(), 'changed my mind')).toMatchObject({
      ok: true,
    });
    const body = state.savedClaims[0];
    expect(body).toMatchObject({ resultStatus: 'unable', service: 'mrv-plan' });
    expect(body).not.toHaveProperty('deliverables');
    expect(state.uploads).toBe(0);
    expect(await new EngagementStore(kv).lastSettled()).toMatchObject({
      outcome: 'cancelled',
    });
  });

  it('the start_work tool runs on the validated config the runtime hands it', async () => {
    const ctx = buyerCtx({ chain, kv });
    const tool = supportTools({
      card: CARD,
      env: (c) => resolvePaymentsEnv(c.config),
    }).find((t) => t.name === 'start_work');
    expect(await tool?.handler({ serviceId: 'mrv-plan' }, ctx)).toMatch(
      /^Job started/,
    );
  });

  it('deliver_work without an open job does nothing on chain', async () => {
    expect(await deliverWork(deps(), deliver)).toMatchObject({
      ok: false,
      reason: 'no_engagement',
    });
    expect(chain.sent).toHaveLength(0);
  });
});

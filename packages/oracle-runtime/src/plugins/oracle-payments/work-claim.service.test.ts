import { AIMessage, HumanMessage } from '@langchain/core/messages';
import { describe, expect, it, vi, type Mock } from 'vitest';
import { z } from 'zod';
import { ORACLE_COMPONENT_EVENT_TYPE } from '../../matrix/oracle-component-event.js';
import type {
  CommerceEngagement,
  RuntimeContext,
} from '../../plugin-api/types.js';
import type { RoomFileSend } from '../../matrix/room-file.js';
import { ContractGateService } from './contract-gate.service.js';
import type { EngagementService } from './engagement.service.js';
import type {
  ClaimBotUploadInput,
  ClaimDeliverable,
  SignClaimInput,
  SubmitClaimInput,
  SubmitClaimResult,
} from './claim-lane.js';
import { MAINNET_USDC_IBC_DENOM } from './types.js';
import {
  WorkClaimService,
  type DeliverWorkArgs,
} from './work-claim.service.js';
import { WorkSummaryExtractor } from './work-summary-extractor.js';
import {
  COLLECTION_ID,
  componentContent,
  makeCommerceCtx,
  makeContractRecord,
  makeContractRecordService,
  makeEngagement,
  makeEngagementService,
  makeSandboxFactory,
  ORACLE_DID,
  ROOM_ID,
  THREAD_ID,
  type PostedEvent,
  type SandboxStubHandlers,
} from './__test-fixtures__/oracle-payments-fixtures.js';

const EXTRACTION = {
  request: 'Summarize my Q2 spending in USD.',
  workSummary: 'Categorized 5 receipts into a Q2 report with a grand total.',
};

const CLAIM_ENTRY = {
  name: 'tax-report.md',
  type: 'text/markdown',
  content: '{"type":"mediaAttachment","proof":"bafy-media"}',
};

const BASE_CONFIG = {
  NETWORK: 'devnet',
  SECP_MNEMONIC: 'secp mnemonic',
  MATRIX_ACCOUNT_ROOM_ID: '!oracle-account:ixo.world',
  MATRIX_VALUE_PIN: '1234',
  MATRIX_ORACLE_ADMIN_ACCESS_TOKEN: 'matrix-token',
  PORTAL_URL: 'https://portal.example',
  SANDBOX_MCP_URL: 'https://sandbox.test',
};

const TEXT_ARGS: DeliverWorkArgs = {
  description: 'Your Q2 expense report is ready.',
  resultStatus: 'completed',
  deliverable: { kind: 'text', text: '# Q2 report\n\nTotal: $1,234' },
  proofs: 'Receipts R-001 through R-005.',
};

interface Harness {
  service: WorkClaimService;
  extractor: WorkSummaryExtractor;
  engagement: EngagementService;
  posted: PostedEvent[];
  uploadToRoom: Mock<(input: RoomFileSend) => Promise<string>>;
  uploadToClaimBot: Mock<
    (input: ClaimBotUploadInput) => Promise<ClaimDeliverable>
  >;
  signAndSave: Mock<(input: SignClaimInput) => Promise<string>>;
  submit: Mock<(input: SubmitClaimInput) => Promise<SubmitClaimResult>>;
  emit: Mock<(...args: unknown[]) => void>;
  ctx: RuntimeContext;
}

interface HarnessOptions {
  engagement?: CommerceEngagement | null;
  /** `null` means "no contract record" — the gate then fails not_contracted. */
  contract?: ReturnType<typeof makeContractRecord> | null;
  config?: Record<string, unknown>;
  submitResult?: SubmitClaimResult;
  signingMnemonic?: string | null;
  sandbox?: SandboxStubHandlers;
  postEventFails?: boolean;
  abortSignal?: AbortSignal;
}

async function makeHarness(options: HarnessOptions = {}): Promise<Harness> {
  const engagement = makeEngagementService();
  const seed =
    options.engagement === undefined ? makeEngagement() : options.engagement;
  if (seed) {
    await engagement.start(ROOM_ID, THREAD_ID, seed);
    if (seed.claim) {
      await engagement.recordClaim(ROOM_ID, THREAD_ID, seed.claim);
    }
  }

  const contractGate = new ContractGateService({
    contractRecord: makeContractRecordService(
      options.contract === undefined ? makeContractRecord() : options.contract,
    ).service,
    engagement,
    engineUrl: 'https://engine.example',
    network: String(options.config?.NETWORK ?? BASE_CONFIG.NETWORK),
  });

  const extractor = new WorkSummaryExtractor({
    getModel: () => ({
      withStructuredOutput: () => ({ invoke: async () => EXTRACTION }),
    }),
  });

  const uploadToRoom = vi.fn(async (_input: RoomFileSend) => '$file-event');
  const uploadToClaimBot = vi.fn(
    async (_input: ClaimBotUploadInput) => CLAIM_ENTRY,
  );
  const signAndSave = vi.fn(async (_input: SignClaimInput) => 'claim-cid-1');
  const submit = vi.fn(
    async (_input: SubmitClaimInput): Promise<SubmitClaimResult> =>
      options.submitResult ?? { code: 0, transactionHash: 'TX-1' },
  );
  const emit = vi.fn();

  const posted: PostedEvent[] = [];
  const ctx = makeCommerceCtx({
    posted,
    config: { ...BASE_CONFIG, ...options.config },
    messages: [
      new HumanMessage('Summarize my Q2 spending in USD.'),
      new AIMessage('Done — the report is built.'),
    ],
    ...(options.abortSignal !== undefined && {
      abortSignal: options.abortSignal,
    }),
  });
  if (options.postEventFails) {
    ctx.matrix.postEvent = vi.fn(async () => {
      throw new Error('matrix down');
    });
  }

  const service = new WorkClaimService({
    engagement,
    contractGate,
    extractor,
    getSigningMnemonic: () =>
      options.signingMnemonic === undefined
        ? 'signing mnemonic'
        : options.signingMnemonic,
    uploadToRoom,
    uploadToClaimBot,
    chain: { signAndSave, submit },
    mcpClientFactory: makeSandboxFactory(options.sandbox ?? {}),
    statusProducer: { emit },
    clock: () => new Date('2026-07-22T13:00:00.000Z'),
    sleep: async () => {},
  });

  return {
    service,
    extractor,
    engagement,
    posted,
    uploadToRoom,
    uploadToClaimBot,
    signAndSave,
    submit,
    emit,
    ctx,
  };
}

const ClaimBodySchema = z.object({
  service: z.string(),
  request: z.string(),
  workSummary: z.string(),
  resultStatus: z.string(),
  deliverables: z.array(z.record(z.string(), z.unknown())),
  proofs: z.string().optional(),
});

describe('WorkClaimService — guards', () => {
  it('refuses to deliver when the thread has no active engagement', async () => {
    const h = await makeHarness({ engagement: null });
    await expect(h.service.deliver(TEXT_ARGS, h.ctx)).rejects.toThrow(
      /no active work engagement/i,
    );
    expect(h.signAndSave).not.toHaveBeenCalled();
  });

  it('refuses to deliver when the contract gate no longer passes', async () => {
    const h = await makeHarness({ contract: null });
    await expect(h.service.deliver(TEXT_ARGS, h.ctx)).rejects.toThrow(
      /contract check failed \(not_contracted\)/,
    );
    // The work is not lost: the engagement stays active and retryable.
    expect(await h.engagement.getActive(ROOM_ID, THREAD_ID)).not.toBeNull();
    expect(h.uploadToRoom).not.toHaveBeenCalled();
  });

  it('refuses to deliver before the oracle signing key is loaded', async () => {
    const h = await makeHarness({ signingMnemonic: null });
    await expect(h.service.deliver(TEXT_ARGS, h.ctx)).rejects.toThrow(
      /signing key is not loaded/i,
    );
  });

  it('refuses to deliver once the escrowed intent window has expired', async () => {
    // The reservation released before the work landed — claiming against it
    // would only fail settlement.
    const h = await makeHarness({
      engagement: makeEngagement({
        intent: {
          txHash: 'INTENT-TX-1',
          submittedAt: '2026-07-22T00:00:00.000Z',
          expiresAt: '2026-07-22T12:59:00.000Z',
        },
      }),
    });

    await expect(h.service.deliver(TEXT_ARGS, h.ctx)).rejects.toThrow(
      /expired at 2026-07-22T12:59:00.000Z/,
    );
    expect(h.signAndSave).not.toHaveBeenCalled();
    expect(h.submit).not.toHaveBeenCalled();
  });

  it('delivers normally while the intent window is still open', async () => {
    const h = await makeHarness({
      engagement: makeEngagement({
        intent: {
          txHash: 'INTENT-TX-1',
          submittedAt: '2026-07-22T00:00:00.000Z',
          expiresAt: '2026-07-29T00:00:00.000Z',
        },
      }),
    });

    await expect(h.service.deliver(TEXT_ARGS, h.ctx)).resolves.toMatchObject({
      delivered: true,
    });
  });

  it('still reports an already-submitted claim after the window expired', async () => {
    // Idempotency wins over expiry: the claim is already on-chain.
    const h = await makeHarness({
      engagement: makeEngagement({
        intent: {
          txHash: 'INTENT-TX-1',
          submittedAt: '2026-07-22T00:00:00.000Z',
          expiresAt: '2026-07-22T12:59:00.000Z',
        },
        claim: {
          cid: 'claim-cid-1',
          txHash: 'TX-1',
          submittedAt: '2026-07-22T12:30:00.000Z',
        },
      }),
    });

    await expect(h.service.deliver(TEXT_ARGS, h.ctx)).resolves.toMatchObject({
      claimId: 'claim-cid-1',
      txHash: 'TX-1',
      note: expect.stringContaining('already delivered'),
    });
    expect(h.submit).not.toHaveBeenCalled();
  });
});

describe('WorkClaimService — text deliverable', () => {
  it('materializes markdown, submits the claim, and closes out', async () => {
    const h = await makeHarness();
    const result = await h.service.deliver(TEXT_ARGS, h.ctx);

    expect(result).toEqual({
      claimId: 'claim-cid-1',
      txHash: 'TX-1',
      delivered: true,
    });

    // The status card flips to "delivering" before the long work starts.
    expect(h.emit).toHaveBeenCalledWith('req-9', 'delivering');

    // The user's copy lands in the thread as a real file.
    const upload = h.uploadToRoom.mock.calls[0]![0];
    expect(upload.roomId).toBe(ROOM_ID);
    expect(upload.threadId).toBe(THREAD_ID);
    expect(upload.fileName).toBe('tax-report.md');
    expect(upload.mediaType).toBe('text/markdown');
    expect(upload.bytes.toString('utf8')).toBe(TEXT_ARGS.deliverable.text);

    // The claim copy goes to the claim-bot media lane for the same bytes.
    expect(h.uploadToClaimBot).toHaveBeenCalledWith(
      expect.objectContaining({
        collectionId: COLLECTION_ID,
        fileName: 'tax-report.md',
        oracleDid: ORACLE_DID,
        signingMnemonic: 'signing mnemonic',
        network: 'devnet',
      }),
    );

    // Engagement closed out; the claim cid + tx are recorded on it.
    const closed = await h.engagement.get(ROOM_ID, THREAD_ID);
    expect(closed).toMatchObject({
      status: 'delivered',
      claim: { cid: 'claim-cid-1', txHash: 'TX-1' },
    });
  });

  it('signs exactly the platform claim body — no transcript, no chat pointers', async () => {
    const h = await makeHarness();
    await h.service.deliver(TEXT_ARGS, h.ctx);

    const signed = h.signAndSave.mock.calls[0]![0];
    const body = ClaimBodySchema.parse(signed.body);
    expect(Object.keys(body)).toEqual([
      'service',
      'request',
      'workSummary',
      'resultStatus',
      'deliverables',
      'proofs',
    ]);
    expect(body.service).toBe('tax-report');
    // request/workSummary come from the extractor, never from the tool args.
    expect(body.request).toBe(EXTRACTION.request);
    expect(body.workSummary).toBe(EXTRACTION.workSummary);
    expect(body.resultStatus).toBe('completed');
    expect(body.deliverables).toEqual([CLAIM_ENTRY]);

    expect(signed.collectionId).toBe(COLLECTION_ID);
    expect(signed.matrixRoomId).toBe(BASE_CONFIG.MATRIX_ACCOUNT_ROOM_ID);
    expect(signed.decryptedSigningMnemonic).toBe('signing mnemonic');
  });

  it('omits proofs from the body when the agent supplied none', async () => {
    const h = await makeHarness();
    const { proofs: _proofs, ...withoutProofs } = TEXT_ARGS;
    await h.service.deliver(withoutProofs, h.ctx);
    const body = ClaimBodySchema.parse(h.signAndSave.mock.calls[0]![0].body);
    expect(body.proofs).toBeUndefined();
  });

  it('prices the claim in micro-units of the network denom', async () => {
    const h = await makeHarness();
    await h.service.deliver(TEXT_ARGS, h.ctx);
    const expected = [{ denom: 'uixo', amount: '20000000' }];
    expect(h.signAndSave.mock.calls[0]![0].amount).toEqual(expected);
    expect(h.submit.mock.calls[0]![0]).toMatchObject({
      claimId: 'claim-cid-1',
      collectionId: COLLECTION_ID,
      amount: expected,
    });
  });

  it('uses the USDC IBC denom on mainnet', async () => {
    const h = await makeHarness({
      config: { NETWORK: 'mainnet' },
      // The grant on mainnet is denominated in the same USDC IBC denom.
      contract: makeContractRecord({
        authz: {
          ...makeContractRecord().authz,
          maxAmount: { amount: '20000000', denom: MAINNET_USDC_IBC_DENOM },
        },
      }),
    });
    await h.service.deliver(TEXT_ARGS, h.ctx);
    expect(h.submit.mock.calls[0]![0].amount).toEqual([
      { denom: MAINNET_USDC_IBC_DENOM, amount: '20000000' },
    ]);
  });

  it('always settles against the escrow locked at engagement start', async () => {
    // Unconditional: nothing can decouple the submit from that reservation —
    // a plain submit would strand the escrow it was never told about.
    const h = await makeHarness();
    await h.service.deliver(TEXT_ARGS, h.ctx);
    expect(h.submit.mock.calls[0]![0].useIntent).toBe(true);
  });

  it('rejects an empty text deliverable', async () => {
    const h = await makeHarness();
    await expect(
      h.service.deliver(
        { ...TEXT_ARGS, deliverable: { kind: 'text', text: '   ' } },
        h.ctx,
      ),
    ).rejects.toThrow(/deliverable.text is required/);
  });

  it('rejects a deliverable over the configured size ceiling', async () => {
    const h = await makeHarness({
      config: { ORACLE_PAYMENTS_MAX_DELIVERABLE_MB: 1 },
    });
    await expect(
      h.service.deliver(
        {
          ...TEXT_ARGS,
          deliverable: { kind: 'text', text: 'x'.repeat(2 * 1024 * 1024) },
        },
        h.ctx,
      ),
    ).rejects.toThrow(/over the 1 MB limit/);
    expect(h.signAndSave).not.toHaveBeenCalled();
  });
});

describe('WorkClaimService — file deliverable', () => {
  const fileArgs: DeliverWorkArgs = {
    description: 'Report attached.',
    resultStatus: 'completed',
    deliverable: {
      kind: 'file',
      sandboxPath: '/workspace/data/output/q2.csv',
    },
  };

  it('reads the bytes out of the sandbox and names the file from the path', async () => {
    const h = await makeHarness({
      sandbox: {
        run: async () =>
          JSON.stringify({
            success: true,
            exitCode: 0,
            output: Buffer.from('a,b\n1,2').toString('base64'),
          }),
      },
    });

    await h.service.deliver(fileArgs, h.ctx);

    const upload = h.uploadToRoom.mock.calls[0]![0];
    expect(upload.fileName).toBe('q2.csv');
    expect(upload.mediaType).toBe('text/csv');
    expect(upload.bytes.toString('utf8')).toBe('a,b\n1,2');
  });

  it('refuses a path outside /workspace/data/', async () => {
    const h = await makeHarness();
    await expect(
      h.service.deliver(
        {
          ...fileArgs,
          deliverable: { kind: 'file', sandboxPath: '/etc/passwd' },
        },
        h.ctx,
      ),
    ).rejects.toThrow(/must live under \/workspace\/data\//);
    expect(h.signAndSave).not.toHaveBeenCalled();
  });

  it('surfaces a missing sandbox file as a retryable tool error', async () => {
    const h = await makeHarness({
      sandbox: { run: async () => '__SANDBOX_NOFILE__\n' },
    });
    await expect(h.service.deliver(fileArgs, h.ctx)).rejects.toThrow(
      /No file at/,
    );
    expect(await h.engagement.getActive(ROOM_ID, THREAD_ID)).not.toBeNull();
  });
});

describe('WorkClaimService — failure and idempotency lanes', () => {
  it('surfaces the chain rawLog and leaves the signed cid for a resume', async () => {
    const h = await makeHarness({
      submitResult: { code: 5, transactionHash: '', rawLog: 'out of quota' },
    });

    await expect(h.service.deliver(TEXT_ARGS, h.ctx)).rejects.toThrow(
      /out of quota/,
    );

    const engagement = await h.engagement.get(ROOM_ID, THREAD_ID);
    expect(engagement).toMatchObject({
      status: 'active',
      claim: { cid: 'claim-cid-1' },
    });
    expect(engagement?.claim?.txHash).toBeUndefined();
  });

  it('resumes at submission when a claim was already signed', async () => {
    const h = await makeHarness({
      engagement: makeEngagement({
        claim: { cid: 'claim-cid-1', submittedAt: '2026-07-22T12:59:00.000Z' },
      }),
    });

    const result = await h.service.deliver(TEXT_ARGS, h.ctx);

    expect(result.claimId).toBe('claim-cid-1');
    // Never re-signs, never re-uploads.
    expect(h.signAndSave).not.toHaveBeenCalled();
    expect(h.uploadToRoom).not.toHaveBeenCalled();
    expect(h.uploadToClaimBot).not.toHaveBeenCalled();
    expect(h.submit).toHaveBeenCalledTimes(1);
  });

  it('short-circuits without resubmitting an already-submitted claim', async () => {
    const h = await makeHarness({
      engagement: makeEngagement({
        claim: {
          cid: 'claim-cid-1',
          txHash: 'TX-OLD',
          submittedAt: '2026-07-22T12:59:00.000Z',
        },
      }),
    });

    const result = await h.service.deliver(TEXT_ARGS, h.ctx);

    expect(result).toMatchObject({ claimId: 'claim-cid-1', txHash: 'TX-OLD' });
    expect(result.note).toMatch(/already delivered/i);
    expect(h.submit).not.toHaveBeenCalled();
    expect(h.signAndSave).not.toHaveBeenCalled();
  });

  it('stops before signing when the turn was already aborted', async () => {
    const controller = new AbortController();
    controller.abort();
    const h = await makeHarness({ abortSignal: controller.signal });

    await expect(h.service.deliver(TEXT_ARGS, h.ctx)).rejects.toThrow(
      /interrupted before the payment record was signed/,
    );
    expect(h.signAndSave).not.toHaveBeenCalled();
    expect(h.submit).not.toHaveBeenCalled();
  });

  it('never submits a claim the extractor could not summarize', async () => {
    const h = await makeHarness();
    const failing = new WorkClaimService({
      engagement: h.engagement,
      contractGate: new ContractGateService({
        contractRecord: makeContractRecordService(makeContractRecord()).service,
        engagement: h.engagement,
        engineUrl: 'https://engine.example',
        network: 'devnet',
      }),
      extractor: new WorkSummaryExtractor({
        getModel: () => ({
          withStructuredOutput: () => ({
            invoke: async () => {
              throw new Error('extractor offline');
            },
          }),
        }),
      }),
      getSigningMnemonic: () => 'signing mnemonic',
      uploadToRoom: h.uploadToRoom,
      uploadToClaimBot: h.uploadToClaimBot,
      chain: { signAndSave: h.signAndSave, submit: h.submit },
      statusProducer: { emit: h.emit },
    });

    await expect(failing.deliver(TEXT_ARGS, h.ctx)).rejects.toThrow(
      /extractor offline/,
    );
    expect(h.signAndSave).not.toHaveBeenCalled();
  });

  it('still reports the claim when the receipt card fails to post', async () => {
    const h = await makeHarness({ postEventFails: true });
    const result = await h.service.deliver(TEXT_ARGS, h.ctx);
    expect(result.claimId).toBe('claim-cid-1');
    expect(await h.engagement.get(ROOM_ID, THREAD_ID)).toMatchObject({
      status: 'delivered',
    });
  });
});

describe('WorkClaimService — receipt card', () => {
  it('posts work_delivered in-thread with the cost, claim ids, and deep link', async () => {
    const h = await makeHarness();
    await h.service.deliver(TEXT_ARGS, h.ctx);

    expect(h.posted).toHaveLength(1);
    expect(h.posted[0]?.eventType).toBe(ORACLE_COMPONENT_EVENT_TYPE);
    const content = componentContent(h.posted[0]!);
    expect(content.component).toBe('work_delivered');
    expect(content['m.relates_to']).toEqual({
      rel_type: 'm.thread',
      event_id: THREAD_ID,
    });
    expect(content.props).toMatchObject({
      service: {
        id: 'tax-report',
        name: 'Tax report',
        price: { amount: 20, currency: 'USDC' },
      },
      description: TEXT_ARGS.description,
      resultStatus: 'completed',
      deliverable: {
        fileName: 'tax-report.md',
        mediaType: 'text/markdown',
        matrixEventId: '$file-event',
      },
      claimId: 'claim-cid-1',
      txHash: 'TX-1',
      workSummary: EXTRACTION.workSummary,
      claimUrl: 'https://portal.example/workspace/claims?claimId=claim-cid-1',
    });
    expect(content.body).toContain('Tax report');
  });

  it('omits the claim deep link when PORTAL_URL is unset', async () => {
    const h = await makeHarness({ config: { PORTAL_URL: undefined } });
    await h.service.deliver(TEXT_ARGS, h.ctx);
    const content = componentContent(h.posted[0]!);
    expect(content.props.claimUrl).toBeUndefined();
  });
});

const INTENT = {
  txHash: 'INTENT-TX-1',
  submittedAt: '2026-07-22T12:00:00.000Z',
  expiresAt: '2026-07-29T12:00:00.000Z',
};

const ReleaseBodySchema = z.object({
  service: z.string(),
  request: z.string(),
  workSummary: z.string(),
  resultStatus: z.string(),
  deliverables: z.unknown().optional(),
  proofs: z.string().optional(),
});

/** A harness whose engagement carries the escrow a release has to free. */
function makeReleaseHarness(
  overrides: Partial<CommerceEngagement> = {},
  options: HarnessOptions = {},
): Promise<Harness> {
  return makeHarness({
    engagement: makeEngagement({ intent: INTENT, ...overrides }),
    ...options,
  });
}

describe('WorkClaimService — release lane (cancel_work)', () => {
  it('signs an honest release claim: unable, no deliverables, reason as proofs', async () => {
    const h = await makeReleaseHarness();
    const extract = vi.spyOn(h.extractor, 'extract');

    await h.service.release({ reason: 'found an accountant' }, h.ctx);

    expect(h.signAndSave).toHaveBeenCalledTimes(1);
    const body = ReleaseBodySchema.parse(h.signAndSave.mock.calls[0]?.[0].body);
    expect(body.service).toBe('tax-report');
    expect(body.resultStatus).toBe('unable');
    // The unanswered deliverables question is what makes the evaluator reject
    // the claim and hand the escrow back.
    expect(body.deliverables).toBeUndefined();
    expect(body.proofs).toContain('found an accountant');
    expect(body.request).toContain('cancelled');
    expect(body.workSummary).toContain('No work was completed');
    expect(body.workSummary).toContain('found an accountant');
    // No delivered work to summarize — a model call would only invent one.
    expect(extract).not.toHaveBeenCalled();
    // Never handed to the user, never uploaded for the claim.
    expect(h.uploadToRoom).not.toHaveBeenCalled();
    expect(h.uploadToClaimBot).not.toHaveBeenCalled();
  });

  it('omits proofs and says so in the summary when no reason was given', async () => {
    const h = await makeReleaseHarness();
    await h.service.release({}, h.ctx);

    const body = ReleaseBodySchema.parse(h.signAndSave.mock.calls[0]?.[0].body);
    expect(body.proofs).toBeUndefined();
    expect(body.workSummary).toContain('gave no reason');
  });

  it('submits against the reservation with useIntent and the engagement price', async () => {
    const h = await makeReleaseHarness();
    const result = await h.service.release(
      { reason: 'no longer needed' },
      h.ctx,
    );

    expect(h.submit).toHaveBeenCalledTimes(1);
    expect(h.submit.mock.calls[0]?.[0]).toEqual({
      claimId: 'claim-cid-1',
      collectionId: COLLECTION_ID,
      useIntent: true,
      amount: [{ denom: 'uixo', amount: '20000000' }],
    });
    expect(h.signAndSave.mock.calls[0]?.[0].amount).toEqual([
      { denom: 'uixo', amount: '20000000' },
    ]);
    expect(result).toMatchObject({
      cancelled: true,
      serviceId: 'tax-report',
      serviceName: 'Tax report',
      claimId: 'claim-cid-1',
      txHash: 'TX-1',
    });
  });

  it('persists the signed cid before the chain submit', async () => {
    const h = await makeReleaseHarness();
    let atSubmit: CommerceEngagement | null = null;
    h.submit.mockImplementation(async () => {
      atSubmit = await h.engagement.get(ROOM_ID, THREAD_ID);
      return { code: 0, transactionHash: 'TX-1' };
    });

    await h.service.release({}, h.ctx);

    expect(atSubmit).toMatchObject({ claim: { cid: 'claim-cid-1' } });
  });

  it('resumes at submission on a repeat call instead of re-signing', async () => {
    const h = await makeReleaseHarness();
    h.submit.mockRejectedValueOnce(new Error('node unreachable'));
    h.submit.mockRejectedValueOnce(new Error('node unreachable'));
    h.submit.mockRejectedValueOnce(new Error('node unreachable'));

    await expect(h.service.release({ reason: 'stop' }, h.ctx)).rejects.toThrow(
      /could not be submitted on-chain/,
    );
    expect(h.signAndSave).toHaveBeenCalledTimes(1);

    h.submit.mockResolvedValue({ code: 0, transactionHash: 'TX-2' });
    const result = await h.service.release({ reason: 'stop' }, h.ctx);

    expect(result).toMatchObject({ cancelled: true, txHash: 'TX-2' });
    // The second call signed nothing: it picked up the persisted cid.
    expect(h.signAndSave).toHaveBeenCalledTimes(1);
    expect(h.submit.mock.calls.at(-1)?.[0].claimId).toBe('claim-cid-1');
  });

  it('closes the engagement so the gate stops blocking new work', async () => {
    const h = await makeReleaseHarness();
    await h.service.release({ reason: 'changed my mind' }, h.ctx);

    expect(await h.engagement.getActive(ROOM_ID, THREAD_ID)).toBeNull();
    expect(await h.engagement.findActive(ROOM_ID)).toBeNull();
    expect(await h.engagement.get(ROOM_ID, THREAD_ID)).toMatchObject({
      status: 'closed',
      cancelReason: 'changed my mind',
      cancelledAt: '2026-07-22T12:00:00.000Z',
      claim: { cid: 'claim-cid-1', txHash: 'TX-1' },
    });
  });

  it('promises a fresh start and never a lockout on the success path', async () => {
    const h = await makeReleaseHarness();
    const result = await h.service.release({}, h.ctx);

    expect(result.note).toContain('releases the payment reserved');
    expect(result.note).toContain('start a new paid job right now');
    // The pre-release wording is gone: nothing stays locked until expiry.
    expect(result.note).not.toMatch(/cannot be cancelled/i);
    expect(result.note).not.toMatch(/CANNOT start another paid job/);
    expect(result.note).not.toContain(INTENT.expiresAt);
  });

  it('keeps a failed release blocking, retryable, and flagged for the gate', async () => {
    const h = await makeReleaseHarness();
    h.submit.mockResolvedValue({
      code: 5,
      transactionHash: '',
      rawLog: 'intent already settled',
    });

    await expect(h.service.release({ reason: 'stop' }, h.ctx)).rejects.toThrow(
      /intent already settled/,
    );

    // Still the room's live job: the reservation really is still held.
    const blocking = await h.engagement.findActive(ROOM_ID);
    expect(blocking?.threadId).toBe(THREAD_ID);
    expect(blocking?.engagement).toMatchObject({
      status: 'active',
      cancelledAt: '2026-07-22T12:00:00.000Z',
      cancelReason: 'stop',
      claim: { cid: 'claim-cid-1' },
    });
    expect(blocking?.engagement.claim?.txHash).toBeUndefined();
  });

  it('tells the model the reservation is still held when the release fails', async () => {
    const h = await makeReleaseHarness();
    h.submit.mockRejectedValue(new Error('node unreachable'));

    await expect(h.service.release({}, h.ctx)).rejects.toThrow(
      /still held on-chain[\s\S]*cancel_work again/,
    );
  });

  it('rides out a transport blip on each chain write', async () => {
    const h = await makeReleaseHarness();
    h.signAndSave.mockRejectedValueOnce(new Error('matrix blip'));
    h.submit.mockRejectedValueOnce(new Error('rpc blip'));

    const result = await h.service.release({}, h.ctx);

    expect(result).toMatchObject({ cancelled: true, txHash: 'TX-1' });
    expect(h.signAndSave).toHaveBeenCalledTimes(2);
    expect(h.submit).toHaveBeenCalledTimes(2);
  });

  it('refuses to sign without the oracle signing key and stays blocking', async () => {
    const h = await makeReleaseHarness({}, { signingMnemonic: null });

    await expect(h.service.release({}, h.ctx)).rejects.toThrow(
      /signing key is not loaded/,
    );
    expect(h.signAndSave).not.toHaveBeenCalled();
    expect((await h.engagement.findActive(ROOM_ID))?.threadId).toBe(THREAD_ID);
  });

  it('just closes an engagement that never reserved anything', async () => {
    const h = await makeHarness();
    const result = await h.service.release({ reason: 'never mind' }, h.ctx);

    expect(result).toMatchObject({ cancelled: true, note: expect.any(String) });
    expect(result.note).toContain('No payment was reserved');
    expect(h.signAndSave).not.toHaveBeenCalled();
    expect(h.submit).not.toHaveBeenCalled();
    expect(await h.engagement.getActive(ROOM_ID, THREAD_ID)).toBeNull();
  });

  it('closes without resubmitting when a claim is already on-chain', async () => {
    const h = await makeReleaseHarness({
      claim: {
        cid: 'claim-cid-1',
        txHash: 'TX-OLD',
        submittedAt: '2026-07-22T12:59:00.000Z',
      },
    });

    const result = await h.service.release({}, h.ctx);

    expect(result).toMatchObject({ cancelled: true, txHash: 'TX-OLD' });
    expect(result.note).toContain('already released');
    expect(h.signAndSave).not.toHaveBeenCalled();
    expect(h.submit).not.toHaveBeenCalled();
    expect(await h.engagement.get(ROOM_ID, THREAD_ID)).toMatchObject({
      status: 'closed',
    });
  });

  it('closes without a claim when the reservation already expired', async () => {
    // Nothing is held any more: a claim against a lapsed intent would only be
    // rejected, and the engagement would go on blocking for no reason.
    const h = await makeReleaseHarness({
      intent: { ...INTENT, expiresAt: '2026-07-22T12:59:00.000Z' },
    });

    const result = await h.service.release({}, h.ctx);

    expect(result).toMatchObject({ cancelled: true });
    expect(result.note).toContain(
      'already expired at 2026-07-22T12:59:00.000Z',
    );
    expect(result.note).toContain('start a new paid job right now');
    expect(h.signAndSave).not.toHaveBeenCalled();
    expect(h.submit).not.toHaveBeenCalled();
    expect(await h.engagement.findActive(ROOM_ID)).toBeNull();
  });

  it('reports nothing to cancel when the thread has no active engagement', async () => {
    const h = await makeHarness({ engagement: null });
    const result = await h.service.release({}, h.ctx);

    expect(result).toMatchObject({ cancelled: false });
    expect(h.signAndSave).not.toHaveBeenCalled();
    expect(h.submit).not.toHaveBeenCalled();
  });
});

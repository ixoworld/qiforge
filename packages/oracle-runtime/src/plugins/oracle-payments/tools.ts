import { z } from 'zod';
import { buildGateFailureInstruction } from '../../graph/commerce-overlay.js';
import { postOracleComponent } from '../../matrix/oracle-component-event.js';
import { tool } from '../../plugin-api/tool-helper.js';
import type {
  CommerceGateFailureReason,
  CommerceInProgressEngagement,
  PluginTool,
  RuntimeContext,
} from '../../plugin-api/types.js';
import type { CommerceRoutedService } from '../../modules/messages/commerce-router-port.js';
import type {
  AgentCardLookup,
  AgentCardService,
} from './agent-card.service.js';
import type { ContractGateService } from './contract-gate.service.js';
import type { ContractRecordService } from './contract-record.service.js';
import type { ThreadAttachmentService } from './thread-attachments.service.js';
import type { WorkIntentService } from './work-intent.service.js';
import {
  cancelWorkSchema,
  deliverWorkSchema,
  type WorkClaimService,
} from './work-claim.service.js';
import {
  DEFAULT_CURRENCY,
  oracleAddressFromDid,
  readConfigString,
  resolveEvalEngineUrl,
  summarizeServices,
  toContractServiceProp,
  toListServiceProp,
  toRoutedService,
} from './util.js';

export interface OraclePaymentsToolDeps {
  agentCard: AgentCardService;
  contractRecord: ContractRecordService;
  threadAttachments: ThreadAttachmentService;
}

/** What `start_work` needs to gate and open an engagement itself. */
export interface StartWorkToolDeps {
  agentCard: AgentCardService;
  contractGate: ContractGateService;
  workIntent: WorkIntentService;
}

const noArgsSchema = z.object({});
const showContractSchema = z.object({
  serviceId: z.string().describe('The id of the service to contract.'),
});
const startWorkSchema = z.object({
  serviceId: z
    .string()
    .describe(
      'Id of the published service to start, exactly as `list_services` reports it.',
    ),
});

/**
 * The oracle's Matrix thread root doubles as the session id; a component event
 * posts in-thread only when the turn is threaded (the Matrix transport).
 */
function threadIdFor(ctx: RuntimeContext): string | undefined {
  return ctx.session.client === 'matrix' ? ctx.session.id : undefined;
}

/**
 * This oracle's own card, with the reason when it does not resolve. An
 * unconfigured `ORACLE_ENTITY_DID` is a deployment fault rather than an empty
 * catalogue, so it reports as an error like every other one: three tools read
 * the card and all three would otherwise tell the user this oracle sells
 * nothing whenever it simply could not look.
 */
async function resolveCard(
  deps: Pick<OraclePaymentsToolDeps, 'agentCard'>,
  ctx: RuntimeContext,
): Promise<AgentCardLookup> {
  const entityDid = readConfigString(ctx.config, 'ORACLE_ENTITY_DID');
  if (!entityDid) {
    return {
      card: null,
      error:
        'this oracle has no ORACLE_ENTITY_DID configured, so it cannot look up its own published services',
    };
  }
  return deps.agentCard.getCard(entityDid);
}

const LIST_SERVICES_DESCRIPTION =
  "Show the user this oracle's published, contractable services as an " +
  'interactive card in the chat, and return the same list so your reply is ' +
  'grounded. Use when the user asks what you can do for them, what you offer, ' +
  'or about pricing.';

const SHOW_CONTRACT_DESCRIPTION =
  'Post an interactive contract card for one service so the user can contract ' +
  'this oracle from the chat. Call with the service id the user wants to ' +
  'start. Wrap up in prose afterwards — the card carries the action.';

const GET_CONTRACT_STATUS_DESCRIPTION =
  'Check whether the current user has contracted this oracle and how much of ' +
  'their quota remains. Use to answer "am I contracted?", "how many runs do I ' +
  'have left?", or before promising work.';

function createListServicesTool(deps: OraclePaymentsToolDeps): PluginTool {
  return tool(
    async (_args, ctx: RuntimeContext) => {
      const { card, error } = await resolveCard(deps, ctx);
      if (error !== undefined) {
        return {
          error,
          note:
            'The service catalogue could not be loaded, which is not the same as this oracle having ' +
            'nothing to sell. Tell the user you could not load your services right now and why, and ' +
            'offer to try again in a moment. Do not describe services from memory.',
        };
      }
      if (!card || card.services.length === 0) {
        return 'This oracle has no published services.';
      }

      const roomId = ctx.session.roomId;
      if (roomId) {
        await postOracleComponent(ctx.matrix, roomId, {
          component: 'list_services',
          props: {
            oracleEntityDid: card.oracleEntityDid,
            services: card.services.map(toListServiceProp),
          },
          body: summarizeServices(card.services),
          sessionId: ctx.session.id,
          requestId: ctx.session.requestId,
          toolCallId: ctx.toolCallId,
          threadId: threadIdFor(ctx),
        });
      }

      return { services: card.services };
    },
    {
      name: 'list_services',
      description: LIST_SERVICES_DESCRIPTION,
      schema: noArgsSchema,
    },
  );
}

function createShowContractTool(deps: OraclePaymentsToolDeps): PluginTool {
  return tool(
    async (rawArgs, ctx: RuntimeContext) => {
      const { serviceId } = showContractSchema.parse(rawArgs);
      const { card, error } = await resolveCard(deps, ctx);
      if (error !== undefined) {
        throw new Error(
          `The contract card for "${serviceId}" cannot be posted because ${error}. This is not a ` +
            'problem with the service id — tell the user you could not load the contract details ' +
            'right now, say why, and offer to try again shortly.',
        );
      }
      const service = card?.services.find((s) => s.id === serviceId);
      if (!card || !service) {
        const validIds = card?.services.map((s) => s.id) ?? [];
        throw new Error(
          `Unknown serviceId "${serviceId}". Valid service ids: ${
            validIds.join(', ') || '(none)'
          }.`,
        );
      }

      const roomId = ctx.session.roomId;
      if (!roomId) {
        return 'No active Matrix room to post the contract card into.';
      }

      const oracleDid = readConfigString(ctx.config, 'ORACLE_DID');
      const oracleAddress = oracleDid ? oracleAddressFromDid(oracleDid) : '';
      const currency = service.price.currency ?? DEFAULT_CURRENCY;

      // When the router's contract gate failed this turn, the card carries
      // the real failure reason; a plain user-initiated ask stays 'user_asked'.
      const reason = ctx.commerce?.gate?.reason ?? 'user_asked';

      await postOracleComponent(ctx.matrix, roomId, {
        component: 'show_contract',
        props: {
          oracleEntityDid: card.oracleEntityDid,
          oracleAddress,
          service: toContractServiceProp(service),
          reason,
        },
        body: `To start this work, contract the agent: ${service.name} — ${service.price.amount} ${currency}.`,
        sessionId: ctx.session.id,
        requestId: ctx.session.requestId,
        toolCallId: ctx.toolCallId,
        threadId: threadIdFor(ctx),
      });

      return { posted: true };
    },
    {
      name: 'show_contract',
      description: SHOW_CONTRACT_DESCRIPTION,
      schema: showContractSchema,
    },
  );
}

function createGetContractStatusTool(deps: OraclePaymentsToolDeps): PluginTool {
  return tool(
    async (_args, ctx: RuntimeContext) => {
      const engineUrl = resolveEvalEngineUrl(
        readConfigString(ctx.config, 'EVAL_ENGINE_URL'),
        readConfigString(ctx.config, 'NETWORK'),
      );
      const { record, error } = await deps.contractRecord.lookup({
        engineUrl,
        subscriberDid: ctx.user.did,
      });
      // A check that could not run is not an answer. Reporting `contracted:
      // false` here tells a paying user they never contracted — the one
      // wrong answer this tool can give.
      if (error !== undefined) {
        ctx.logger.warn(
          `[oracle-payments] contract status unknown for ${ctx.user.did} (engine ${engineUrl}): ${error}`,
        );
        return {
          error,
          note:
            'Their contract status could not be checked, so it is unknown — not absent. Do not tell ' +
            'the user they are uncontracted and do not call show_contract on the strength of this. ' +
            'Say the check could not be completed and why, and offer to try again in a moment.',
        };
      }
      if (!record) {
        ctx.logger.debug?.(
          `[oracle-payments] no contract record for ${ctx.user.did} (engine ${engineUrl}) — reporting uncontracted`,
        );
        return { contracted: false };
      }
      return {
        contracted: record.authz.granted,
        status: record.status,
        serviceIds: record.serviceIds,
        quotaRemaining: record.authz.agentQuotaRemaining,
        maxAmount: record.authz.maxAmount,
      };
    },
    {
      name: 'get_contract_status',
      description: GET_CONTRACT_STATUS_DESCRIPTION,
      schema: noArgsSchema,
    },
  );
}

const CANCEL_WORK_DESCRIPTION =
  "Cancel this thread's active work engagement at the user's request. Call " +
  'when the user asks to cancel or abandon the work — never silently stop ' +
  'working. It closes the job and releases the payment reserved for it, so the ' +
  'user is free to start something else. Confirm the closure to the user in ' +
  'prose afterwards.';

function createCancelWorkTool(deps: {
  workClaim: WorkClaimService;
}): PluginTool {
  return tool(
    async (rawArgs, ctx: RuntimeContext) => {
      const args = cancelWorkSchema.parse(rawArgs);
      return deps.workClaim.release(args, ctx);
    },
    {
      name: 'cancel_work',
      description: CANCEL_WORK_DESCRIPTION,
      schema: cancelWorkSchema,
    },
  );
}

const DELIVER_WORK_DESCRIPTION =
  'Hand the finished work to the user and close out this engagement. Call it ' +
  'exactly once, when the deliverable is actually ready: it puts the file in ' +
  'the chat and records the work for payment. Report the outcome honestly — ' +
  'use "partial" or "unable" when that is the truth.';

function createDeliverWorkTool(deps: {
  workClaim: WorkClaimService;
}): PluginTool {
  return tool(
    async (rawArgs, ctx: RuntimeContext) => {
      const args = deliverWorkSchema.parse(rawArgs);
      return deps.workClaim.deliver(args, ctx);
    },
    {
      name: 'deliver_work',
      description: DELIVER_WORK_DESCRIPTION,
      schema: deliverWorkSchema,
    },
  );
}

const GET_THREAD_ATTACHMENT_DESCRIPTION =
  'List the files the user shared in THIS conversation thread, with the ' +
  'sandbox path each was archived to under /workspace/output/ — read them ' +
  'there with the sandbox tools, nothing needs downloading. Use it whenever ' +
  'you need a file the user sent in an earlier message. Archiving is ' +
  'best-effort: if a listed path will not read, ask the user to send it again.';

function createGetThreadAttachmentTool(deps: {
  threadAttachments: ThreadAttachmentService;
}): PluginTool {
  return tool(
    async (_args, ctx: RuntimeContext) => deps.threadAttachments.list(ctx),
    {
      name: 'get_thread_attachment',
      description: GET_THREAD_ATTACHMENT_DESCRIPTION,
      schema: noArgsSchema,
    },
  );
}

const START_WORK_DESCRIPTION =
  "Start a paid job for one of this oracle's services — the only way work " +
  'begins. Call it once the user has decided they want a specific service ' +
  'performed. It verifies their contract and reserves the payment on-chain ' +
  'before anything starts, and refuses with a reason when it cannot. Your work ' +
  "tools bind on the user's NEXT message, so never do any of the work in the " +
  'same reply — confirm the job is open and ask for what you need to begin.';

/**
 * A refusal the model can relay verbatim, worded exactly like the router's.
 * `detail` is the part that says what actually happened — the chain's
 * rejection, the engine's status, the quota that ran out — and it is returned
 * as its own field as well as folded into `message`, so a model that reads
 * only the structured result still has something true to tell the user.
 */
function refuseStart(
  reason: CommerceGateFailureReason,
  service: CommerceRoutedService,
  failure: {
    detail?: string;
    inProgress?: CommerceInProgressEngagement;
  } = {},
): Record<string, unknown> {
  const { detail, inProgress } = failure;
  return {
    started: false,
    reason,
    serviceId: service.id,
    serviceName: service.name,
    ...(detail !== undefined && { detail }),
    message: buildGateFailureInstruction({
      reason,
      serviceId: service.id,
      serviceName: service.name,
      ...(detail !== undefined && { detail }),
      ...(inProgress !== undefined && { inProgress }),
    }),
  };
}

/**
 * The explicit, gated route from support mode into work mode.
 *
 * Support mode answers questions and never works, so entering work has to be a
 * deliberate act rather than something inferred from phrasing. This tool runs
 * the SAME contract gate and the SAME escrow-first engagement start the router
 * runs (`ContractGateService.check` → `WorkIntentService.startEngagement`), so
 * there is exactly one way a job opens and one set of refusal reasons.
 *
 * Sequencing: the engagement is live the moment this returns, but the turn it
 * runs in was built with the support tool surface — the work tools are not
 * bound and cannot be bound mid-run. The next message routes to work mode
 * (the router finds the active engagement before it classifies anything), so
 * the result says so and the overlay tells the model not to pretend otherwise.
 */
function createStartWorkTool(deps: StartWorkToolDeps): PluginTool {
  return tool(
    async (rawArgs, ctx: RuntimeContext) => {
      const { serviceId } = startWorkSchema.parse(rawArgs);
      const { card, error } = await resolveCard(deps, ctx);
      if (error !== undefined) {
        throw new Error(
          `The job for "${serviceId}" could not be started because ${error}. Nothing was reserved ` +
            'and nothing was charged. This is not a problem with the service id or with the ' +
            "user's contract — tell them what happened and offer to try again shortly.",
        );
      }
      const service = card?.services.find((s) => s.id === serviceId);
      if (!service) {
        const validIds = card?.services.map((s) => s.id) ?? [];
        throw new Error(
          `Unknown serviceId "${serviceId}". Valid service ids: ${
            validIds.join(', ') || '(none)'
          }.`,
        );
      }

      const roomId = ctx.session.roomId;
      const threadId = threadIdFor(ctx);
      if (!roomId || !threadId) {
        return 'Paid work can only be started from a chat thread in this room.';
      }

      const routed = toRoutedService(service);
      const gate = await deps.contractGate.check({
        roomId,
        threadId,
        senderDid: ctx.user.did,
        service: routed,
      });
      if (!gate.ok) {
        ctx.logger.log(
          `[oracle-payments] start_work refused ${routed.id} in thread ${threadId}: ${gate.reason}` +
            (gate.detail !== undefined ? ` — ${gate.detail}` : ''),
        );
        return refuseStart(gate.reason, routed, {
          ...(gate.detail !== undefined && { detail: gate.detail }),
          ...(gate.inProgress !== undefined && { inProgress: gate.inProgress }),
        });
      }

      const started = await deps.workIntent.startEngagement(
        roomId,
        threadId,
        gate.start,
      );
      if (!started.ok) {
        ctx.logger.log(
          `[oracle-payments] start_work could not open ${routed.id} in thread ${threadId}: ${started.reason}` +
            (started.detail !== undefined ? ` — ${started.detail}` : ''),
        );
        return refuseStart(started.reason, routed, {
          ...(started.detail !== undefined && { detail: started.detail }),
        });
      }

      ctx.logger.log(
        `[oracle-payments] start_work opened an engagement for ${routed.id} in thread ${threadId}`,
      );
      return {
        started: true,
        serviceId: routed.id,
        serviceName: routed.name,
        priceUsd: routed.priceUsd,
        note:
          'The job is open and its payment is reserved. Your work tools are ' +
          "not bound in this reply — they bind on the user's next message, " +
          'which routes to work mode automatically. Tell the user the job has ' +
          'started, say what you need from them, and ask them to send it in ' +
          'this thread. Do not start, sample, or describe having done any of ' +
          'the work now.',
      };
    },
    {
      name: 'start_work',
      description: START_WORK_DESCRIPTION,
      schema: startWorkSchema,
    },
  );
}

/**
 * The commerce tools available in BOTH modes: the catalog, the contract card,
 * contract status, and this thread's attachments. They answer "what am I
 * paying for?" / "how much quota is left?", which a user in the middle of a
 * job asks as readily as one at the front desk — so work mode binds them too
 * rather than making the user abandon the job to find out.
 */
export function createOraclePaymentsTools(
  deps: OraclePaymentsToolDeps,
): PluginTool[] {
  return [
    createListServicesTool(deps),
    createShowContractTool(deps),
    createGetContractStatusTool(deps),
    createGetThreadAttachmentTool(deps),
  ];
}

/** The support surface: the shared tools plus the gated route into work. */
export function createOraclePaymentsSupportTools(
  deps: OraclePaymentsToolDeps & { startWork: StartWorkToolDeps },
): PluginTool[] {
  return [
    ...createOraclePaymentsTools(deps),
    createStartWorkTool(deps.startWork),
  ];
}

/** The work surface: the shared tools plus delivery and cancellation. */
export function createOraclePaymentsWorkTools(
  deps: OraclePaymentsToolDeps & { workClaim: WorkClaimService },
): PluginTool[] {
  return [
    createDeliverWorkTool(deps),
    createCancelWorkTool(deps),
    ...createOraclePaymentsTools(deps),
  ];
}

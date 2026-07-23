import { z } from 'zod';
import { postOracleComponent } from '../../matrix/oracle-component-event.js';
import { tool } from '../../plugin-api/tool-helper.js';
import type { PluginTool, RuntimeContext } from '../../plugin-api/types.js';
import type { AgentCardService } from './agent-card.service.js';
import type { ContractRecordService } from './contract-record.service.js';
import type { ThreadAttachmentService } from './thread-attachments.service.js';
import {
  cancelWorkSchema,
  deliverWorkSchema,
  type WorkClaimService,
} from './work-claim.service.js';
import {
  oracleAddressFromDid,
  readConfigString,
  summarizeServices,
  toContractServiceProp,
  toListServiceProp,
} from './util.js';

export interface OraclePaymentsToolDeps {
  agentCard: AgentCardService;
  contractRecord: ContractRecordService;
  threadAttachments: ThreadAttachmentService;
}

const noArgsSchema = z.object({});
const showContractSchema = z.object({
  serviceId: z.string().describe('The id of the service to contract.'),
});

/**
 * The oracle's Matrix thread root doubles as the session id; a component event
 * posts in-thread only when the turn is threaded (the Matrix transport).
 */
function threadIdFor(ctx: RuntimeContext): string | undefined {
  return ctx.session.client === 'matrix' ? ctx.session.id : undefined;
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
      const entityDid = readConfigString(ctx.config, 'ORACLE_ENTITY_DID');
      const card = entityDid ? await deps.agentCard.getCard(entityDid) : null;
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
      const entityDid = readConfigString(ctx.config, 'ORACLE_ENTITY_DID');
      const card = entityDid ? await deps.agentCard.getCard(entityDid) : null;
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
      const currency = service.price.currency ?? 'USDC';

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
      const engineUrl = readConfigString(ctx.config, 'EVAL_ENGINE_URL');
      const record = await deps.contractRecord.lookup({
        engineUrl,
        subscriberDid: ctx.user.did,
      });
      if (!record) {
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

/** The support-mode commerce tools, built request-time. */
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

/** The work-mode commerce tools, built request-time. */
export function createOraclePaymentsWorkTools(deps: {
  workClaim: WorkClaimService;
  threadAttachments: ThreadAttachmentService;
}): PluginTool[] {
  return [
    createDeliverWorkTool(deps),
    createCancelWorkTool(deps),
    createGetThreadAttachmentTool(deps),
  ];
}

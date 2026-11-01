import { z } from 'zod';
import { tool } from '../../plugin-api/tool-helper';
import type { PluginTool, RuntimeContext } from '../../plugin-api/types';
import { priceLabel, type AgentCard } from './agent-card';
import type { ResolvedPaymentsEnv } from './config';
import { EngagementStore } from './engagements';
import { cancelWork, deliverWork, startWork } from './lane';

export interface ToolDeps {
  card: AgentCard;
  env: (ctx: RuntimeContext) => ResolvedPaymentsEnv;
  portalUrl?: string;
}

const serviceIdSchema = z.object({
  serviceId: z.string().min(1).describe('The service id from list_services.'),
});

function listServices({ card }: ToolDeps): PluginTool {
  return tool(
    async () => ({
      oracle: card.name,
      services: card.services.map((s) => ({
        id: s.id,
        name: s.name,
        description: s.description,
        price: priceLabel(s),
        deliveryTime: s.deliveryTime,
        doneMeans: s.doneMeans,
      })),
    }),
    {
      name: 'list_services',
      description:
        "This oracle's paid services with prices, what each delivers and how long it takes. Use it to answer what you offer and what it costs.",
      schema: z.object({}),
      effect: 'read',
    },
  );
}

function showContract({ card, portalUrl }: ToolDeps): PluginTool {
  return tool(
    async (raw) => {
      const { serviceId } = serviceIdSchema.parse(raw);
      const service = card.services.find((s) => s.id === serviceId);
      if (!service) {
        return `[Unknown service "${serviceId}". Valid ids: ${card.services.map((s) => s.id).join(', ')}]`;
      }
      return {
        service: service.name,
        price: priceLabel(service),
        deliveryTime: service.deliveryTime,
        doneMeans: service.doneMeans,
        howToHire:
          `Hire this oracle for "${service.name}" from the IXO Portal${portalUrl ? ` (${portalUrl})` : ''}: ` +
          'open the oracle, choose the service and approve the agreement. Approving reserves nothing yet — ' +
          'the price is only held when the work starts.',
      };
    },
    {
      name: 'show_contract',
      description:
        'The terms of one service and how the user hires this oracle for it. Use when the user wants to hire you or start_work said they are not contracted.',
      schema: serviceIdSchema,
      effect: 'read',
    },
  );
}

function contractStatus(_deps: ToolDeps): PluginTool {
  return tool(
    async (_raw, ctx) => {
      if (!ctx.kv) return '[Contract status is not available on this host]';
      const store = new EngagementStore(ctx.kv);
      const [active, last] = await Promise.all([
        store.active(),
        store.lastSettled(),
      ]);
      return {
        activeJob: active
          ? {
              service: active.serviceName,
              price: `${active.priceUsd} USD`,
              startedAt: active.startedAt,
              reservationTx: active.intentTxHash,
              ...(active.cancelledAt && { cancellationPending: true }),
            }
          : null,
        lastSettled: last,
      };
    },
    {
      name: 'get_contract_status',
      description:
        "The user's open paid job (if any) and how their last one ended. Read-only.",
      schema: z.object({}),
      effect: 'read',
    },
  );
}

function startWorkTool(deps: ToolDeps): PluginTool {
  return tool(
    async (raw, ctx) => {
      const { serviceId } = serviceIdSchema.parse(raw);
      const res = await startWork({ ctx, env: deps.env(ctx) }, serviceId);
      if (res.started) {
        const { engagement: e } = res;
        return (
          `Job started: "${e.serviceName}" for ${e.priceUsd} USD is now reserved (tx ${e.intentTxHash}). ` +
          'From the next message you work in paid mode with your full tools. Tell the user the job is open and ' +
          'what you will deliver; ask for anything you still need from them.'
        );
      }
      return {
        started: false,
        reason: res.reason,
        detail: res.detail,
        next:
          res.reason === 'not_contracted' ||
          res.reason === 'service_not_contracted'
            ? 'Explain that they have not hired you for this service yet, then call show_contract for it.'
            : 'Explain plainly why the job could not start. Do not do the work for free.',
      };
    },
    {
      name: 'start_work',
      description:
        'Open a paid job for one service: checks the user hired you for it, reserves the agreed price, and switches you to work mode. The ONLY way paid work begins. Call it when the user wants the service performed now.',
      schema: serviceIdSchema,
      effect: 'write',
    },
  );
}

const deliverSchema = z.object({
  description: z
    .string()
    .min(1)
    .describe(
      'One or two sentences on what you did, shown with the delivery and recorded on the claim.',
    ),
  resultStatus: z
    .enum(['completed', 'partial', 'unable'])
    .describe(
      'Honest outcome. It is independently evaluated — never overstate it.',
    ),
  deliverable: z
    .string()
    .min(1)
    .describe(
      'The full work product in markdown — the actual deliverable, not a summary of it.',
    ),
  fileName: z
    .string()
    .optional()
    .describe('File name for the deliverable, e.g. "mrv-plan.md".'),
  proofs: z
    .string()
    .optional()
    .describe('Evidence backing the work: sources, links, data references.'),
});

function deliverWorkTool(deps: ToolDeps): PluginTool {
  return tool(
    async (raw, ctx) => {
      const args = deliverSchema.parse(raw);
      const res = await deliverWork(
        { ctx, env: deps.env(ctx) },
        {
          description: args.description,
          resultStatus: args.resultStatus,
          text: args.deliverable,
          ...(args.fileName ? { fileName: args.fileName } : {}),
          ...(args.proofs ? { proofs: args.proofs } : {}),
        },
      );
      if (res.ok) {
        return (
          `Delivered. The work claim ${res.claimId} is on chain (tx ${res.txHash}) against the reserved payment. ` +
          'It is now independently evaluated; once approved the payment is released. ' +
          'Give the user the deliverable and tell them it was submitted for evaluation.'
        );
      }
      return { delivered: false, reason: res.reason, detail: res.detail };
    },
    {
      name: 'deliver_work',
      description:
        'Hand the finished work product to the user and file the claim that gets this job paid. Call once, when the work is done (or honestly partial / impossible).',
      schema: deliverSchema,
      effect: 'write',
      billing: 'contracted',
    },
  );
}

const cancelSchema = z.object({
  reason: z
    .string()
    .optional()
    .describe("The user's reason for cancelling, if they gave one."),
});

function cancelWorkTool(deps: ToolDeps): PluginTool {
  return tool(
    async (raw, ctx) => {
      const { reason } = cancelSchema.parse(raw);
      const res = await cancelWork({ ctx, env: deps.env(ctx) }, reason);
      if (res.ok) {
        return (
          `Cancelled. A record that nothing was delivered is on chain (claim ${res.claimId}, tx ${res.txHash}); ` +
          'once evaluated the reserved payment returns to the user. They can start a new job any time.'
        );
      }
      return { cancelled: false, reason: res.reason, detail: res.detail };
    },
    {
      name: 'cancel_work',
      description:
        'Cancel the open paid job when the user asks to stop. Releases the reserved payment back to them.',
      schema: cancelSchema,
      effect: 'write',
      billing: 'contracted',
    },
  );
}

/** Support mode: discover, hire, check status, start. */
export function supportTools(deps: ToolDeps): PluginTool[] {
  return [
    listServices(deps),
    showContract(deps),
    contractStatus(deps),
    startWorkTool(deps),
  ];
}

/** Work mode: deliver or cancel, plus the read-only three. */
export function workTools(deps: ToolDeps): PluginTool[] {
  return [
    listServices(deps),
    showContract(deps),
    contractStatus(deps),
    deliverWorkTool(deps),
    cancelWorkTool(deps),
  ];
}

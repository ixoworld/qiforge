import {
  type PluginTool,
  type RuntimeContext,
  tool,
  z,
} from '@ixo/oracle-runtime';
import { addComment, createIssue, getIssue } from './linear-client.js';

/**
 * Config the tools need at call time. Resolved once from the plugin's
 * validated `configSchema` and closed over by each tool factory — so the
 * handlers never read `process.env` directly.
 */
export interface LinearToolConfig {
  apiKey: string;
  teamId: string;
  escalationRoomId: string;
}

const priorityEnum = z
  .enum(['urgent', 'high', 'normal', 'low', 'none'])
  .describe(
    'Ticket priority. Use "urgent" for outages/billing/legal, "normal" for routine requests.',
  );

/** `create_ticket` — files a Linear issue for the case. Called on every case. */
export function buildCreateTicketTool(config: LinearToolConfig): PluginTool {
  return tool(
    async (rawArgs, ctx: RuntimeContext) => {
      const { title, description, priority } = z
        .object({
          title: z.string().min(1),
          description: z.string().min(1),
          priority: priorityEnum.optional(),
        })
        .parse(rawArgs);

      const ticket = await createIssue(
        {
          apiKey: config.apiKey,
          teamId: config.teamId,
          title,
          description,
          priority: priority ?? 'normal',
        },
        ctx.abortSignal,
      );
      return JSON.stringify(ticket);
    },
    {
      name: 'create_ticket',
      description:
        'File a new support ticket in Linear. Call this for EVERY case before resolving or escalating, so nothing is lost. Returns the ticket identifier and URL.',
      schema: z.object({
        title: z
          .string()
          .min(1)
          .describe('Short ticket title summarising the customer issue.'),
        description: z
          .string()
          .min(1)
          .describe(
            'Full case detail: what the customer reported, in their words plus any context.',
          ),
        priority: priorityEnum.optional(),
      }),
    },
  );
}

/** `comment_on_ticket` — append progress/notes to an existing ticket. */
export function buildCommentTool(config: LinearToolConfig): PluginTool {
  return tool(
    async (rawArgs, ctx: RuntimeContext) => {
      const { ticketId, comment } = z
        .object({
          ticketId: z.string().min(1),
          comment: z.string().min(1),
        })
        .parse(rawArgs);

      const ok = await addComment(
        { apiKey: config.apiKey, issueId: ticketId, body: comment },
        ctx.abortSignal,
      );
      return ok ? 'Comment added.' : 'Linear rejected the comment.';
    },
    {
      name: 'comment_on_ticket',
      description:
        'Append a comment to an existing Linear ticket — use to log what you did or what you are waiting on.',
      schema: z.object({
        ticketId: z
          .string()
          .min(1)
          .describe(
            'The ticket id or identifier (e.g. the id returned by create_ticket).',
          ),
        comment: z.string().min(1).describe('The note to append.'),
      }),
    },
  );
}

/** `get_ticket` — look up an existing ticket by identifier. */
export function buildGetTicketTool(config: LinearToolConfig): PluginTool {
  return tool(
    async (rawArgs, ctx: RuntimeContext) => {
      const { ticketId } = z
        .object({ ticketId: z.string().min(1) })
        .parse(rawArgs);

      const ticket = await getIssue(
        { apiKey: config.apiKey, id: ticketId },
        ctx.abortSignal,
      );
      return ticket
        ? JSON.stringify(ticket)
        : `No ticket found for "${ticketId}".`;
    },
    {
      name: 'get_ticket',
      description:
        'Look up an existing Linear ticket by its id or identifier (e.g. SUP-42). Returns title, status, priority, and URL.',
      schema: z.object({
        ticketId: z
          .string()
          .min(1)
          .describe('The ticket id or identifier to look up.'),
      }),
    },
  );
}

/**
 * `escalate_to_human` — hand a hard case to the human team. Posts the ticket
 * link + reason into the configured Matrix room. `ctx.matrix.postToRoom` is
 * provided by the runtime to every tool — no Matrix client setup needed here.
 */
export function buildEscalateTool(config: LinearToolConfig): PluginTool {
  return tool(
    async (rawArgs, ctx: RuntimeContext) => {
      const { ticketUrl, reason, summary } = z
        .object({
          ticketUrl: z.string().min(1),
          reason: z.string().min(1),
          summary: z.string().min(1),
        })
        .parse(rawArgs);

      const body = [
        '🚨 Support escalation',
        `Reason: ${reason}`,
        '',
        summary,
        '',
        `Ticket: ${ticketUrl}`,
      ].join('\n');

      await ctx.matrix.postToRoom(config.escalationRoomId, {
        msgtype: 'm.text',
        body,
      });
      return 'Escalated to the human support team. A person will pick up the ticket.';
    },
    {
      name: 'escalate_to_human',
      description:
        'Hand a case to the human support team via Matrix. Use for refunds, billing disputes, legal/security issues, angry or repeat-unhappy customers, or anything you are unsure about. Always create_ticket first and pass that ticket URL here.',
      schema: z.object({
        ticketUrl: z
          .string()
          .min(1)
          .describe('URL of the Linear ticket created for this case.'),
        reason: z
          .string()
          .min(1)
          .describe('Short reason for escalating (e.g. "refund request").'),
        summary: z
          .string()
          .min(1)
          .describe('1-3 sentence summary so a human can pick this up cold.'),
      }),
    },
  );
}

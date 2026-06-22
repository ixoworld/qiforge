import {
  OraclePlugin,
  type PluginContext,
  type PluginManifest,
  type PluginTool,
  z,
} from '@ixo/oracle-runtime';
import {
  buildCommentTool,
  buildCreateTicketTool,
  buildEscalateTool,
  buildGetTicketTool,
  buildSearchTool,
  type LinearToolConfig,
} from './linear-tools.js';

const NAME = 'linear';
const VERSION = '0.1.0';

/**
 * Env this plugin owns. Merged into the runtime's Zod schema at boot — if the
 * plugin is active and any of these is missing, the oracle refuses to start
 * with an error naming `linear`. That is the "fail loud" lesson.
 */
const configSchema = z.object({
  LINEAR_API_KEY: z.string().min(1, 'LINEAR_API_KEY must not be empty.'),
  LINEAR_TEAM_ID: z.string().min(1, 'LINEAR_TEAM_ID must not be empty.'),
  SUPPORT_ESCALATION_ROOM_ID: z
    .string()
    .min(1, 'SUPPORT_ESCALATION_ROOM_ID (Matrix room) must not be empty.'),
});

/**
 * The manifest IS the policy. The agent reasons over `whenToUse` /
 * `whenNotToUse` to decide whether to resolve a case itself or escalate it —
 * there is no routing `if` statement anywhere in this plugin. Tune the
 * oracle's judgment by editing this English, not the code.
 */
const manifest: PluginManifest = {
  title: 'Linear Support Tickets',
  summary:
    'File and manage customer support tickets in Linear, and escalate hard cases to the human team via Matrix. Create a ticket for EVERY case, then either resolve it or escalate.',
  whenToUse: [
    'Before filing anything, call search_tickets to check whether this issue was already reported or the customer has prior history.',
    'A customer reports a problem, complaint, question, or request — call create_ticket (after searching for duplicates).',
    'You can fully resolve the case from known information — resolve it, comment_on_ticket with what you did, and reply.',
    'You need the current status of a specific ticket — call get_ticket.',
  ],
  whenNotToUse: [
    'Refunds, chargebacks, or billing disputes — create the ticket, then escalate_to_human. Never decide these yourself.',
    'Legal threats, account access, or security issues — escalate_to_human.',
    'A visibly angry customer, or someone contacting us repeatedly about the same unresolved issue — escalate_to_human.',
    'Anything you are not confident you can resolve correctly — escalate_to_human. Never guess on a customer’s behalf.',
  ],
  examples: [
    {
      user: "I can't log in — password reset isn't arriving.",
      thought:
        'Routine, resolvable. File the ticket, walk them through the reset, log it.',
      tool: 'create_ticket',
      args: {
        title: 'Password reset email not arriving',
        description:
          'Customer reports the password reset email is not being received.',
        priority: 'normal',
      },
    },
    {
      user: 'You charged me twice and I want a full refund now.',
      thought:
        'Billing dispute + refund — out of my authority. File it urgent, then escalate.',
      tool: 'create_ticket',
      args: {
        title: 'Double charge — refund requested',
        description:
          'Customer reports being charged twice and is requesting a full refund.',
        priority: 'urgent',
      },
    },
  ],
  tags: ['support', 'tickets', 'linear', 'escalation', 'customer-service'],
  category: 'communication',
  // `always` so the support tools are bound from the first turn — no
  // load_capability dance for a single-purpose oracle.
  visibility: 'always',
  stability: 'beta',
};

/**
 * Linear support plugin — the worked example for Unblock 11.
 *
 *  • `configSchema`  → LINEAR_API_KEY / LINEAR_TEAM_ID / SUPPORT_ESCALATION_ROOM_ID
 *  • `autoDetect`    → only loads when LINEAR_API_KEY is set (keeps the
 *                      reference oracle bootable without Linear creds)
 *  • `manifest`      → the triage policy the agent reasons over
 *  • `getTools`      → search_tickets, create_ticket, comment_on_ticket, get_ticket, escalate_to_human
 */
export class LinearPlugin extends OraclePlugin {
  readonly name = NAME;

  readonly version = VERSION;

  readonly manifest = manifest;

  override readonly configSchema = configSchema;

  override readonly autoDetectHint = 'LINEAR_API_KEY';

  override autoDetect(env: NodeJS.ProcessEnv): boolean {
    return Boolean(env.LINEAR_API_KEY);
  }

  private resolveConfig(config: unknown): LinearToolConfig {
    const parsed = configSchema.parse(config);
    return {
      apiKey: parsed.LINEAR_API_KEY,
      teamId: parsed.LINEAR_TEAM_ID,
      escalationRoomId: parsed.SUPPORT_ESCALATION_ROOM_ID,
    };
  }

  override getTools(ctx: PluginContext): PluginTool[] {
    const config = this.resolveConfig(ctx.config);
    return [
      buildSearchTool(config),
      buildCreateTicketTool(config),
      buildCommentTool(config),
      buildGetTicketTool(config),
      buildEscalateTool(config),
    ];
  }
}

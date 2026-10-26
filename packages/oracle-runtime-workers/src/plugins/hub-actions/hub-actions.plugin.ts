import {
  operationJsonSchema,
  parseOperation,
  type ActionReferenceV1,
} from '@ixo/action-protocol';
import { z } from 'zod';
import { OraclePlugin } from '../../plugin-api/oracle-plugin';
import type {
  PluginManifest,
  PluginTool,
  RuntimeContext,
} from '../../plugin-api/types';

const configSchema = z.object({
  HUB_ACTIONS_ENABLED: z.enum(['true', 'false']).default('false'),
});

const operationSchema = z.fromJSONSchema({
  ...operationJsonSchema,
  $schema: 'https://json-schema.org/draft/2020-12/schema',
});
const requestSchema = z.strictObject({ operation: operationSchema });
const statusSchema = z.strictObject({
  actionId: z.string().regex(/^[A-Za-z0-9_-]{32}$/),
});
const discoverSchema = z.strictObject({});

export type HubActionRequestResult =
  | { status: 'prepared'; actionReference: ActionReferenceV1; summary: string }
  | {
      status: 'unavailable' | 'expired';
      reason: string;
      /** The earlier action that blocks this one (an unconfirmed email). */
      priorActionId?: string;
    };

/**
 * The idempotency key the Hub sees: a fixed-length digest of the run and
 * tool call (the Hub allows 120 characters; a run id alone is 72).
 */
async function hubRequestKey(runId: string, toolCallId: string) {
  const bytes = new Uint8Array(
    await crypto.subtle.digest(
      'SHA-256',
      new TextEncoder().encode(`${runId}:${toolCallId}`),
    ),
  );
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

async function requestHubAction(
  input: unknown,
  ctx: RuntimeContext,
): Promise<HubActionRequestResult> {
  const parsed = requestSchema.safeParse(input);
  if (!parsed.success)
    return { status: 'unavailable', reason: 'An operation is required.' };
  if (ctx.config.HUB_ACTIONS_ENABLED !== 'true' || !ctx.hubActions)
    return {
      status: 'unavailable',
      reason: 'Hub actions are not enabled for this oracle.',
    };
  const channel = ctx.session.channel;
  if (
    ctx.session.client !== 'channel' ||
    !channel ||
    !ctx.session.runId ||
    !ctx.toolCallId
  )
    return {
      status: 'unavailable',
      reason: 'A verified channel turn is required.',
    };
  let operation;
  try {
    operation = parseOperation(parsed.data.operation);
  } catch (error) {
    // The protocol's own words ("Invalid fromAddress"): the model can fix
    // the field instead of guessing.
    return {
      status: 'unavailable',
      reason: `The requested operation is unsupported or incomplete${error instanceof Error && error.message ? ` (${error.message})` : ''}.`,
    };
  }
  let reference: ActionReferenceV1;
  try {
    reference = await ctx.hubActions.request({
      ownerDid: ctx.user.did,
      sessionId: ctx.session.id,
      runId: ctx.session.runId,
      requestId: ctx.session.requestId,
      provider: channel.provider,
      bindingId: channel.bindingId,
      bindingRevision: channel.bindingRevision,
      requestKey: await hubRequestKey(ctx.session.runId, ctx.toolCallId),
      operation,
    });
  } catch (error) {
    // A cap reached, a request that expired, a run no user message
    // started: the runtime's own words, so the model can tell the user.
    // Anything else stays an error.
    if (
      error instanceof Error &&
      error.name === 'HubActionRefused' &&
      'kind' in error
    )
      return {
        status: error.kind === 'expired' ? 'expired' : 'unavailable',
        reason: error.message,
        ...('priorActionId' in error && typeof error.priorActionId === 'string'
          ? { priorActionId: error.priorActionId }
          : {}),
      };
    throw error;
  }
  return {
    status: 'prepared',
    actionReference: reference,
    summary: reference.title,
  };
}

async function hubActionStatus(
  input: unknown,
  ctx: RuntimeContext,
): Promise<unknown> {
  const parsed = statusSchema.safeParse(input);
  if (
    !parsed.success ||
    !ctx.hubActions ||
    ctx.config.HUB_ACTIONS_ENABLED !== 'true'
  )
    return { status: 'unavailable' };
  return {
    status: 'known',
    outcome: await ctx.hubActions.status(ctx.user.did, parsed.data.actionId),
  };
}

async function hubActionCapabilities(
  _input: unknown,
  ctx: RuntimeContext,
): Promise<unknown> {
  if (
    ctx.config.HUB_ACTIONS_ENABLED !== 'true' ||
    ctx.session.client !== 'channel' ||
    !ctx.session.channel ||
    !ctx.hubActions
  )
    return { status: 'unavailable' };
  return ctx.hubActions.capabilities();
}

async function hubActionOptions(
  _input: unknown,
  ctx: RuntimeContext,
): Promise<unknown> {
  const channel = ctx.session.channel;
  if (
    ctx.config.HUB_ACTIONS_ENABLED !== 'true' ||
    ctx.session.client !== 'channel' ||
    !channel ||
    !ctx.hubActions
  )
    return { status: 'unavailable' };
  return ctx.hubActions.options({
    ownerDid: ctx.user.did,
    provider: channel.provider,
    bindingId: channel.bindingId,
    bindingRevision: channel.bindingRevision,
  });
}

const manifest: PluginManifest = {
  title: 'Auth Hub action review',
  summary:
    'Prepare a registered operation for owner review and read its verified status.',
  whenToUse: [
    'The user requests a registered form submission or a transfer.',
    'The user asks to review an exact private resource or to sign a statement.',
    'The user asks to connect Gmail or Calendar, send a reviewed email or add an event.',
    'The user asks for document access or to save a private note.',
  ],
  whenNotToUse: [
    'Signing, executing, or treating a resource open as acceptance.',
  ],
  tags: ['actions', 'channels'],
  category: 'integration',
  visibility: 'on-demand',
  stability: 'experimental',
};

export class HubActionsPlugin extends OraclePlugin {
  readonly name = 'hub-actions';
  readonly version = '0.1.0';
  readonly manifest = manifest;
  override readonly configSchema = configSchema;
  /** The flag alone is not enough: the owner object needs the Hub's URL and this oracle's key. */
  override autoDetect(env: Record<string, unknown>): boolean {
    return (
      env.HUB_ACTIONS_ENABLED === 'true' &&
      typeof env.AUTH_HUB_URL === 'string' &&
      env.AUTH_HUB_URL.length > 0 &&
      typeof env.AUTH_HUB_CHANNEL_SERVICE_KEY === 'string' &&
      env.AUTH_HUB_CHANNEL_SERVICE_KEY.length > 0
    );
  }
  override getTools(): PluginTool[] {
    return [
      {
        name: 'hub_action_capabilities',
        description:
          "Read this authenticated oracle account's enabled operation kinds and exact registered form field schema before proposing a Hub action.",
        schema: discoverSchema,
        effect: 'read',
        handler: hubActionCapabilities,
      },
      {
        name: 'hub_action_options',
        description:
          'Read this authenticated owner’s confirmed Gmail and Calendar connections, requestable documents and action resources. Use each returned service, identifier and label before preparing a related Hub review. A Gmail profile connection does not authorize sending.',
        schema: discoverSchema,
        effect: 'read',
        handler: hubActionOptions,
      },
      {
        name: 'request_hub_action',
        description:
          'Prepare a supported operation for the authenticated channel owner to review in Auth Hub. Never approves, signs, or executes. For email, propose one plain-text message to one recipient using a confirmed Gmail send connection. Supply only the operation candidate; the runtime supplies identity and turn binding. Never prepare a replacement email after an unknown send without the user checking Gmail’s Sent folder and asking again.',
        schema: requestSchema,
        effect: 'write',
        handler: requestHubAction,
      },
      {
        name: 'hub_action_status',
        description:
          'Read the verified status of a Hub action already prepared for this owner. Never executes.',
        schema: statusSchema,
        effect: 'read',
        handler: hubActionStatus,
      },
    ];
  }
}

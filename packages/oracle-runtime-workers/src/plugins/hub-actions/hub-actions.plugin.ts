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
  | { status: 'unavailable'; reason: string };

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
  } catch {
    return {
      status: 'unavailable',
      reason: 'The requested operation is unsupported or incomplete.',
    };
  }
  const reference = await ctx.hubActions.request({
    ownerDid: ctx.user.did,
    sessionId: ctx.session.id,
    runId: ctx.session.runId,
    requestId: ctx.session.requestId,
    provider: channel.provider,
    bindingId: channel.bindingId,
    bindingRevision: channel.bindingRevision,
    requestKey: `${ctx.session.runId}:${ctx.toolCallId}`,
    operation,
  });
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
    'The user requests a supported review, statement, calendar connection or event, document access request, or private note.',
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
  override autoDetect(env: Record<string, unknown>): boolean {
    return env.HUB_ACTIONS_ENABLED === 'true';
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
          'Read this authenticated owner’s confirmed calendar connections, requestable documents and action resources. Use returned identifiers and labels before preparing a related Hub review.',
        schema: discoverSchema,
        effect: 'read',
        handler: hubActionOptions,
      },
      {
        name: 'request_hub_action',
        description:
          'Prepare a supported operation for the authenticated channel owner to review in Auth Hub. Never approves, signs, or executes. Supply only the operation candidate; the runtime supplies identity and turn binding.',
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

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
const transferSchema = z.strictObject({
  toAddress: z
    .string()
    .min(1)
    .max(100)
    .describe('The recipient address the user gave, exactly.'),
  denom: z
    .string()
    .min(1)
    .max(128)
    .describe(
      'The token, copied exactly from a `denom` in hub_action_options `transfer.tokens` (never guessed).',
    ),
  amount: z
    .string()
    .regex(/^(0|[1-9][0-9]*)(\.[0-9]+)?$/)
    .max(80)
    .describe(
      "A decimal amount in the token's listed units (its `decimals`); for an unverified token (decimals 0) a whole number of base units.",
    ),
  memo: z.string().max(256).optional(),
});

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
    if (operation.kind === 'ixo.bank.send.v1')
      // A transfer is built by the runtime from a listed token and a
      // display amount (request_hub_transfer): the model never supplies
      // base units, a denom it chose or a fee.
      return {
        status: 'unavailable',
        reason:
          'Use request_hub_transfer with a token from hub_action_options for a transfer.',
      };
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
    // A request that expired, a run no user message started, a Hub
    // refusal: the runtime's own words, so the model can tell the user.
    // Anything else stays an error.
    const refused = refusalOf(error);
    if (refused) return refused;
    throw error;
  }
  return {
    status: 'prepared',
    actionReference: reference,
    summary: reference.title,
  };
}

async function requestHubTransfer(
  input: unknown,
  ctx: RuntimeContext,
): Promise<HubActionRequestResult> {
  const parsed = transferSchema.safeParse(input);
  if (!parsed.success)
    return {
      status: 'unavailable',
      reason:
        'A recipient, a listed token denom and a plain decimal amount are required.',
    };
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
  try {
    const reference = await ctx.hubActions.transfer({
      ownerDid: ctx.user.did,
      sessionId: ctx.session.id,
      runId: ctx.session.runId,
      requestId: ctx.session.requestId,
      provider: channel.provider,
      bindingId: channel.bindingId,
      bindingRevision: channel.bindingRevision,
      requestKey: await hubRequestKey(ctx.session.runId, ctx.toolCallId),
      toAddress: parsed.data.toAddress,
      denom: parsed.data.denom,
      amount: parsed.data.amount,
      memo: parsed.data.memo ?? '',
    });
    return {
      status: 'prepared',
      actionReference: reference,
      summary: reference.title,
    };
  } catch (error) {
    // The owner object turns the protocol refusing the operation built
    // from the model's fields into a refusal; anything else is an error.
    const refused = refusalOf(error);
    if (refused) return refused;
    throw error;
  }
}

/** A typed runtime refusal as a result the model can relay, else null. */
function refusalOf(error: unknown): HubActionRequestResult | null {
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
  return null;
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
  const { outcome, summary } = await ctx.hubActions.status(
    ctx.user.did,
    parsed.data.actionId,
  );
  return { status: 'known', outcome, ...(summary ? { summary } : {}) };
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
          'Read this authenticated owner’s confirmed Gmail and Calendar connections, requestable documents, action resources and bank tokens (`transfer.tokens`: denom, symbol, decimals, verified, balance in base units). Use each returned service, identifier and label before preparing a related Hub review. A Gmail profile connection does not authorize sending. For a token that is not verified, name its full denom and say it is unverified; its amounts are base units.',
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
        name: 'request_hub_transfer',
        description:
          'Prepare a bank transfer of one of the owner’s listed tokens for review in Auth Hub. Never signs or executes. Read hub_action_options first and copy the token `denom` exactly; give the amount as the user said it in that token’s units (no base-unit math, no fee: Auth Hub sets the fee). Name the full denom for anything but IXO, and say when a token is unverified.',
        schema: transferSchema,
        effect: 'write',
        handler: requestHubTransfer,
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

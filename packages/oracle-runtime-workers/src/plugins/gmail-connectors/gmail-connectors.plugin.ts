import { z } from 'zod';
import { OraclePlugin, type PluginEnv } from '../../plugin-api/oracle-plugin';
import type {
  PluginManifest,
  PluginTool,
  RuntimeContext,
} from '../../plugin-api/types';
import {
  gmailConnectorConfigSchema,
  gmailOwnerDidSchema,
  gmailRuntimeConfigSchema,
} from './contract';
import {
  gmailConnectionStatus,
  gmailOwnerActionUrl,
  readGmailProfile,
} from './client';

const noArgs = z.object({}).strict();

export class GmailConnectorPlugin extends OraclePlugin {
  static readonly NAME = 'gmail-connectors';
  readonly name = GmailConnectorPlugin.NAME;
  readonly version = '0.1.0';
  override readonly configSchema = gmailConnectorConfigSchema;
  override readonly autoDetectHint =
    'set GMAIL_CONNECTOR_URL and GMAIL_CONNECTOR_OWNER_URL';
  readonly manifest: PluginManifest = {
    title: 'Gmail connection and profile',
    summary:
      'Check owner-approved Gmail readiness and read the selected Gmail account profile. Connecting and disconnecting require owner action in Portal.',
    visibility: 'on-demand',
    stability: 'experimental',
    category: 'integration',
    whenToUse: [
      'The user asks to connect Gmail, check its connection, read their Gmail profile, or disconnect Gmail.',
    ],
    whenNotToUse: [
      'Reading messages, searching mail, sending, modifying, deleting, or accessing an account the owner has not selected and approved.',
    ],
    tags: ['gmail', 'connection', 'profile'],
  };
  override readonly operatingGuide =
    '### Gmail permissions\nOnly Gmail profile reads are supported. A ready status verifies the current selected account and owner grant. Connect and disconnect return a Portal owner-action link; neither tool completes OAuth, grants consent, nor revokes access. Report pending, authorization_required and unavailable truthfully. Never claim a connection or revocation succeeded from a link.';

  override autoDetect(env: PluginEnv): boolean {
    return gmailConnectorConfigSchema.safeParse(env).success;
  }

  override getTools(): PluginTool[] {
    const tool = (
      name: string,
      description: string,
      handler: (ctx: RuntimeContext) => Promise<unknown>,
    ): PluginTool => ({
      name,
      description,
      schema: noArgs,
      effect: 'read',
      handler: async (args, ctx) => {
        if (!noArgs.safeParse(args).success)
          return { status: 'unavailable', reason: 'invalid_request' };
        return handler(ctx);
      },
    });
    return [
      tool(
        'gmail_connection_status',
        'Check whether the owner has connected and approved the selected Gmail account for profile reads.',
        gmailConnectionStatus,
      ),
      tool(
        'connect_gmail',
        'Return the Portal link where the owner can connect Gmail and approve profile reads. This does not connect an account.',
        async (ctx) => ownerAction(ctx, 'connect'),
      ),
      tool(
        'read_gmail_profile',
        'Read only the owner-selected Gmail account profile, with fixed empty arguments. No messages are read.',
        readGmailProfile,
      ),
      tool(
        'disconnect_gmail',
        'Return the Portal link where the owner can revoke Gmail access and disconnect it. This does not revoke or disconnect.',
        async (ctx) => ownerAction(ctx, 'disconnect'),
      ),
    ];
  }
}

function ownerAction(ctx: RuntimeContext, action: 'connect' | 'disconnect') {
  const config = gmailRuntimeConfigSchema.safeParse(ctx.config);
  if (!config.success)
    return { status: 'unavailable', reason: 'configuration' };
  const owner = gmailOwnerDidSchema.safeParse(ctx.user.did);
  if (!owner.success)
    return { status: 'unavailable', reason: 'invalid_request' };
  return {
    status: 'owner_action_required',
    action,
    ownerActionUrl: gmailOwnerActionUrl(config.data, owner.data, action),
  };
}

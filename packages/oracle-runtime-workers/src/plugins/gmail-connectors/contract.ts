import { z } from 'zod';
import { isSecureUrl } from '../../artifacts/config';

const connectorUrl = z
  .string()
  .url()
  .refine((raw) => {
    const url = new URL(raw);
    return (
      isSecureUrl(raw) &&
      !url.username &&
      !url.password &&
      !url.hash &&
      !url.search
    );
  }, 'must be an HTTPS URL without credentials, query or fragment (HTTP loopback for local tests only)');

export const gmailConnectorConfigSchema = z.object({
  GMAIL_CONNECTOR_URL: connectorUrl,
  GMAIL_CONNECTOR_OWNER_URL: connectorUrl,
});

const supportedDid = z.string().regex(/^did:(?:ixo|key):[A-Za-z0-9._:%-]+$/);

export const gmailRuntimeConfigSchema = gmailConnectorConfigSchema.extend({
  ORACLE_DID: supportedDid,
  NETWORK: z.enum(['mainnet', 'testnet', 'devnet']),
  BLOCKSYNC_GRAPHQL_URL: z.string().url(),
});
export type GmailRuntimeConfig = z.infer<typeof gmailRuntimeConfigSchema>;
export const gmailOwnerDidSchema = supportedDid;
export const gmailAccountIdSchema = z.string().regex(/^[A-Za-z0-9_-]{1,256}$/);

export const gmailStatusSchema = z.discriminatedUnion('status', [
  z.object({ status: z.literal('authorization_required') }),
  z.object({ status: z.literal('pending') }),
  z.object({ status: z.literal('unavailable') }),
  z.object({
    status: z.literal('ready'),
    connectedAccountId: gmailAccountIdSchema,
    delegation: z.string().min(1).max(32_768),
    expiresAt: z.number().int().positive(),
  }),
]);
export type GmailWireStatus = z.infer<typeof gmailStatusSchema>;
export type GmailReadyGrant = Extract<GmailWireStatus, { status: 'ready' }>;

export const gmailProfileSchema = z.object({
  status: z.literal('ready'),
  profile: z.object({
    emailAddress: z.email().max(320),
    messagesTotal: z.number().int().nonnegative().safe(),
    threadsTotal: z.number().int().nonnegative().safe(),
    historyId: z
      .string()
      .regex(/^\d{1,128}$/)
      .optional(),
  }),
});

export type GmailConnectionStatus =
  | { status: 'authorization_required' | 'pending'; ownerActionUrl: string }
  | {
      status: 'ready';
      connectedAccountId: string;
      expiresAt: number;
      permission: 'gmail.profile.read';
    }
  | {
      status: 'unavailable';
      reason:
        | 'configuration'
        | 'signing'
        | 'connector'
        | 'invalid_grant'
        | 'invalid_request';
    };

export function gmailProfileResource(
  connectedAccountId: string,
): `composio:${string}` {
  return `composio://toolkit/gmail/account/${connectedAccountId}/tool/GMAIL_GET_PROFILE`;
}

export async function gmailRequestHash(input: {
  action: 'status' | 'profile';
  ownerDid: string;
  oracleDid: string;
  connectedAccountId: string | null;
}): Promise<string> {
  const bytes = new TextEncoder().encode(
    JSON.stringify([
      'ixo.agent-gmail.request.v1',
      input.action,
      input.ownerDid,
      input.oracleDid,
      input.connectedAccountId,
    ]),
  );
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, '0'),
  ).join('');
}

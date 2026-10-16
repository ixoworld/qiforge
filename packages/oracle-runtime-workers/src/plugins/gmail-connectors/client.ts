import {
  createIxoDIDResolver,
  createUCANValidator,
  parseDelegation,
} from '@ixo/ucan';
import type { RuntimeContext } from '../../plugin-api/types';
import {
  gmailOwnerDidSchema,
  gmailProfileResource,
  gmailProfileSchema,
  gmailRequestHash,
  gmailRuntimeConfigSchema,
  gmailStatusSchema,
  type GmailConnectionStatus,
  type GmailReadyGrant,
  type GmailRuntimeConfig,
} from './contract';

const REQUEST_TIMEOUT_MS = 10_000;
const MAX_RESPONSE_BYTES = 65_536;
const MAX_GRANT_SECONDS = 7 * 24 * 60 * 60;

export function gmailOwnerActionUrl(
  config: GmailRuntimeConfig,
  ownerDid: string,
  action: 'connect' | 'disconnect',
): string {
  const url = new URL(config.GMAIL_CONNECTOR_OWNER_URL);
  url.searchParams.set('oracleDid', config.ORACLE_DID);
  url.searchParams.set('ownerDid', ownerDid);
  url.searchParams.set('action', action);
  return url.toString();
}

async function readBoundedJson(response: Response): Promise<unknown> {
  if (!response.ok || !response.body) throw new Error('connector unavailable');
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      length += value.byteLength;
      if (length > MAX_RESPONSE_BYTES)
        throw new Error('connector response too large');
      chunks.push(value);
    }
  } finally {
    await reader.cancel();
    reader.releaseLock();
  }
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return JSON.parse(
    new TextDecoder('utf-8', { fatal: true, ignoreBOM: false }).decode(bytes),
  );
}

async function request(
  ctx: RuntimeContext,
  config: GmailRuntimeConfig,
  action: 'status' | 'profile',
  invocation: string,
  body: { ownerDid: string; connectedAccountId?: string },
): Promise<unknown> {
  const signal = AbortSignal.any([
    ctx.abortSignal,
    AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  ]);
  const response = await fetch(
    `${config.GMAIL_CONNECTOR_URL.replace(/\/$/, '')}/v1/agent-connectors/gmail/${action}`,
    {
      method: 'POST',
      headers: {
        authorization: `Bearer ${invocation}`,
        'x-auth-type': 'ucan',
        'x-ixo-network': config.NETWORK,
        'content-type': 'application/json',
      },
      body: JSON.stringify(body),
      redirect: 'manual',
      signal,
    },
  );
  return readBoundedJson(response);
}

async function validateGrant(
  grant: GmailReadyGrant,
  ownerDid: string,
  config: GmailRuntimeConfig,
): Promise<boolean> {
  const delegation = await parseDelegation(grant.delegation);
  const now = Math.floor(Date.now() / 1000);
  const [capability] = delegation.capabilities;
  if (
    delegation.issuer.did() !== ownerDid ||
    delegation.audience.did() !== config.ORACLE_DID ||
    delegation.proofs.length !== 0 ||
    delegation.capabilities.length !== 1 ||
    capability?.can !== 'tool/execute' ||
    capability.with !== gmailProfileResource(grant.connectedAccountId) ||
    (capability.nb !== undefined &&
      (capability.nb === null || Object.keys(capability.nb).length !== 0)) ||
    !Number.isFinite(delegation.expiration) ||
    delegation.expiration !== grant.expiresAt ||
    grant.expiresAt <= now ||
    grant.expiresAt > now + MAX_GRANT_SECONDS
  )
    return false;
  const validator = await createUCANValidator({
    serverDid: config.ORACLE_DID,
    rootIssuers: [ownerDid],
    didResolver: createIxoDIDResolver({
      indexerUrl: config.BLOCKSYNC_GRAPHQL_URL,
    }),
    requireExpiration: true,
  });
  return (await validator.validateDelegation(grant.delegation)).ok;
}

type InternalStatus =
  | Exclude<GmailConnectionStatus, { status: 'ready' }>
  | GmailReadyGrant;

async function connection(
  ctx: RuntimeContext,
  config: GmailRuntimeConfig,
  ownerDid: string,
): Promise<InternalStatus> {
  if (!ctx.ucan.hasSigningKey())
    return { status: 'unavailable', reason: 'signing' };
  const hash = await gmailRequestHash({
    action: 'status',
    ownerDid,
    oracleDid: config.ORACLE_DID,
    connectedAccountId: null,
  });
  const minted = await ctx.ucan.mintSelfSignedInvocation(
    config.GMAIL_CONNECTOR_URL,
    {
      can: 'connector/status',
      with: `composio://agent/${config.ORACLE_DID}/toolkit/gmail`,
      nb: { requestHash: hash },
    },
    { maxTtlSeconds: 60 },
  );
  if ('error' in minted) return { status: 'unavailable', reason: 'signing' };
  const status = gmailStatusSchema.parse(
    await request(ctx, config, 'status', minted.invocation, { ownerDid }),
  );
  switch (status.status) {
    case 'ready':
      return (await validateGrant(status, ownerDid, config))
        ? status
        : { status: 'unavailable', reason: 'invalid_grant' };
    case 'authorization_required':
    case 'pending':
      return {
        status: status.status,
        ownerActionUrl: gmailOwnerActionUrl(config, ownerDid, 'connect'),
      };
    case 'unavailable':
      return { status: 'unavailable', reason: 'connector' };
  }
}

export async function gmailConnectionStatus(
  ctx: RuntimeContext,
): Promise<GmailConnectionStatus> {
  const config = gmailRuntimeConfigSchema.safeParse(ctx.config);
  if (!config.success)
    return { status: 'unavailable', reason: 'configuration' };
  const owner = gmailOwnerDidSchema.safeParse(ctx.user.did);
  if (!owner.success)
    return { status: 'unavailable', reason: 'invalid_request' };
  try {
    const status = await connection(ctx, config.data, owner.data);
    if (status.status === 'ready')
      return {
        status: 'ready',
        connectedAccountId: status.connectedAccountId,
        expiresAt: status.expiresAt,
        permission: 'gmail.profile.read',
      };
    return status;
  } catch {
    return { status: 'unavailable', reason: 'connector' };
  }
}

export async function readGmailProfile(
  ctx: RuntimeContext,
): Promise<
  GmailConnectionStatus | ReturnType<typeof gmailProfileSchema.parse>
> {
  const config = gmailRuntimeConfigSchema.safeParse(ctx.config);
  if (!config.success)
    return { status: 'unavailable', reason: 'configuration' };
  const owner = gmailOwnerDidSchema.safeParse(ctx.user.did);
  if (!owner.success)
    return { status: 'unavailable', reason: 'invalid_request' };
  try {
    const status = await connection(ctx, config.data, owner.data);
    if (status.status !== 'ready') return status;
    const hash = await gmailRequestHash({
      action: 'profile',
      ownerDid: owner.data,
      oracleDid: config.data.ORACLE_DID,
      connectedAccountId: status.connectedAccountId,
    });
    const minted = await ctx.ucan.createInvocationFromDelegation(
      status.delegation,
      config.data.GMAIL_CONNECTOR_URL,
      {
        can: 'tool/execute',
        with: gmailProfileResource(status.connectedAccountId),
        nb: { requestHash: hash },
      },
      { maxTtlSeconds: 60 },
    );
    if ('error' in minted) return { status: 'unavailable', reason: 'signing' };
    return gmailProfileSchema.parse(
      await request(ctx, config.data, 'profile', minted.invocation, {
        ownerDid: owner.data,
        connectedAccountId: status.connectedAccountId,
      }),
    );
  } catch {
    return { status: 'unavailable', reason: 'connector' };
  }
}

import {
  createCompositeDIDResolver,
  createWebDIDResolver,
  createUCANValidator,
  defineCapability,
  parseDelegation,
  Schema,
  type DIDKeyResolver,
} from '@ixo/ucan';
import { z } from 'zod';
import type { OracleWorkerEnv, TurnIdentity } from '../do/contracts';
import { RunAttemptDeferred } from '../do/run-coordinator';
import {
  IXO_DID_RESOLUTION_CACHE_TTL_MS,
  sharedIxoDIDResolver,
} from '../shell/auth';
import {
  ChannelError,
  type ChannelTurnInput,
  channelRequestHash,
} from './contract';

export const ChannelInvoke = defineCapability({
  can: 'ixo:channel/invoke',
  protocol: 'ixo:',
  supportWildcards: false,
  nb: {
    provider: Schema.string(),
    bindingRevision: Schema.integer(),
    oracleDid: Schema.string(),
  },
  derives: (claimed, delegated) =>
    claimed.nb?.provider === delegated.nb?.provider &&
    claimed.nb?.bindingRevision === delegated.nb?.bindingRevision &&
    claimed.nb?.oracleDid === delegated.nb?.oracleDid
      ? { ok: {} }
      : {
          error: new Error('Channel caveats cannot change across a delegation'),
        },
});

export interface ChannelAuthConfig {
  oracleDid: string;
  channelDid: string;
  didResolver: DIDKeyResolver;
}

export async function authenticateChannel(
  headers: Headers,
  raw: string,
  input: ChannelTurnInput,
  config: ChannelAuthConfig,
): Promise<TurnIdentity> {
  const authorization = headers.get('authorization');
  const token = authorization?.match(/^Bearer ([A-Za-z0-9+/=_-]+)$/i)?.[1];
  if (
    !token ||
    token.length > 32_000 ||
    headers.get('x-auth-type')?.toLowerCase() !== 'ucan'
  )
    throw new ChannelError(401, 'A channel UCAN invocation is required');
  const validator = await createUCANValidator({
    serverDid: config.oracleDid,
    rootIssuers: ['*'],
    didResolver: config.didResolver,
    requireExpiration: true,
    // No replay marks: a poll repeats its exact body and may reuse an
    // invocation, also concurrently. The durable receipt keyed by
    // (user, binding, requestId) and the request hash in the invocation's
    // facts make every repeat return the same run instead of a new one.
    invocationStore: {
      has: async () => false,
      add: async () => undefined,
      addIfAbsent: async () => true,
    },
  });
  const result = await validator.validate(
    token,
    ChannelInvoke,
    `ixo:channel:${input.bindingId}`,
  );
  const chain = result.proofChain;
  const userDid = chain?.[0];
  if (
    !result.ok ||
    !userDid?.startsWith('did:ixo:') ||
    chain?.length !== 2 ||
    chain[1] !== config.channelDid ||
    result.invoker !== config.channelDid
  )
    throw new ChannelError(401, 'Invalid user-rooted channel invocation');
  const now = Math.floor(Date.now() / 1000);
  const invocation = await parseDelegation(token);
  const proof = invocation.proofs[0];
  if (
    invocation.proofs.length !== 1 ||
    !proof ||
    !('issuer' in proof) ||
    proof.proofs.length !== 0 ||
    proof.issuer.did() !== userDid ||
    proof.audience.did() !== config.channelDid ||
    proof.capabilities.length !== 1 ||
    proof.capabilities[0]?.can !== 'ixo:channel/invoke' ||
    proof.capabilities[0]?.with !== `ixo:channel:${input.bindingId}` ||
    !Number.isFinite(proof.expiration) ||
    !proof.expiration ||
    proof.expiration > now + 300
  )
    throw new ChannelError(
      401,
      'A bounded, direct user channel grant is required',
    );
  if (
    !result.expiration ||
    result.expiration <= now ||
    result.expiration > now + 60 ||
    !Number.isFinite(invocation.expiration) ||
    !invocation.expiration ||
    invocation.expiration > now + 60
  )
    throw new ChannelError(
      401,
      'Channel invocations must expire within 60 seconds',
    );
  const nb = result.capability?.nb;
  if (
    result.capability?.can !== 'ixo:channel/invoke' ||
    result.capability.with !== `ixo:channel:${input.bindingId}` ||
    nb?.provider !== input.provider ||
    nb.bindingRevision !== input.bindingRevision ||
    nb.oracleDid !== config.oracleDid
  )
    throw new ChannelError(403, 'Channel scope does not match this request');
  const hash = await channelRequestHash(raw);
  if (
    result.facts?.length !== 1 ||
    result.facts[0]?.requestId !== input.requestId ||
    result.facts[0]?.requestHash !== hash
  )
    throw new ChannelError(
      403,
      'Invocation does not authorize this request body',
    );
  return {
    userDid,
    channel: {
      callerDid: config.channelDid,
      provider: input.provider,
      bindingId: input.bindingId,
      bindingRevision: input.bindingRevision,
    },
  };
}

/**
 * did:web documents (a channel service identity) resolved for every channel
 * request, shared per isolate: successful lookups are cached as long as
 * did:ixo keys, failures never, and concurrent lookups share one request.
 */
const channelWebResolver = createWebDIDResolver({
  cacheTtlMs: IXO_DID_RESOLUTION_CACHE_TTL_MS,
});

export function channelAuthConfig(
  env: Pick<
    OracleWorkerEnv,
    'CHANNEL_SERVICE_DID' | 'BLOCKSYNC_GRAPHQL_URL' | 'ORACLE_DID'
  >,
): ChannelAuthConfig {
  if (!env.CHANNEL_SERVICE_DID)
    throw new ChannelError(503, 'Channels are not configured');
  const resolver = createCompositeDIDResolver([
    sharedIxoDIDResolver(env.BLOCKSYNC_GRAPHQL_URL),
    channelWebResolver,
  ]);
  return {
    oracleDid: env.ORACLE_DID,
    channelDid: env.CHANNEL_SERVICE_DID,
    didResolver: async (did) => {
      if (
        did === env.CHANNEL_SERVICE_DID ||
        did === env.ORACLE_DID ||
        did.startsWith('did:ixo:')
      )
        return resolver(did);
      return {
        error: {
          name: 'DIDKeyResolutionError',
          did,
          message: 'Unapproved channel identity',
        },
      };
    },
  };
}

const BindingVerdict = z.strictObject({ active: z.boolean() });

export async function assertActiveChannelBinding(
  identity: TurnIdentity,
  env: Pick<
    OracleWorkerEnv,
    'ORACLE_DID' | 'AUTH_HUB_CHANNEL_SERVICE_KEY' | 'AUTH_HUB' | 'AUTH_HUB_URL'
  >,
): Promise<void> {
  if (!identity.channel)
    throw new ChannelError(403, 'Channel identity is required');
  if (!env.AUTH_HUB_CHANNEL_SERVICE_KEY || (!env.AUTH_HUB && !env.AUTH_HUB_URL))
    throw new ChannelError(503, 'Channel binding validation is not configured');
  const url = new URL(
    '/api/internal/channels/validate-binding',
    env.AUTH_HUB_URL ?? 'https://auth-hub.internal',
  );
  if (url.protocol !== 'https:')
    throw new ChannelError(503, 'Auth Hub requires HTTPS');
  const request = new Request(url, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-channels-service-key': env.AUTH_HUB_CHANNEL_SERVICE_KEY,
    },
    body: JSON.stringify({
      bindingId: identity.channel.bindingId,
      bindingRevision: identity.channel.bindingRevision,
      userDid: identity.userDid,
      provider: identity.channel.provider,
      oracleDid: env.ORACLE_DID,
    }),
    signal: AbortSignal.timeout(10_000),
    redirect: 'manual',
  });
  let response: Response;
  try {
    response = await (env.AUTH_HUB
      ? env.AUTH_HUB.fetch(request)
      : fetch(request));
  } catch {
    throw new ChannelError(503, 'Channel binding validation is unavailable');
  }
  if (!response.ok)
    throw new ChannelError(503, 'Channel binding validation is unavailable');
  const parsed = BindingVerdict.safeParse(await response.json());
  if (!parsed.success)
    throw new ChannelError(503, 'Invalid channel binding validation response');
  if (!parsed.data.active)
    throw new ChannelError(403, 'Channel binding is inactive');
}

/**
 * The binding check before a channel attempt executes (a queued run being
 * dequeued, a recovery attempt). An inactive binding (403) ends the run. An
 * unavailable or unconfigured validator (503) defers the attempt to the run
 * coordinator's recovery backoff: nothing has executed, and one Auth Hub
 * outage must not lose the user's message.
 */
export async function assertChannelAttemptAllowed(
  identity: TurnIdentity,
  env: Parameters<typeof assertActiveChannelBinding>[1],
): Promise<void> {
  try {
    await assertActiveChannelBinding(identity, env);
  } catch (error) {
    if (error instanceof ChannelError && error.status === 503)
      throw new RunAttemptDeferred(error.message, { cause: error });
    throw error;
  }
}

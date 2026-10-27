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
  type ChannelControlInput,
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
  /** Every channel service DID allowed to invoke this deployment. */
  channelDids: readonly string[];
  didResolver: DIDKeyResolver;
}

export async function authenticateChannel(
  headers: Headers,
  raw: string,
  input: ChannelTurnInput | ChannelControlInput,
  config: ChannelAuthConfig,
): Promise<TurnIdentity> {
  const authorization = headers.get('authorization');
  const token = authorization?.match(/^Bearer ([A-Za-z0-9+/=_-]+)$/i)?.[1];
  if (
    !token ||
    token.length > 32_000 ||
    headers.get('x-auth-type')?.toLowerCase() !== 'ucan'
  )
    throw new ChannelError(
      401,
      'A channel UCAN invocation is required',
      'unauthorized',
    );
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
  // The invoker is the one listed channel service that signed this
  // invocation; the user's grant must be addressed to that same service.
  const channelDid = result.invoker;
  if (
    !result.ok ||
    !userDid?.startsWith('did:ixo:') ||
    chain?.length !== 2 ||
    !channelDid ||
    !config.channelDids.includes(channelDid) ||
    chain[1] !== channelDid
  )
    throw new ChannelError(
      401,
      'Invalid user-rooted channel invocation',
      'unauthorized',
    );
  const now = Math.floor(Date.now() / 1000);
  const invocation = await parseDelegation(token);
  const proof = invocation.proofs[0];
  if (
    invocation.proofs.length !== 1 ||
    !proof ||
    !('issuer' in proof) ||
    proof.proofs.length !== 0 ||
    proof.issuer.did() !== userDid ||
    proof.audience.did() !== channelDid ||
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
      'unauthorized',
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
      'unauthorized',
    );
  const nb = result.capability?.nb;
  if (
    result.capability?.can !== 'ixo:channel/invoke' ||
    result.capability.with !== `ixo:channel:${input.bindingId}` ||
    nb?.provider !== input.provider ||
    nb.bindingRevision !== input.bindingRevision ||
    nb.oracleDid !== config.oracleDid
  )
    throw new ChannelError(
      403,
      'Channel scope does not match this request',
      'scope_mismatch',
    );
  const hash = await channelRequestHash(raw);
  if (
    result.facts?.length !== 1 ||
    result.facts[0]?.requestId !== input.requestId ||
    result.facts[0]?.requestHash !== hash
  )
    throw new ChannelError(
      403,
      'Invocation does not authorize this request body',
      'scope_mismatch',
    );
  return {
    userDid,
    channel: {
      callerDid: channelDid,
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

/**
 * `CHANNEL_SERVICE_DID` is one DID or a comma-separated list (one channel
 * service per messaging provider, or a rotation overlap): entries are
 * trimmed, empty ones dropped and duplicates removed, order kept.
 */
export function parseChannelServiceDids(raw: string | undefined): string[] {
  return [
    ...new Set(
      (raw ?? '')
        .split(',')
        .map((did) => did.trim())
        .filter((did) => did !== ''),
    ),
  ];
}

export function channelAuthConfig(
  env: Pick<
    OracleWorkerEnv,
    'CHANNEL_SERVICE_DID' | 'BLOCKSYNC_GRAPHQL_URL' | 'ORACLE_DID'
  >,
): ChannelAuthConfig {
  const channelDids = parseChannelServiceDids(env.CHANNEL_SERVICE_DID);
  if (channelDids.length === 0)
    throw new ChannelError(
      503,
      'Channels are not configured',
      'not_configured',
    );
  const resolver = createCompositeDIDResolver([
    sharedIxoDIDResolver(env.BLOCKSYNC_GRAPHQL_URL),
    channelWebResolver,
  ]);
  return {
    oracleDid: env.ORACLE_DID,
    channelDids,
    didResolver: async (did) => {
      if (
        channelDids.includes(did) ||
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
  identity: Pick<TurnIdentity, 'userDid'> & {
    channel?: Pick<
      NonNullable<TurnIdentity['channel']>,
      'provider' | 'bindingId' | 'bindingRevision'
    >;
  },
  env: Pick<
    OracleWorkerEnv,
    'ORACLE_DID' | 'AUTH_HUB_CHANNEL_SERVICE_KEY' | 'AUTH_HUB' | 'AUTH_HUB_URL'
  >,
): Promise<void> {
  if (!identity.channel)
    throw new ChannelError(
      403,
      'Channel identity is required',
      'identity_required',
    );
  if (!env.AUTH_HUB_CHANNEL_SERVICE_KEY || (!env.AUTH_HUB && !env.AUTH_HUB_URL))
    throw new ChannelError(
      503,
      'Channel binding validation is not configured',
      'not_configured',
    );
  const url = new URL(
    '/api/internal/channels/validate-binding',
    env.AUTH_HUB_URL ?? 'https://auth-hub.internal',
  );
  if (url.protocol !== 'https:')
    throw new ChannelError(503, 'Auth Hub requires HTTPS', 'not_configured');
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
    throw new ChannelError(
      503,
      'Channel binding validation is unavailable',
      'binding_check_unavailable',
    );
  }
  if (!response.ok)
    throw new ChannelError(
      503,
      'Channel binding validation is unavailable',
      'binding_check_unavailable',
    );
  const parsed = BindingVerdict.safeParse(await response.json());
  if (!parsed.success)
    throw new ChannelError(
      503,
      'Invalid channel binding validation response',
      'binding_check_unavailable',
    );
  if (!parsed.data.active)
    throw new ChannelError(
      403,
      'Channel binding is inactive',
      'binding_inactive',
    );
}

/**
 * How long an isolate trusts an Auth Hub "active" verdict for one binding
 * revision and user. A revoked binding is therefore noticed by new
 * admissions at most this late: inside the lifetime of the channel grant
 * that authorized the request (at most 300 s, `authenticateChannel`), and
 * attempts that start later (dequeued, recovered) check again uncached.
 */
export const CHANNEL_BINDING_CACHE_TTL_MS = 60_000;
/** Verdicts an isolate keeps at most; the oldest makes room. */
export const CHANNEL_BINDING_CACHE_MAX_ENTRIES = 1_000;

/** Positive verdicts only (key → epoch ms it expires); a refusal is never kept. */
const activeBindings = new Map<string, number>();

/** Forget every cached verdict (tests). */
export function clearChannelBindingCache(): void {
  activeBindings.clear();
}

/**
 * `assertActiveChannelBinding` for an admission through the shell, with an
 * "active" verdict cached per isolate for `CHANNEL_BINDING_CACHE_TTL_MS`,
 * keyed by the oracle, provider, binding, binding revision and user. An
 * inactive binding (403) or an unavailable Auth Hub (503) is never cached.
 * Returns whether the Auth Hub was asked.
 */
export async function assertActiveChannelBindingCached(
  identity: TurnIdentity,
  env: Parameters<typeof assertActiveChannelBinding>[1],
  now: number = Date.now(),
): Promise<'cached' | 'checked'> {
  const channel = identity.channel;
  const key = channel
    ? JSON.stringify([
        env.ORACLE_DID,
        channel.provider,
        channel.bindingId,
        channel.bindingRevision,
        identity.userDid,
      ])
    : null;
  if (key) {
    const until = activeBindings.get(key);
    if (until !== undefined) {
      if (until > now) return 'cached';
      activeBindings.delete(key);
    }
  }
  await assertActiveChannelBinding(identity, env);
  if (!key) return 'checked';
  if (activeBindings.size >= CHANNEL_BINDING_CACHE_MAX_ENTRIES) {
    for (const [cached, until] of activeBindings)
      if (until <= now) activeBindings.delete(cached);
    // Still full: drop the oldest entry (Map keeps insertion order).
    const oldest = activeBindings.keys().next();
    if (
      activeBindings.size >= CHANNEL_BINDING_CACHE_MAX_ENTRIES &&
      !oldest.done
    )
      activeBindings.delete(oldest.value);
  }
  activeBindings.set(key, now + CHANNEL_BINDING_CACHE_TTL_MS);
  return 'checked';
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

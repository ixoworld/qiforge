import {
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
  channelDidKeys,
  channelKeySource,
  shortDid,
  type ChannelKeyRole,
} from './key-lookup';
import {
  ChannelError,
  type ChannelHistoryInput,
  type ChannelTurnInput,
  type ChannelControlInput,
  channelRequestHash,
  historyQueryHash,
} from './contract';
import { mediaQueryHash, type ChannelMediaInput } from './media';

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

/**
 * A read of a web binding's conversation history (`POST /channels/history`).
 * The grant is minted by the Auth Hub only against a fresh signature of one
 * of the binding's browser devices (`deviceId`, required here), and names
 * the exact query it allows (`queryHash`, the SHA-256 of
 * `canonicalHistoryQuery`). It lives 60 s.
 */
export const ChannelHistory = defineCapability({
  can: 'ixo:channel/history',
  protocol: 'ixo:',
  supportWildcards: false,
  nb: {
    provider: Schema.string(),
    bindingRevision: Schema.integer(),
    oracleDid: Schema.string(),
    queryHash: Schema.string(),
    deviceId: Schema.string().optional(),
  },
  derives: (claimed, delegated) =>
    claimed.nb?.provider === delegated.nb?.provider &&
    claimed.nb?.bindingRevision === delegated.nb?.bindingRevision &&
    claimed.nb?.oracleDid === delegated.nb?.oracleDid &&
    claimed.nb?.queryHash === delegated.nb?.queryHash
      ? // `deviceId` is compared by `authenticateChannelHistory` itself, so a
        // grant and an invocation naming different devices answer
        // `403 scope_mismatch` rather than a bare 401.
        { ok: {} }
      : {
          error: new Error(
            'Channel history caveats cannot change across a delegation',
          ),
        },
});

/**
 * A read of one file or document of a web binding's history (`POST
 * /channels/media`). Minted by the Auth Hub exactly like a history grant
 * (a fresh signature of one of the binding's browser devices, the proof
 * labelled `ixo-channel-web-media/1`, `deviceId` required), naming the
 * exact media query it allows (`queryHash`, the SHA-256 of
 * `canonicalMediaQuery`). Its own capability: a history grant never reads
 * media and a media grant never reads a page. It lives 60 s.
 */
export const ChannelMedia = defineCapability({
  can: 'ixo:channel/media',
  protocol: 'ixo:',
  supportWildcards: false,
  nb: {
    provider: Schema.string(),
    bindingRevision: Schema.integer(),
    oracleDid: Schema.string(),
    queryHash: Schema.string(),
    deviceId: Schema.string().optional(),
  },
  derives: (claimed, delegated) =>
    claimed.nb?.provider === delegated.nb?.provider &&
    claimed.nb?.bindingRevision === delegated.nb?.bindingRevision &&
    claimed.nb?.oracleDid === delegated.nb?.oracleDid &&
    claimed.nb?.queryHash === delegated.nb?.queryHash
      ? { ok: {} }
      : {
          error: new Error(
            'Channel media caveats cannot change across a delegation',
          ),
        },
});

export interface ChannelAuthConfig {
  oracleDid: string;
  /** Every channel service DID allowed to invoke this deployment. */
  channelDids: readonly string[];
  didResolver: DIDKeyResolver;
  /**
   * Why `didResolver` refused a DID during this request, if it did: a key
   * lookup that failed with no kept keys to stand in (already logged by
   * the lookup), or an identity that is not allowed to be resolved.
   */
  lookupRefusal?: () => ChannelLookupRefusal | undefined;
}

export type ChannelLookupRefusal = 'key_lookup' | 'unapproved_identity';

/**
 * Logs a refused channel invocation whose cause is not a failed key lookup
 * (that one is logged by the lookup itself, `[channels] key lookup failed`):
 * `verification_failed` when every key resolved and the invocation still
 * did not verify (a bad signature, a broken chain or capability; `code` is
 * the validator's), `unapproved_identity` for a DID outside the allowlist,
 * `chain` for a valid invocation of the wrong shape. No token, body or
 * message text.
 */
function logChannelAuthRefusal(
  reason: 'verification_failed' | 'unapproved_identity' | 'chain',
  fields: Record<string, string | number | undefined>,
): void {
  // eslint-disable-next-line no-console -- console IS the logger on Workers (Logs/observability).
  console.warn(
    `[channels] invocation refused ${JSON.stringify({ reason, ...fields })}`,
  );
}

export async function authenticateChannel(
  headers: Headers,
  raw: string,
  input: ChannelTurnInput | ChannelControlInput,
  config: ChannelAuthConfig,
): Promise<TurnIdentity> {
  const verified = await verifyChannelInvocation(
    headers,
    raw,
    input,
    config,
    'invoke',
  );
  const nb = verified.nb;
  if (
    nb?.provider !== input.provider ||
    nb.bindingRevision !== input.bindingRevision ||
    nb.oracleDid !== config.oracleDid
  )
    throw new ChannelError(
      403,
      'Channel scope does not match this request',
      'scope_mismatch',
    );
  await assertFactsMatch(verified.facts, input.requestId, raw);
  return {
    userDid: verified.userDid,
    channel: {
      callerDid: verified.channelDid,
      provider: input.provider,
      bindingId: input.bindingId,
      bindingRevision: input.bindingRevision,
    },
  };
}

/**
 * The provider whose bindings may read their history (`POST
 * /channels/history`): only the web chat, which keeps no transcript of its
 * own. WhatsApp and Telegram keep theirs in the person's app.
 */
export const CHANNEL_HISTORY_PROVIDER = 'web';

/** A browser device id as the Auth Hub names it in a history grant (`dev_` + 43 base64url). */
const CHANNEL_DEVICE_ID = /^dev_[A-Za-z0-9_-]{43}$/;

/**
 * The longest a history grant may live, in seconds: the Auth Hub mints it
 * for 60 s; the rest allows for clock skew between the Hub and this oracle.
 */
export const CHANNEL_HISTORY_GRANT_MAX_SECONDS = 90;

/**
 * Verify a history read exactly like a channel turn (a direct grant from
 * the person to a listed channel service, invoked by that service within
 * 60 s, the facts naming this exact body), with its own capability
 * `ixo:channel/history` (an `ixo:channel/invoke` grant never reads history,
 * and a history grant never runs a turn), for a web binding only, and for
 * the exact query the person's device signed (`nb.queryHash`).
 */
export async function authenticateChannelHistory(
  headers: Headers,
  raw: string,
  input: ChannelHistoryInput,
  config: ChannelAuthConfig,
): Promise<TurnIdentity> {
  return authenticateWebRead(
    headers,
    raw,
    input,
    config,
    'history',
    await historyQueryHash(input.query),
  );
}

/**
 * Verify a media read (`POST /channels/media`) exactly like a history read,
 * with its own capability `ixo:channel/media` (a history grant is refused,
 * whatever its `queryHash`, and a media grant never reads a page), whose
 * `nb.queryHash` is the SHA-256 of `canonicalMediaQuery` of this body's
 * query.
 */
export async function authenticateChannelMedia(
  headers: Headers,
  raw: string,
  input: ChannelMediaInput,
  config: ChannelAuthConfig,
): Promise<TurnIdentity> {
  return authenticateWebRead(
    headers,
    raw,
    input,
    config,
    'media',
    await mediaQueryHash(input.query),
  );
}

/** The checks of a web read under its capability's grant (`kind`) for the query hashed as `queryHash`. */
async function authenticateWebRead(
  headers: Headers,
  raw: string,
  input: Pick<
    ChannelHistoryInput,
    'provider' | 'bindingId' | 'bindingRevision' | 'requestId'
  >,
  config: ChannelAuthConfig,
  kind: 'history' | 'media',
  queryHash: string,
): Promise<TurnIdentity> {
  const verified = await verifyChannelInvocation(
    headers,
    raw,
    input,
    config,
    kind,
  );
  const nb = verified.nb;
  if (
    input.provider !== CHANNEL_HISTORY_PROVIDER ||
    nb?.provider !== CHANNEL_HISTORY_PROVIDER
  )
    throw new ChannelError(
      403,
      'Channel history is only read for the web chat',
      'provider_not_supported',
    );
  if (nb.bindingRevision !== input.bindingRevision)
    throw new ChannelError(
      403,
      'The history grant is for another binding revision',
      'revision_mismatch',
    );
  if (
    nb.oracleDid !== config.oracleDid ||
    typeof nb.deviceId !== 'string' ||
    !CHANNEL_DEVICE_ID.test(nb.deviceId) ||
    verified.grantNb?.deviceId !== nb.deviceId ||
    typeof nb.queryHash !== 'string' ||
    !/^[0-9a-f]{64}$/.test(nb.queryHash) ||
    nb.queryHash !== queryHash
  )
    throw new ChannelError(
      403,
      'Channel scope does not match this request',
      'scope_mismatch',
    );
  await assertFactsMatch(verified.facts, input.requestId, raw);
  return {
    userDid: verified.userDid,
    channel: {
      callerDid: verified.channelDid,
      provider: input.provider,
      bindingId: input.bindingId,
      bindingRevision: input.bindingRevision,
    },
  };
}

async function assertFactsMatch(
  facts: readonly Record<string, unknown>[] | undefined,
  requestId: string,
  raw: string,
): Promise<void> {
  const hash = await channelRequestHash(raw);
  if (
    facts?.length !== 1 ||
    facts[0]?.requestId !== requestId ||
    facts[0]?.requestHash !== hash
  )
    throw new ChannelError(
      403,
      'Invocation does not authorize this request body',
      'scope_mismatch',
    );
}

/**
 * The checks every channel invocation passes, whatever it asks for: a
 * user-rooted chain of exactly two (the person, then one listed channel
 * service), a direct grant with ONE capability `capability.can` on this
 * binding that lives at most 300 s, an invocation that expires within 60 s.
 * The caller checks the capability's caveats and the facts.
 */
/** Whether a token that failed validation, or a proof in it, has expired. */
async function tokenExpired(token: string): Promise<boolean> {
  try {
    const invocation = await parseDelegation(token);
    const now = Math.floor(Date.now() / 1000);
    const expired = (expiration: number | undefined) =>
      typeof expiration === 'number' &&
      Number.isFinite(expiration) &&
      expiration < now;
    return (
      expired(invocation.expiration) ||
      invocation.proofs.some(
        (proof) => 'expiration' in proof && expired(proof.expiration),
      )
    );
  } catch {
    return false;
  }
}

async function verifyChannelInvocation(
  headers: Headers,
  raw: string,
  input: { bindingId: string },
  config: ChannelAuthConfig,
  kind: 'invoke' | 'history' | 'media',
): Promise<{
  userDid: string;
  channelDid: string;
  nb: Record<string, unknown> | undefined;
  /** The caveats of the person's grant itself (the invocation's are `nb`). */
  grantNb: Record<string, unknown> | undefined;
  facts: Record<string, unknown>[] | undefined;
}> {
  const capability =
    kind === 'invoke'
      ? ChannelInvoke
      : kind === 'history'
        ? ChannelHistory
        : ChannelMedia;
  const can = capability.can;
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
    capability,
    `ixo:channel:${input.bindingId}`,
  );
  const chain = result.proofChain;
  const userDid = chain?.[0];
  // The invoker is the one listed channel service that signed this
  // invocation; the user's grant must be addressed to that same service.
  const channelDid = result.invoker;
  if (!result.ok) {
    const refusal = config.lookupRefusal?.();
    if (refusal !== 'key_lookup')
      logChannelAuthRefusal(refusal ?? 'verification_failed', {
        code: result.error?.code,
      });
    // A history read tells an expired grant or invocation apart (the
    // gateway asks for a fresh grant); a turn keeps its one code. The
    // validator reports an expired chain as unauthorized, so the token's
    // own expiries are read (still 401: nothing is accepted).
    if (kind !== 'invoke' && (await tokenExpired(token)))
      throw new ChannelError(
        401,
        'The channel history grant has expired',
        'expired',
      );
    throw new ChannelError(
      401,
      'Invalid user-rooted channel invocation',
      'unauthorized',
    );
  }
  if (
    !userDid?.startsWith('did:ixo:') ||
    chain?.length !== 2 ||
    !channelDid ||
    !config.channelDids.includes(channelDid) ||
    chain[1] !== channelDid
  ) {
    logChannelAuthRefusal('chain', {
      invoker: channelDid ? shortDid(channelDid) : undefined,
      chainLength: chain?.length,
    });
    throw new ChannelError(
      401,
      'Invalid user-rooted channel invocation',
      'unauthorized',
    );
  }
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
    proof.capabilities[0]?.can !== can ||
    proof.capabilities[0]?.with !== `ixo:channel:${input.bindingId}` ||
    !Number.isFinite(proof.expiration) ||
    !proof.expiration ||
    proof.expiration >
      now + (kind !== 'invoke' ? CHANNEL_HISTORY_GRANT_MAX_SECONDS : 300) ||
    // A history grant that names when it starts was issued for at most
    // `CHANNEL_HISTORY_GRANT_MAX_SECONDS` (the Auth Hub's grants name no
    // start: their lifetime is then bounded by the time left above).
    (kind !== 'invoke' &&
      typeof proof.notBefore === 'number' &&
      proof.expiration - proof.notBefore > CHANNEL_HISTORY_GRANT_MAX_SECONDS)
  )
    throw new ChannelError(
      401,
      'A bounded, direct user channel grant is required',
      'unauthorized',
    );
  if (
    kind !== 'invoke' &&
    ((result.expiration !== undefined && result.expiration <= now) ||
      (Number.isFinite(invocation.expiration) &&
        invocation.expiration > 0 &&
        invocation.expiration <= now))
  )
    throw new ChannelError(
      401,
      'The channel history grant has expired',
      'expired',
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
  if (
    result.capability?.can !== can ||
    result.capability.with !== `ixo:channel:${input.bindingId}`
  )
    throw new ChannelError(
      403,
      'Channel scope does not match this request',
      'scope_mismatch',
    );
  const granted: unknown = proof.capabilities[0]?.nb;
  return {
    userDid,
    channelDid,
    nb: result.capability.nb,
    grantNb:
      typeof granted === 'object' && granted !== null
        ? { ...granted }
        : undefined,
    facts: result.facts,
  };
}

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

/**
 * The channel validator's config for one request. Keys of the oracle's own
 * DID, the listed channel services and did:ixo people come from the
 * isolate's kept keys or a lookup (`channelDidKeys`); any other DID is
 * refused without one. `waitUntil` (the request's) keeps a shared or
 * background lookup alive past the request that started it.
 */
export function channelAuthConfig(
  env: Pick<
    OracleWorkerEnv,
    'CHANNEL_SERVICE_DID' | 'BLOCKSYNC_GRAPHQL_URL' | 'ORACLE_DID'
  >,
  waitUntil?: (work: Promise<unknown>) => void,
): ChannelAuthConfig {
  const channelDids = parseChannelServiceDids(env.CHANNEL_SERVICE_DID);
  if (channelDids.length === 0)
    throw new ChannelError(
      503,
      'Channels are not configured',
      'not_configured',
    );
  let refusal: ChannelLookupRefusal | undefined;
  return {
    oracleDid: env.ORACLE_DID,
    channelDids,
    lookupRefusal: () => refusal,
    didResolver: async (did) => {
      const role: ChannelKeyRole | null =
        did === env.ORACLE_DID
          ? 'oracle'
          : channelDids.includes(did)
            ? 'gateway'
            : did.startsWith('did:ixo:')
              ? 'person'
              : null;
      if (!role) {
        refusal ??= 'unapproved_identity';
        return {
          error: {
            name: 'DIDKeyResolutionError',
            did,
            message: 'Unapproved channel identity',
          },
        };
      }
      const result = await channelDidKeys({
        did,
        role,
        ...channelKeySource(did, env.BLOCKSYNC_GRAPHQL_URL),
        ...(waitUntil ? { waitUntil } : {}),
      });
      if ('error' in result) refusal ??= 'key_lookup';
      return result;
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

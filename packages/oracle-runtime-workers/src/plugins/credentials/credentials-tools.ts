import { z } from 'zod';
import {
  dropFromPluginInbox,
  openPluginInbox,
  readPluginInbox,
} from '../../core/plugin-inbox';
import { tool } from '../../plugin-api/tool-helper';
import type {
  PluginTool,
  RuntimeContext,
  UserKvSurface,
} from '../../plugin-api/types';
import {
  DID_PATTERN,
  MAX_ISSUERS_PER_TYPE,
  type CredentialsConfig,
} from './config';
import {
  CredentialsWorkerClient,
  VERIFY_CAPABILITY,
  type VerifierEntryMemo,
} from './credentials-client';
import {
  CredentialsServiceError,
  MESSAGES,
  refusalFor,
  shortTime,
  type CredentialsRefusal,
} from './errors';
import type { FetchLike } from './http';
import {
  canonicalJson,
  HubPermissionsClient,
  PERMISSIONS_CAPABILITY,
  sha256Hex,
  type PermissionGrant,
  type PermissionStatus,
} from './hub-client';
import {
  CREDENTIALS_KV_NAMESPACE,
  inboxKeyOf,
  RESPONSE_ROUTE_PREFIX,
  sealResponseToken,
} from './response-route';
import {
  LINK_CAPABILITY,
  LINK_STATUSES,
  SelfLinksClient,
  type LinkStatus,
} from './self-client';
import {
  buildCredentialRequest,
  isVerificationUnavailable,
  newResponseKeys,
  randomToken,
  verifyDelivery,
  VerifierSetupError,
  type CheckOutcome,
  type CredentialQuery,
  type OracleSign,
  type VerifierContext,
} from './verifier';

// ---------------------------------------------------------------------------
// The WhatsApp gate.

/** The channel provider id of IXO Channels' WhatsApp. */
export const WHATSAPP_PROVIDER = 'whatsapp';

/**
 * The person's WhatsApp binding when this turn came from our WhatsApp
 * channel (`ctx.session.client === 'channel'` and
 * `ctx.session.channel.provider === 'whatsapp'`, both set by the runtime
 * from the authenticated channel turn, never by the model); null on every
 * other surface. Every tool of this plugin refuses without it.
 */
export function whatsAppBinding(
  ctx: Pick<RuntimeContext, 'session'>,
): { bindingId: string; bindingRevision: number } | null {
  const channel = ctx.session.channel;
  if (
    ctx.session.client !== 'channel' ||
    channel?.provider !== WHATSAPP_PROVIDER
  )
    return null;
  return {
    bindingId: channel.bindingId,
    bindingRevision: channel.bindingRevision,
  };
}

// ---------------------------------------------------------------------------
// Inputs.

const Did = z.string().max(256).regex(DID_PATTERN, 'a did:ixo or did:web');
const ClaimName = z
  .string()
  .min(1)
  .max(100)
  .regex(/^[A-Za-z0-9_.-]+$/, 'a field name such as age_over_18');
const Vct = z.string().url().max(512);
/**
 * Optional: the configured issuers of the type are the default, and a
 * list given must be among them (`acceptedIssuers`).
 */
const Issuers = z.array(Did).min(1).max(MAX_ISSUERS_PER_TYPE).optional();
const Claims = z.array(ClaimName).max(30);

/** Catalogued service actions this runtime can carry out. */
export const SUPPORTED_ACTIONS = ['self.identity-check'] as const;
export type SupportedAction = (typeof SUPPORTED_ACTIONS)[number];

export const CheckPermissionInput = z
  .object({
    vct: Vct.describe('The credential type (its vct URL).'),
    issuers: Issuers.describe(
      'Optional: fewer issuers than this service accepts for the type. Leave it out to use them all.',
    ),
    claims: Claims.min(1).describe(
      'The fields you need to see (1-30), as few as possible.',
    ),
    days: z
      .number()
      .int()
      .min(1)
      .max(90)
      .default(30)
      .describe('How long the permission lasts, in days (1-90).'),
  })
  .strict();

export const PermissionStatusInput = z
  .object({
    permissionId: z.string().regex(/^[A-Za-z0-9_-]{1,128}$/),
  })
  .strict();

export const CheckInput = z
  .object({
    vct: Vct,
    issuers: Issuers.describe(
      'Optional: fewer issuers than this service accepts for the type. Leave it out to use them all.',
    ),
    claims: Claims.default([]).describe(
      'The fields you need to see, as few as possible (empty = only that they hold one).',
    ),
    purpose: z
      .string()
      .min(1)
      .max(140)
      .optional()
      .describe(
        'Why you ask, in a few plain words the person may read in their wallet.',
      ),
  })
  .strict();

export const ActionPermissionInput = z
  .object({
    action: z.enum(SUPPORTED_ACTIONS),
    days: z
      .number()
      .int()
      .min(1)
      .max(30)
      .optional()
      .describe(
        "How long the permission lasts, in days (1-30); omit for the action's usual length.",
      ),
  })
  .strict();

export const ActionInput = z
  .object({ action: z.enum(SUPPORTED_ACTIONS) })
  .strict();

export const ActionStatusInput = z
  .object({
    action: z.enum(SUPPORTED_ACTIONS),
    ref: z
      .string()
      .regex(/^[A-Za-z0-9_-]{1,128}$/)
      .describe('The linkId credentials_request_action returned.'),
  })
  .strict();

// ---------------------------------------------------------------------------
// Shared plumbing.

export interface CredentialsToolsDeps {
  cfg: CredentialsConfig;
  /** The oracle's name and description (its config): who asks, in the catalog. */
  oracle: { name: string; description?: string };
  /** Built once per isolate by the plugin; null without Blocksync. */
  verifier: VerifierContext | null;
  memo: VerifierEntryMemo;
  fetchImpl?: FetchLike;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  /** How long `credentials_check` waits for an answer (default 20 s). */
  checkWaitMs?: number;
}

/** A card lives at most a day on the Hub; a little less, for clock skew. */
export const PERMISSION_CARD_TTL_SECONDS = 24 * 3600 - 300;
/** A presentation request of `credentials_check` lives 15 minutes. */
export const CHECK_REQUEST_TTL_SECONDS = 15 * 60;
export const CHECK_WAIT_MS = 20_000;
/** How often the worker is asked for the request's status while waiting. */
const WORKER_POLL_MS = 4_000;

const defaultSleep = (ms: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, ms));

type Ready = {
  cfg: CredentialsConfig & { serviceKey: string; oracleDid: string };
  binding: { bindingId: string; bindingRevision: number };
};

/** Everything every tool needs, or the refusal to answer instead. */
function readiness(
  ctx: RuntimeContext,
  cfg: CredentialsConfig,
): Ready | CredentialsRefusal {
  const binding = whatsAppBinding(ctx);
  if (!binding)
    return { error: 'whatsapp_only', message: MESSAGES.whatsAppOnly };
  const { serviceKey, oracleDid } = cfg;
  if (!cfg.enabled || !serviceKey || !oracleDid || !ctx.ucan.hasSigningKey())
    return { error: 'not_available', message: MESSAGES.notAvailable };
  return { cfg: { ...cfg, serviceKey, oracleDid }, binding };
}

function isRefusal(
  value: Ready | CredentialsRefusal,
): value is CredentialsRefusal {
  return 'error' in value;
}

function minted(
  result: { invocation: string } | { error: string },
  service: string,
  logger: RuntimeContext['logger'],
): string {
  if ('error' in result) {
    // The reason can name DIDs: logged, never shown.
    logger.warn(`[credentials] could not sign a call to ${service}`);
    throw new Error('UCAN mint failed');
  }
  return result.invocation;
}

function hubClient(
  ctx: RuntimeContext,
  ready: Ready,
  deps: CredentialsToolsDeps,
) {
  return new HubPermissionsClient({
    hubUrl: ready.cfg.hub.url,
    serviceKey: ready.cfg.serviceKey,
    mint: async (facts) =>
      minted(
        await ctx.ucan.mintSelfSignedInvocation(
          ready.cfg.hub.did,
          PERMISSIONS_CAPABILITY,
          { maxTtlSeconds: 120, facts },
        ),
        'the Hub',
        ctx.logger,
      ),
    ...transport(deps),
  });
}

function workerClient(
  ctx: RuntimeContext,
  ready: Ready,
  deps: CredentialsToolsDeps,
) {
  return new CredentialsWorkerClient({
    baseUrl: ready.cfg.credentials.url,
    mint: async (facts) =>
      minted(
        await ctx.ucan.mintSelfSignedInvocation(
          ready.cfg.credentials.did,
          VERIFY_CAPABILITY,
          { maxTtlSeconds: 120, facts },
        ),
        'the Credentials worker',
        ctx.logger,
      ),
    ...transport(deps),
  });
}

function selfClient(
  ctx: RuntimeContext,
  ready: Ready,
  deps: CredentialsToolsDeps,
  linkGrant: PermissionGrant,
) {
  return new SelfLinksClient({
    selfUrl: ready.cfg.self.url,
    webOrigin: ready.cfg.selfWebOrigin,
    ...(ready.cfg.oracleEntityDid
      ? { entityDid: ready.cfg.oracleEntityDid }
      : {}),
    mint: async (facts) =>
      minted(
        await ctx.ucan.createInvocationFromDelegation(
          linkGrant.token,
          ready.cfg.self.did,
          LINK_CAPABILITY,
          { maxTtlSeconds: 240, facts },
        ),
        'Self',
        ctx.logger,
      ),
    ...transport(deps),
  });
}

function transport(deps: CredentialsToolsDeps) {
  return {
    ...(deps.fetchImpl ? { fetchImpl: deps.fetchImpl } : {}),
    ...(deps.sleep ? { sleep: deps.sleep } : {}),
  };
}

/** A stable key for one tool call (the same on a resumed run), else random. */
async function requestKeyOf(
  ctx: RuntimeContext,
  salt: string,
): Promise<string> {
  if (ctx.session.runId && ctx.toolCallId)
    return sha256Hex(`${ctx.session.runId}:${ctx.toolCallId}:${salt}`);
  return randomToken(24);
}

function sortedUnique(values: readonly string[]): string[] {
  return [...new Set(values)].sort();
}

/**
 * The issuers a check or a card may name for `vct`: the operator's list
 * (`CREDENTIALS_TRUSTED_ISSUERS`), or the part of it the model asked for.
 * A type without a list, or an issuer outside it, is refused before anything
 * is sent: the model can narrow the trust anchor, never widen it.
 */
export function acceptedIssuers(
  cfg: Pick<CredentialsConfig, 'trustedIssuers'>,
  vct: string,
  asked: readonly string[] | undefined,
): { issuers: string[]; configured: string[] } | CredentialsRefusal {
  const listed = Object.hasOwn(cfg.trustedIssuers, vct)
    ? cfg.trustedIssuers[vct]
    : undefined;
  if (!listed?.length)
    return {
      error: 'untrusted_credential',
      message: MESSAGES.untrustedCredential,
    };
  const configured = sortedUnique(listed);
  if (asked === undefined) return { issuers: configured, configured };
  const issuers = sortedUnique(asked);
  if (issuers.some((did) => !configured.includes(did)))
    return { error: 'untrusted_issuer', message: MESSAGES.untrustedIssuer };
  return { issuers, configured };
}

/** The refusal for a failure, logged without any personal detail. */
function failed(
  ctx: RuntimeContext,
  tool: string,
  error: unknown,
): CredentialsRefusal {
  const refusal = refusalFor(error, {
    ...(ctx.user.timezone ? { timeZone: ctx.user.timezone } : {}),
  });
  ctx.logger.warn(
    `[credentials] ${tool}: ${
      error instanceof CredentialsServiceError
        ? `${error.service} ${error.status} ${error.code}`
        : error instanceof Error
          ? error.name
          : 'error'
    }`,
  );
  return refusal;
}

function kvOf(ctx: RuntimeContext): UserKvSurface | null {
  return ctx.kv ?? null;
}

// ---------------------------------------------------------------------------
// Permission cards.

const STATUS_MESSAGES: Record<PermissionStatus, string> = {
  pending: "They haven't answered yet.",
  allowed: 'They allowed it.',
  declined: 'They chose not to allow it.',
  expired: 'The request ended before they answered.',
  stopped: 'They stopped this permission.',
};

function linkMessage(name: string, url: string): string {
  return `Tap this link to see what ${name} is asking and choose Allow or Don't allow: ${url}`;
}

/** The kv key that remembers the card for one action. */
function actionKey(action: SupportedAction): string {
  return `action:${action}`;
}

const ActionRecord = z.object({ permissionId: z.string() });

const OpenLink = z.object({
  linkId: z.string().regex(/^[A-Za-z0-9_-]{1,128}$/),
  status: z.enum(LINK_STATUSES),
  expiresAt: z.number().int().positive(),
});

// ---------------------------------------------------------------------------
// credentials_check: rows in the person's kv.

const CheckRow = z.object({
  v: z.literal(1),
  checkId: z.string(),
  /** Unix seconds. */
  expiresAt: z.number(),
  subject: z.string(),
  query: z.object({
    vct: z.string(),
    issuers: z.array(z.string()),
    claims: z.array(z.string()),
  }),
  requestJwt: z.string(),
  privateJwk: z.object({
    kty: z.literal('EC'),
    crv: z.literal('P-256'),
    x: z.string(),
    y: z.string(),
    d: z.string(),
    kid: z.string().optional(),
    use: z.literal('enc').optional(),
    alg: z.literal('ECDH-ES').optional(),
  }),
  requestId: z.string().optional(),
  walletUrl: z.string().optional(),
});
type CheckRow = z.infer<typeof CheckRow>;

const CHECK_RESULT_MESSAGES: Record<CheckOutcome['result'] | 'none', string> = {
  valid: 'Their credential checks out.',
  invalid: "Their credential didn't pass the check.",
  revoked: 'Their credential has been revoked by its issuer.',
  expired: 'Their credential has expired.',
  none: "They didn't share a credential for this.",
};

function liveRow(value: unknown, nowSeconds: number): CheckRow | null {
  const parsed = CheckRow.safeParse(value);
  // A request about to end is not reused: a new one gets a full window.
  return parsed.success && parsed.data.expiresAt > nowSeconds + 60
    ? parsed.data
    : null;
}

/** The Hub page where the person answers the request. */
function walletUrlOf(
  cfg: CredentialsConfig,
  requestId: string,
  given?: string,
) {
  if (given) {
    try {
      if (new URL(given).origin === cfg.hub.url) return given;
    } catch {
      // Not a URL: use the Hub's own path.
    }
  }
  return `${cfg.hub.url}/credentials/requests/${encodeURIComponent(requestId)}`;
}

// ---------------------------------------------------------------------------
// The tools.

export function createCredentialsTools(
  deps: CredentialsToolsDeps,
): PluginTool[] {
  const now = deps.now ?? Date.now;
  const sleep = deps.sleep ?? defaultSleep;
  const { cfg, oracle } = deps;
  /** The credential types this oracle may check (the operator's list). */
  const acceptedTypes = `Credential types this service accepts (vct): ${Object.keys(cfg.trustedIssuers).join(', ') || 'none'}; their issuers are set by the operator.`;

  const requestCheckPermission = tool(
    async (raw, ctx) => {
      const ready = readiness(ctx, cfg);
      if (isRefusal(ready)) return ready;
      const args = CheckPermissionInput.parse(raw);
      const accepted = acceptedIssuers(cfg, args.vct, args.issuers);
      if ('error' in accepted) return accepted;
      try {
        const card = await hubClient(ctx, ready, deps).request({
          ...ready.binding,
          requestKey: await requestKeyOf(ctx, 'check-permission'),
          expiresAt: Math.floor(now() / 1000) + PERMISSION_CARD_TTL_SECONDS,
          permission: {
            kind: 'credential-check',
            vct: args.vct,
            issuers: accepted.issuers,
            claims: sortedUnique(args.claims),
            days: args.days,
          },
        });
        return {
          status: 'sent',
          permissionId: card.id,
          url: card.url,
          expiresAt: card.expiresAt,
          message: linkMessage(oracle.name, card.url),
        };
      } catch (error) {
        return failed(ctx, 'credentials_request_check_permission', error);
      }
    },
    {
      name: 'credentials_request_check_permission',
      description: [
        'Ask the person, once, for standing permission to check one of their credentials (for example that they are over 18 or have a verified identity).',
        'Use it before credentials_check when they have not allowed it yet, or when a check comes back pending. Ask for one credential type and as few fields as you need; the accepted issuers are configured (you may only narrow them).',
        acceptedTypes,
        "The person gets a card in the IXO wallet showing who asks, the credential, who issued it, the fields you will see and how long; they tap Allow or Don't allow.",
        'Send the returned url as one link in a short message (the `message` is ready to send). Never paste ids or tokens. Then check the answer with credentials_permission_status, or just call credentials_check once they say they allowed it.',
        'WhatsApp only.',
      ].join(' '),
      schema: CheckPermissionInput,
    },
  );

  const permissionStatus = tool(
    async (raw, ctx) => {
      const ready = readiness(ctx, cfg);
      if (isRefusal(ready)) return ready;
      const args = PermissionStatusInput.parse(raw);
      try {
        const state = await hubClient(ctx, ready, deps).status(
          args.permissionId,
        );
        return {
          permissionId: state.id,
          status: state.status,
          ...(state.allowedAt ? { allowedAt: state.allowedAt } : {}),
          ...(state.expiresAt ? { expiresAt: state.expiresAt } : {}),
          message: STATUS_MESSAGES[state.status],
        };
      } catch (error) {
        return failed(ctx, 'credentials_permission_status', error);
      }
    },
    {
      name: 'credentials_permission_status',
      description:
        'Read whether the person answered a permission card (pending, allowed, declined, expired or stopped). Use the permissionId a credentials_request_*_permission tool returned. Only call it when you need the answer to go on; do not poll in a loop. WhatsApp only.',
      schema: PermissionStatusInput,
      effect: 'read',
    },
  );

  const check = tool(
    async (raw, ctx) => {
      const ready = readiness(ctx, cfg);
      if (isRefusal(ready)) return ready;
      const kv = kvOf(ctx);
      const sign: OracleSign | undefined = ctx.ucan.signWithOracleKey;
      if (!kv || !sign || !deps.verifier || !cfg.publicUrl)
        return { error: 'not_available', message: MESSAGES.notAvailable };
      const args = CheckInput.parse(raw);
      const accepted = acceptedIssuers(cfg, args.vct, args.issuers);
      if ('error' in accepted) return accepted;
      const query: CredentialQuery = {
        vct: args.vct,
        issuers: accepted.issuers,
        claims: sortedUnique(args.claims),
      };
      try {
        return await runCheck({
          ctx,
          ready,
          kv,
          sign,
          verifier: deps.verifier,
          publicUrl: cfg.publicUrl,
          query,
          catalogIssuers: accepted.configured,
          purpose:
            args.purpose ??
            `${oracle.name} would like to check this.`.slice(0, 140),
        });
      } catch (error) {
        if (error instanceof VerifierSetupError) {
          ctx.logger.warn(`[credentials] credentials_check: ${error.code}`);
          return { error: 'not_available', message: MESSAGES.notAvailable };
        }
        if (isVerificationUnavailable(error))
          return { error: 'verification_unavailable', message: MESSAGES.busy };
        return failed(ctx, 'credentials_check', error);
      }
    },
    {
      name: 'credentials_check',
      description: [
        "Check one of the person's credentials: give the credential type (vct) and the fields you need (the accepted issuers are configured; you may only narrow them). It asks their IXO wallet, waits up to about 20 seconds and verifies the answer.",
        acceptedTypes,
        'result: valid (claims holds only the fields you asked for), invalid, revoked, expired, none (they did not share one) or pending (no standing permission answered: send them walletUrl as one link so they can answer in their wallet, or ask for standing permission first with credentials_request_check_permission).',
        'Calling it again with the same fields continues the same request; it does not ask twice. Never quote the claims back beyond what the conversation needs. WhatsApp only.',
      ].join(' '),
      schema: CheckInput,
    },
  );

  async function runCheck(input: {
    ctx: RuntimeContext;
    ready: Ready;
    kv: UserKvSurface;
    sign: OracleSign;
    verifier: VerifierContext;
    publicUrl: string;
    query: CredentialQuery;
    /** Every issuer the oracle accepts for the type (its catalog entry lists them). */
    catalogIssuers: string[];
    purpose: string;
  }) {
    const { ctx, ready, kv, query } = input;
    const worker = workerClient(ctx, ready, deps);
    const subject = ctx.user.did;
    const rowKey = `check:${(await sha256Hex(canonicalJson({ subject, ...query }))).slice(0, 32)}`;
    const nowSeconds = Math.floor(now() / 1000);
    let row = liveRow(
      await kv.get(CREDENTIALS_KV_NAMESPACE, rowKey),
      nowSeconds,
    );

    if (!row) {
      await deps.memo.ensure(
        worker,
        ready.cfg.credentials.url,
        {
          did: ready.cfg.oracleDid,
          name: oracle.name,
          ...(oracle.description ? { description: oracle.description } : {}),
        },
        { purpose: input.purpose, ...query, issuers: input.catalogIssuers },
      );
      const checkId = randomToken(16);
      const expiresAt = nowSeconds + CHECK_REQUEST_TTL_SECONDS;
      const keys = await newResponseKeys();
      const kid = keys.publicJwk.kid;
      if (!kid) throw new Error('The response key has no kid');
      // The token names the answer key, so the endpoint stores nothing
      // that is not an answer encrypted to it.
      const token = await sealResponseToken(
        { ownerDid: subject, checkId, expiresAt, kid },
        { serviceKey: ready.cfg.serviceKey, oracleDid: ready.cfg.oracleDid },
      );
      const built = await buildCredentialRequest({
        verifier: input.verifier,
        oracleDid: ready.cfg.oracleDid,
        sign: input.sign,
        responseUri: `${input.publicUrl}/${RESPONSE_ROUTE_PREFIX}/${token}`,
        query,
        expiresAt,
        keys,
      });
      const fresh: CheckRow = {
        v: 1,
        checkId,
        expiresAt,
        subject,
        query,
        requestJwt: built.requestJwt,
        privateJwk: built.privateJwk,
      };
      const idleTtlMs = CHECK_REQUEST_TTL_SECONDS * 1000 + 60_000;
      // The inbox opens before the request is visible anywhere.
      await openPluginInbox(kv, CREDENTIALS_KV_NAMESPACE, inboxKeyOf(checkId), {
        expiresAt: expiresAt * 1000,
      });
      // Two calls at once for the same check: the first row wins.
      const stored = liveRow(
        await kv.update(
          CREDENTIALS_KV_NAMESPACE,
          rowKey,
          (current) => liveRow(current, nowSeconds) ?? fresh,
          { idleTtlMs },
        ),
        nowSeconds,
      );
      if (stored && stored.checkId !== checkId) {
        await kv.delete(CREDENTIALS_KV_NAMESPACE, inboxKeyOf(checkId));
        row = stored;
      } else {
        try {
          const deposited = await worker.deposit({
            subject,
            ref: checkId,
            request: built.requestJwt,
            purpose: input.purpose,
            expiresAt,
          });
          row = {
            ...fresh,
            requestId: deposited.id,
            ...(deposited.wallet_url
              ? { walletUrl: deposited.wallet_url }
              : {}),
          };
          await kv.set(CREDENTIALS_KV_NAMESPACE, rowKey, row, { idleTtlMs });
        } catch (error) {
          // Nobody can answer a request that was not deposited.
          await kv.delete(CREDENTIALS_KV_NAMESPACE, rowKey);
          await kv.delete(CREDENTIALS_KV_NAMESPACE, inboxKeyOf(checkId));
          throw error;
        }
      }
    }

    const active: CheckRow = row;
    const finish = async (
      result: CheckOutcome['result'] | 'none',
      claims?: Record<string, unknown>,
    ) => {
      await kv.delete(CREDENTIALS_KV_NAMESPACE, rowKey);
      await kv.delete(CREDENTIALS_KV_NAMESPACE, inboxKeyOf(active.checkId));
      return {
        result,
        ...(claims ? { claims } : {}),
        ...(active.requestId ? { requestId: active.requestId } : {}),
        message: CHECK_RESULT_MESSAGES[result],
      };
    };

    const deadline = now() + (deps.checkWaitMs ?? CHECK_WAIT_MS);
    const inboxKey = inboxKeyOf(active.checkId);
    let delay = 500;
    // The worker is asked only after the Hub had a moment to answer.
    let lastPoll = now();
    let unavailable = false;
    let answered = false;
    for (;;) {
      const deliveries = await readPluginInbox(
        kv,
        CREDENTIALS_KV_NAMESPACE,
        inboxKey,
      );
      // Answers that do not prove to come from the person leave the inbox,
      // so they never hold a place the real answer needs.
      const rejected: string[] = [];
      for (const body of deliveries) {
        try {
          const outcome = await verifyDelivery({
            verifier: input.verifier,
            body,
            requestJwt: active.requestJwt,
            privateJwk: active.privateJwk,
            subject,
            query,
          });
          if (outcome)
            return finish(
              outcome.result,
              outcome.result === 'valid' ? outcome.claims : undefined,
            );
          rejected.push(body);
        } catch (error) {
          if (!isVerificationUnavailable(error)) throw error;
          // A dependency is down: this one stays and is tried again on
          // the next pass.
          unavailable = true;
        }
      }
      await dropFromPluginInbox(
        kv,
        CREDENTIALS_KV_NAMESPACE,
        inboxKey,
        rejected,
      );
      if (active.requestId && now() - lastPoll >= WORKER_POLL_MS) {
        lastPoll = now();
        const view = await worker.requestStatus(active.requestId);
        if (
          view.status === 'declined' ||
          view.status === 'cancelled' ||
          view.status === 'expired'
        )
          return finish('none');
        answered = view.status === 'answered';
      }
      if (now() >= deadline) break;
      await sleep(Math.min(delay, Math.max(0, deadline - now())));
      delay = Math.min(Math.round(delay * 1.6), 3_000);
    }
    if (unavailable)
      return { error: 'verification_unavailable', message: MESSAGES.busy };
    if (answered) {
      // Answered at the worker, but no answer from the person reached the
      // response endpoint: this request cannot be answered again, so it is
      // closed here and the next call starts a new one.
      await finish('none');
      return { error: 'answer_lost', message: MESSAGES.busy };
    }
    const walletUrl = active.requestId
      ? walletUrlOf(cfg, active.requestId, active.walletUrl)
      : `${cfg.hub.url}/credentials`;
    return {
      result: 'pending',
      ...(active.requestId ? { requestId: active.requestId } : {}),
      walletUrl,
      message: `They need to answer in their IXO wallet: ${walletUrl}`,
    };
  }

  const requestActionPermission = tool(
    async (raw, ctx) => {
      const ready = readiness(ctx, cfg);
      if (isRefusal(ready)) return ready;
      const kv = kvOf(ctx);
      if (!kv)
        return { error: 'not_available', message: MESSAGES.notAvailable };
      const args = ActionPermissionInput.parse(raw);
      try {
        const card = await hubClient(ctx, ready, deps).request({
          ...ready.binding,
          requestKey: await requestKeyOf(
            ctx,
            `action-permission:${args.action}`,
          ),
          expiresAt: Math.floor(now() / 1000) + PERMISSION_CARD_TTL_SECONDS,
          permission: {
            kind: 'service-action',
            action: args.action,
            ...(args.days !== undefined ? { days: args.days } : {}),
          },
        });
        await kv.set(
          CREDENTIALS_KV_NAMESPACE,
          actionKey(args.action),
          { permissionId: card.id },
          // As long as the longest grant the card can carry, plus its day.
          { idleTtlMs: 32 * 24 * 3600 * 1000 },
        );
        return {
          status: 'sent',
          permissionId: card.id,
          url: card.url,
          expiresAt: card.expiresAt,
          message: linkMessage(oracle.name, card.url),
        };
      } catch (error) {
        return failed(ctx, 'credentials_request_action_permission', error);
      }
    },
    {
      name: 'credentials_request_action_permission',
      description: [
        'Ask the person for permission to use a catalogued service on their behalf. Today: "self.identity-check" (Self may create a link for them to start an identity check).',
        "They get a card in the IXO wallet showing who asks, the action, the service, what it allows and how long; they tap Allow or Don't allow.",
        'Send the returned url as one link in a short message (the `message` is ready to send); never paste ids or tokens. Once they allow it, call credentials_request_action.',
        'WhatsApp only.',
      ].join(' '),
      schema: ActionPermissionInput,
    },
  );

  /** The allowed grants of an action's card, or the refusal to answer. */
  async function allowedGrants(
    ctx: RuntimeContext,
    ready: Ready,
    kv: UserKvSurface,
    action: SupportedAction,
  ): Promise<PermissionGrant[] | CredentialsRefusal> {
    const record = ActionRecord.safeParse(
      await kv.get(CREDENTIALS_KV_NAMESPACE, actionKey(action)),
    );
    if (!record.success)
      return { error: 'no_permission', message: MESSAGES.noPermission };
    const state = await hubClient(ctx, ready, deps).status(
      record.data.permissionId,
    );
    if (state.status === 'pending')
      return {
        error: 'permission_pending',
        message: MESSAGES.permissionPending,
      };
    const nowSeconds = Math.floor(now() / 1000);
    const grants = (state.grants ?? []).filter((g) => g.expiresAt > nowSeconds);
    if (state.status !== 'allowed' || grants.length === 0) {
      await kv.delete(CREDENTIALS_KV_NAMESPACE, actionKey(action));
      return {
        error: 'permission_ended',
        message:
          state.status === 'declined'
            ? STATUS_MESSAGES.declined
            : MESSAGES.permissionEnded,
      };
    }
    return grants;
  }

  /** The grant with this catalogue id (`link`, `offer`), else the one with this capability. */
  function grantFor(
    grants: PermissionGrant[],
    id: 'link' | 'offer',
    capability: { can: string; with: string },
  ): PermissionGrant | undefined {
    return (
      grants.find((g) => g.id === id) ??
      grants.find((g) => g.can === capability.can && g.with === capability.with)
    );
  }

  const requestAction = tool(
    async (raw, ctx) => {
      const ready = readiness(ctx, cfg);
      if (isRefusal(ready)) return ready;
      const kv = kvOf(ctx);
      if (!kv)
        return { error: 'not_available', message: MESSAGES.notAvailable };
      const args = ActionInput.parse(raw);
      try {
        const grants = await allowedGrants(ctx, ready, kv, args.action);
        if (!Array.isArray(grants)) return grants;
        const link = grantFor(grants, 'link', LINK_CAPABILITY);
        const offer = grantFor(grants, 'offer', {
          can: 'credentials/offer',
          with: 'ixo:credentials',
        });
        if (!link || !offer) {
          ctx.logger.warn('[credentials] the allowed card lacks a grant');
          return { error: 'internal_error', message: MESSAGES.ourSide };
        }
        const created = await selfClient(ctx, ready, deps, link).createLink({
          offerConsent: offer.token,
          requestKey: await requestKeyOf(ctx, `action:${args.action}`),
        });
        const ends = shortTime(created.expiresAt, ctx.user.timezone);
        return {
          status: 'sent',
          url: created.url,
          linkId: created.linkId,
          expiresAt: created.expiresAt,
          message: `Tap this link to start your identity check. It works once and ends at ${ends}: ${created.url}`,
        };
      } catch (error) {
        // One open link per person: the open one is reused, not a failure.
        // Self keeps only a hash of its token, so its URL cannot be sent
        // again; the person uses the link they already have.
        const open = openLinkOf(error);
        if (open) {
          const ends = shortTime(open.expiresAt, ctx.user.timezone);
          return {
            status: 'already_open',
            linkId: open.linkId,
            linkStatus: open.status,
            expiresAt: open.expiresAt,
            message: `A link is already open; it ends at ${ends}. Please use the link you already have.`,
          };
        }
        return failed(ctx, 'credentials_request_action', error);
      }
    },
    {
      name: 'credentials_request_action',
      description: [
        'Carry out a catalogued action the person allowed with credentials_request_action_permission. For "self.identity-check" it asks Self for a link where they start an identity check (one open link at a time; it works once and ends after about 15 minutes; the first device that opens it keeps it).',
        'Send the url as one link in a short message (the `message` is ready to send). Keep the linkId to read progress with credentials_action_status. status "already_open": a link they already have is still open (its URL cannot be sent again); relay the message and read its progress with that linkId.',
        'If they have not allowed it yet the answer says so: ask for permission first. WhatsApp only.',
      ].join(' '),
      schema: ActionInput,
    },
  );

  /** The open link Self named in a 409 `link_active`, when it named one. */
  function openLinkOf(
    error: unknown,
  ): { linkId: string; status: LinkStatus; expiresAt: number } | null {
    if (
      !(error instanceof CredentialsServiceError) ||
      error.service !== 'self' ||
      error.code !== 'link_active'
    )
      return null;
    const parsed = OpenLink.safeParse(error.body);
    return parsed.success ? parsed.data : null;
  }

  const LINK_MESSAGES: Record<LinkStatus, string> = {
    sent: "They haven't opened the link yet.",
    opened: 'They opened the link.',
    in_progress: "They're doing the identity check now.",
    passed: 'They passed the identity check and saved their credential.',
    failed: "The identity check didn't pass.",
    expired: 'The link ended before it was used.',
    cancelled: 'The link was cancelled.',
  };

  const actionStatus = tool(
    async (raw, ctx) => {
      const ready = readiness(ctx, cfg);
      if (isRefusal(ready)) return ready;
      const kv = kvOf(ctx);
      if (!kv)
        return { error: 'not_available', message: MESSAGES.notAvailable };
      const args = ActionStatusInput.parse(raw);
      try {
        const grants = await allowedGrants(ctx, ready, kv, args.action);
        if (!Array.isArray(grants)) return grants;
        const link = grantFor(grants, 'link', LINK_CAPABILITY);
        if (!link)
          return { error: 'internal_error', message: MESSAGES.ourSide };
        const state = await selfClient(ctx, ready, deps, link).linkStatus(
          args.ref,
        );
        return {
          linkId: state.linkId,
          status: state.status,
          updatedAt: state.updatedAt,
          expiresAt: state.expiresAt,
          message: LINK_MESSAGES[state.status],
        };
      } catch (error) {
        return failed(ctx, 'credentials_action_status', error);
      }
    },
    {
      name: 'credentials_action_status',
      description:
        'Read the progress of an action credentials_request_action started: for "self.identity-check" pass the linkId as ref (sent, opened, in_progress, passed, failed, expired, cancelled). No personal data comes back. Only call it when you need the answer; do not poll in a loop. WhatsApp only.',
      schema: ActionStatusInput,
      effect: 'read',
    },
  );

  return [
    requestCheckPermission,
    permissionStatus,
    check,
    requestActionPermission,
    requestAction,
    actionStatus,
  ];
}

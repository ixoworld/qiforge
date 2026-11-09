import { z } from 'zod';
import { tool } from '../../plugin-api/tool-helper';
import type {
  PluginTool,
  RuntimeContext,
  UserKvSurface,
} from '../../plugin-api/types';
import {
  checkIdleTtlMs,
  CREDENTIALS_KV_NAMESPACE,
  checkKey,
  deleteCheck,
  openKey,
  pruneEndedChecks,
  readCheck,
  readResult,
  saveCheck,
  type CheckRow,
} from './check-store';
import {
  DID_PATTERN,
  MAX_ISSUERS_PER_TYPE,
  purposeFor,
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
  refusal,
  refusalFor,
  shortTime,
  type CredentialsRefusal,
  type Wording,
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
  chargeLinkStatus,
  clearGrantsCache,
  knowsPermission,
  readGrantsCache,
  readLinkCache,
  recordPermission,
  writeGrantsCache,
  writeLinkCache,
} from './person-state';
import { RESPONSE_ROUTE_PREFIX, sealResponseToken } from './response-route';
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
  VerifierSetupError,
  type CheckOutcome,
  type CredentialQuery,
  type OracleJwsSigner,
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

/**
 * No `purpose`: why the oracle asks is the operator's fixed wording per
 * credential type (`purposeFor`), never text the model writes.
 */
export const CheckInput = z
  .object({
    vct: Vct,
    issuers: Issuers.describe(
      'Optional: fewer issuers than this service accepts for the type. Leave it out to use them all.',
    ),
    claims: Claims.default([]).describe(
      'The fields you need to see, as few as possible (empty = only that they hold one).',
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
  /**
   * The whole deadline of `credentials_check`, in ms (default 25 s): setup,
   * the calls and the wait for the answer all fit in it.
   */
  checkWaitMs?: number;
}

/** A card lives at most a day on the Hub; a little less, for clock skew. */
export const PERMISSION_CARD_TTL_SECONDS = 24 * 3600 - 300;
/** A presentation request of `credentials_check` lives 15 minutes. */
export const CHECK_REQUEST_TTL_SECONDS = 15 * 60;
/** One deadline per tool: every call it makes ends inside it. */
export const TOOL_DEADLINE_MS = 25_000;
export const CHECK_WAIT_MS = TOOL_DEADLINE_MS;
/** How often the worker is asked for the request's status while waiting. */
const WORKER_POLL_MS = 4_000;
/** As long as the longest grant a card can carry, plus its day. */
const ACTION_RECORD_TTL_MS = 32 * 24 * 3600 * 1000;

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
  if (!binding) return refusal('whatsapp_only', MESSAGES.whatsAppOnly);
  const { serviceKey, oracleDid } = cfg;
  if (!cfg.enabled || !serviceKey || !oracleDid || !ctx.ucan.hasSigningKey())
    return refusal('not_available', MESSAGES.notAvailable);
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

function transport(deps: CredentialsToolsDeps, deadline: number) {
  return {
    deadline,
    ...(deps.now ? { now: deps.now } : {}),
    ...(deps.fetchImpl ? { fetchImpl: deps.fetchImpl } : {}),
    ...(deps.sleep ? { sleep: deps.sleep } : {}),
  };
}

function hubClient(
  ctx: RuntimeContext,
  ready: Ready,
  deps: CredentialsToolsDeps,
  deadline: number,
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
    ...transport(deps, deadline),
  });
}

function workerClient(
  ctx: RuntimeContext,
  ready: Ready,
  deps: CredentialsToolsDeps,
  deadline: number,
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
    ...transport(deps, deadline),
  });
}

function selfClient(
  ctx: RuntimeContext,
  ready: Ready,
  deps: CredentialsToolsDeps,
  linkGrant: PermissionGrant,
  deadline: number,
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
    ...transport(deps, deadline),
  });
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
    return refusal('untrusted_credential', MESSAGES.untrustedCredential);
  const configured = sortedUnique(listed);
  if (asked === undefined) return { issuers: configured, configured };
  const issuers = sortedUnique(asked);
  if (issuers.some((did) => !configured.includes(did)))
    return refusal('untrusted_issuer', MESSAGES.untrustedIssuer);
  return { issuers, configured };
}

/** The refusal for a failure, logged without any personal detail. */
function failed(
  ctx: RuntimeContext,
  tool: string,
  error: unknown,
): CredentialsRefusal {
  const result = refusalFor(error, {
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
  return result;
}

function kvOf(ctx: RuntimeContext): UserKvSurface | null {
  return ctx.kv ?? null;
}

/** A tool answer: the person's sentence (`message`) and the agent's (`hint`). */
function said(wording: Wording, extra: Record<string, unknown> = {}) {
  return {
    ...extra,
    message: wording.message,
    ...(wording.hint ? { hint: wording.hint } : {}),
  };
}

// ---------------------------------------------------------------------------
// Permission cards.

const STATUS_WORDING: Record<PermissionStatus, Wording> = {
  pending: {
    message: "You haven't answered yet.",
    hint: "They haven't answered the card; wait for them, do not ask again or poll.",
  },
  allowed: {
    message: 'Thanks, you allowed it.',
    hint: 'Go on with the task.',
  },
  declined: MESSAGES.declined,
  expired: {
    message: 'The request ended before you answered.',
    hint: 'Ask again only if they still want this.',
  },
  stopped: {
    message: 'You stopped this permission.',
    hint: 'Respect it; ask again only if they bring it up.',
  },
};

function cardMessage(name: string, url: string): Wording {
  return {
    message: `Tap this link to see what ${name} is asking and choose Allow or Don't allow: ${url}`,
    hint: 'Send `message` as it is, as one link in a short message. Never paste ids or tokens.',
  };
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
// credentials_check.

const CHECK_WORDING: Record<CheckOutcome['result'] | 'none', Wording> = {
  valid: {
    message: 'Thanks, your credential checks out.',
    hint: 'Use only the fields you asked for, for this task.',
  },
  invalid: {
    message: "Your credential didn't pass the check.",
    hint: 'It was not accepted; do not retry the same request.',
  },
  revoked: {
    message: 'Your credential has been revoked by its issuer.',
    hint: 'It cannot be used; do not retry.',
  },
  expired: {
    message: 'Your credential has expired.',
    hint: 'It cannot be used until it is renewed.',
  },
  none: {
    message: "You didn't share a credential for this.",
    hint: 'They declined or let it end; ask again only if they want to.',
  },
};

function liveCheck(row: CheckRow | null, nowSeconds: number): CheckRow | null {
  // A request about to end is not reused: a new one gets a full window.
  return row && row.expiresAt > nowSeconds + 60 ? row : null;
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
  const unavailable = () => refusal('not_available', MESSAGES.notAvailable);

  const requestCheckPermission = tool(
    async (raw, ctx) => {
      const ready = readiness(ctx, cfg);
      if (isRefusal(ready)) return ready;
      const kv = kvOf(ctx);
      if (!kv) return unavailable();
      const args = CheckPermissionInput.parse(raw);
      const accepted = acceptedIssuers(cfg, args.vct, args.issuers);
      if ('error' in accepted) return accepted;
      const deadline = now() + TOOL_DEADLINE_MS;
      try {
        const card = await hubClient(ctx, ready, deps, deadline).request({
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
        await recordPermission(kv, card.id);
        return said(cardMessage(oracle.name, card.url), {
          status: 'sent',
          permissionId: card.id,
          url: card.url,
          expiresAt: card.expiresAt,
        });
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
        'Send the `message` (it holds the link) as it is, in a short message. Never paste ids or tokens. Then check the answer with credentials_permission_status, or just call credentials_check once they say they allowed it.',
        'WhatsApp only.',
      ].join(' '),
      schema: CheckPermissionInput,
    },
  );

  const permissionStatus = tool(
    async (raw, ctx) => {
      const ready = readiness(ctx, cfg);
      if (isRefusal(ready)) return ready;
      const kv = kvOf(ctx);
      if (!kv) return unavailable();
      const args = PermissionStatusInput.parse(raw);
      // Only the cards this person was asked: another person's id, or a
      // made-up one, is "not found" without asking the Hub.
      if (!(await knowsPermission(kv, args.permissionId)))
        return refusal('not_found', MESSAGES.notFound);
      const deadline = now() + TOOL_DEADLINE_MS;
      try {
        const state = await hubClient(ctx, ready, deps, deadline).status(
          args.permissionId,
        );
        return said(STATUS_WORDING[state.status], {
          permissionId: state.id,
          status: state.status,
          ...(state.allowedAt ? { allowedAt: state.allowedAt } : {}),
          ...(state.expiresAt ? { expiresAt: state.expiresAt } : {}),
        });
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
      const signer: OracleJwsSigner | undefined =
        ctx.ucan.signJws && ctx.ucan.oraclePublicKey
          ? {
              signJws: ctx.ucan.signJws,
              oraclePublicKey: ctx.ucan.oraclePublicKey,
            }
          : undefined;
      if (!kv || !signer || !deps.verifier || !cfg.publicUrl)
        return unavailable();
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
          signer,
          verifier: deps.verifier,
          publicUrl: cfg.publicUrl,
          query,
          catalogIssuers: accepted.configured,
          purpose: purposeFor(cfg, args.vct),
        });
      } catch (error) {
        if (error instanceof VerifierSetupError) {
          ctx.logger.warn(`[credentials] credentials_check: ${error.code}`);
          return unavailable();
        }
        if (isVerificationUnavailable(error))
          return refusal('verification_unavailable', MESSAGES.busy);
        return failed(ctx, 'credentials_check', error);
      }
    },
    {
      name: 'credentials_check',
      description: [
        "Check one of the person's credentials: give the credential type (vct) and the fields you need (the accepted issuers are configured; you may only narrow them). It asks their IXO wallet, waits up to about 25 seconds and verifies the answer. Why you ask is fixed wording; you do not write it.",
        acceptedTypes,
        'result: valid (claims holds only the fields you asked for), invalid, revoked, expired, none (they did not share one) or pending (no standing permission answered: send them the `message`, which holds their wallet link, or ask for standing permission first with credentials_request_check_permission).',
        'Calling it again with the same fields continues the same request; it does not ask twice. Never quote the claims back beyond what the conversation needs. WhatsApp only.',
      ].join(' '),
      schema: CheckInput,
    },
  );

  async function runCheck(input: {
    ctx: RuntimeContext;
    ready: Ready;
    kv: UserKvSurface;
    signer: OracleJwsSigner;
    verifier: VerifierContext;
    publicUrl: string;
    query: CredentialQuery;
    /** Every issuer the oracle accepts for the type (its catalog entry lists them). */
    catalogIssuers: string[];
    purpose: string;
  }) {
    const { ctx, ready, kv, query } = input;
    const start = now();
    // One deadline: the setup, every call and the wait all end inside it.
    const deadline = start + (deps.checkWaitMs ?? CHECK_WAIT_MS);
    const worker = workerClient(ctx, ready, deps, deadline);
    const subject = ctx.user.did;
    const queryHash = (
      await sha256Hex(canonicalJson({ subject, ...query }))
    ).slice(0, 32);
    const nowSeconds = Math.floor(start / 1000);

    // Rows of checks that have ended go now, not at the next flush.
    await pruneEndedChecks(kv, nowSeconds).catch(() => undefined);

    const openId = await kv.get(CREDENTIALS_KV_NAMESPACE, openKey(queryHash));
    let row =
      typeof openId === 'string'
        ? liveCheck(await readCheck(kv, openId), nowSeconds)
        : null;
    if (row && row.subject !== subject) row = null;

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
        signer: input.signer,
        responseUri: `${input.publicUrl}/${RESPONSE_ROUTE_PREFIX}/${token}`,
        query,
        expiresAt,
        keys,
      });
      const fresh: CheckRow = {
        v: 1,
        checkId,
        queryHash,
        expiresAt,
        subject,
        query,
        requestJwt: built.requestJwt,
        privateJwk: built.privateJwk,
      };
      // The row exists before the request is visible anywhere.
      await saveCheck(kv, fresh, start);
      // Two calls at once for the same check: the first one wins.
      if (typeof openId === 'string')
        await kv.delete(CREDENTIALS_KV_NAMESPACE, openKey(queryHash));
      const winner = await kv.update(
        CREDENTIALS_KV_NAMESPACE,
        openKey(queryHash),
        (current) => (typeof current === 'string' ? current : checkId),
        { idleTtlMs: checkIdleTtlMs(expiresAt, start) },
      );
      if (winner !== checkId) {
        await deleteCheck(kv, fresh);
        const theirs =
          typeof winner === 'string' ? await readCheck(kv, winner) : null;
        if (!theirs) throw new Error('The open check has no row');
        row = theirs;
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
          await kv.set(CREDENTIALS_KV_NAMESPACE, checkKey(checkId), row, {
            idleTtlMs: checkIdleTtlMs(expiresAt, start),
          });
        } catch (error) {
          // Nobody can answer a request that was not deposited.
          await deleteCheck(kv, fresh);
          throw error;
        }
      }
    }

    const active: CheckRow = row;
    const finish = async (
      result: CheckOutcome['result'] | 'none',
      claims?: Record<string, unknown>,
    ) => {
      await deleteCheck(kv, active);
      return said(CHECK_WORDING[result], {
        result,
        ...(claims ? { claims } : {}),
        ...(active.requestId ? { requestId: active.requestId } : {}),
      });
    };

    let delay = 500;
    // The worker is asked only after the Hub had a moment to answer.
    let lastPoll = now();
    let answered = false;
    for (;;) {
      // The verified answer: the person's object stored it (and only it).
      const outcome = await readResult(kv, active.checkId);
      if (outcome)
        return finish(
          outcome.result,
          outcome.result === 'valid' ? outcome.claims : undefined,
        );
      if (active.requestId && now() - lastPoll >= WORKER_POLL_MS) {
        lastPoll = now();
        try {
          const view = await worker.requestStatus(active.requestId);
          if (
            view.status === 'declined' ||
            view.status === 'cancelled' ||
            view.status === 'expired'
          )
            return finish('none');
          answered = view.status === 'answered';
        } catch {
          // The worker did not answer this time: keep waiting.
        }
      }
      if (now() >= deadline) break;
      await sleep(Math.min(delay, Math.max(0, deadline - now())));
      delay = Math.min(Math.round(delay * 1.6), 3_000);
    }
    if (answered) {
      // Answered at the worker, but no verified answer from the person
      // reached the response endpoint: this request cannot be answered
      // again, so it is closed here and the next call starts a new one.
      await finish('none');
      return refusal('answer_lost', MESSAGES.busy);
    }
    const walletUrl = active.requestId
      ? walletUrlOf(cfg, active.requestId, active.walletUrl)
      : `${cfg.hub.url}/credentials`;
    return {
      result: 'pending',
      ...(active.requestId ? { requestId: active.requestId } : {}),
      walletUrl,
      message: `Please answer in your IXO wallet: ${walletUrl}`,
      hint: 'No standing permission answered. Send `message` as it is, or ask for standing permission with credentials_request_check_permission; then call again with the same fields to continue this request.',
    };
  }

  const requestActionPermission = tool(
    async (raw, ctx) => {
      const ready = readiness(ctx, cfg);
      if (isRefusal(ready)) return ready;
      const kv = kvOf(ctx);
      if (!kv) return unavailable();
      const args = ActionPermissionInput.parse(raw);
      const deadline = now() + TOOL_DEADLINE_MS;
      try {
        const card = await hubClient(ctx, ready, deps, deadline).request({
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
          { idleTtlMs: ACTION_RECORD_TTL_MS },
        );
        // Grants kept for an earlier card are not this card's.
        await clearGrantsCache(kv, args.action);
        await recordPermission(kv, card.id);
        return said(cardMessage(oracle.name, card.url), {
          status: 'sent',
          permissionId: card.id,
          url: card.url,
          expiresAt: card.expiresAt,
        });
      } catch (error) {
        return failed(ctx, 'credentials_request_action_permission', error);
      }
    },
    {
      name: 'credentials_request_action_permission',
      description: [
        'Ask the person for permission to use a catalogued service on their behalf. Today: "self.identity-check" (Self may create a link for them to start an identity check).',
        "They get a card in the IXO wallet showing who asks, the action, the service, what it allows and how long; they tap Allow or Don't allow.",
        'Send the `message` (it holds the link) as it is, in a short message; never paste ids or tokens. Once they allow it, call credentials_request_action.',
        'WhatsApp only.',
      ].join(' '),
      schema: ActionPermissionInput,
    },
  );

  /**
   * The allowed grants of an action's card, or the refusal to answer. They
   * are kept in the person's kv until the earliest ends, so a repeat call
   * does not ask the Hub again; `fresh` skips that copy (Self refused it).
   */
  async function allowedGrants(
    ctx: RuntimeContext,
    ready: Ready,
    kv: UserKvSurface,
    action: SupportedAction,
    deadline: number,
    fresh: boolean,
  ): Promise<
    { grants: PermissionGrant[]; cached: boolean } | CredentialsRefusal
  > {
    const record = ActionRecord.safeParse(
      await kv.get(CREDENTIALS_KV_NAMESPACE, actionKey(action)),
    );
    if (!record.success) return refusal('no_permission', MESSAGES.noPermission);
    const { permissionId } = record.data;
    if (!fresh) {
      const kept = await readGrantsCache(
        kv,
        action,
        permissionId,
        Math.floor(now() / 1000),
      );
      if (kept) return { grants: kept, cached: true };
    }
    const state = await hubClient(ctx, ready, deps, deadline).status(
      permissionId,
    );
    if (state.status === 'pending')
      return refusal('permission_pending', MESSAGES.permissionPending);
    const grants = (state.grants ?? []).filter(
      (g) => g.expiresAt > Math.floor(now() / 1000),
    );
    if (state.status !== 'allowed' || grants.length === 0) {
      await kv.delete(CREDENTIALS_KV_NAMESPACE, actionKey(action));
      await clearGrantsCache(kv, action);
      return refusal(
        'permission_ended',
        state.status === 'declined'
          ? MESSAGES.declined
          : MESSAGES.permissionEnded,
      );
    }
    await writeGrantsCache(kv, action, permissionId, grants, now());
    return { grants, cached: false };
  }

  /**
   * Run `run` with the action's grants. When Self refuses kept grants (401 or
   * 403: the person stopped the permission, or it ended), they are dropped,
   * fetched again from the Hub, and `run` is tried once more.
   */
  async function withGrants<T>(
    ctx: RuntimeContext,
    ready: Ready,
    kv: UserKvSurface,
    action: SupportedAction,
    deadline: number,
    run: (grants: PermissionGrant[]) => Promise<T>,
  ): Promise<T | CredentialsRefusal> {
    const first = await allowedGrants(ctx, ready, kv, action, deadline, false);
    if ('error' in first) return first;
    try {
      return await run(first.grants);
    } catch (error) {
      const refused =
        error instanceof CredentialsServiceError &&
        error.service === 'self' &&
        (error.status === 401 || error.status === 403);
      if (!first.cached || !refused) throw error;
    }
    await clearGrantsCache(kv, action);
    const second = await allowedGrants(ctx, ready, kv, action, deadline, true);
    if ('error' in second) return second;
    return run(second.grants);
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
      if (!kv) return unavailable();
      const args = ActionInput.parse(raw);
      const deadline = now() + TOOL_DEADLINE_MS;
      const requestKey = await requestKeyOf(ctx, `action:${args.action}`);
      try {
        return await withGrants(
          ctx,
          ready,
          kv,
          args.action,
          deadline,
          async (grants) => {
            const link = grantFor(grants, 'link', LINK_CAPABILITY);
            const offer = grantFor(grants, 'offer', {
              can: 'credentials/offer',
              with: 'ixo:credentials',
            });
            if (!link || !offer) {
              ctx.logger.warn('[credentials] the allowed card lacks a grant');
              return refusal('internal_error', MESSAGES.ourSide);
            }
            const created = await selfClient(
              ctx,
              ready,
              deps,
              link,
              deadline,
            ).createLink({ offerConsent: offer.token, requestKey });
            const ends = shortTime(created.expiresAt, ctx.user.timezone);
            return said(
              {
                message: `Tap this link to start your identity check. It works once and ends at ${ends}: ${created.url}`,
                hint: 'Send `message` as it is. Keep the linkId to read progress. A new link replaces one nobody has opened yet, so do not call this again to resend.',
              },
              {
                status: 'sent',
                url: created.url,
                linkId: created.linkId,
                expiresAt: created.expiresAt,
              },
            );
          },
        );
      } catch (error) {
        // Self refuses a new link only while a check is in progress: that
        // one is continued, not a failure. Self keeps only a hash of its
        // token, so its URL cannot be sent again.
        const open = openLinkOf(error);
        if (open) {
          const ends = shortTime(open.expiresAt, ctx.user.timezone);
          return said(
            {
              message: `Your identity check is already in progress; it ends at ${ends}. Please carry on with it.`,
              hint: 'Its link cannot be sent again; read progress with this linkId.',
            },
            {
              status: 'already_open',
              linkId: open.linkId,
              linkStatus: open.status,
              expiresAt: open.expiresAt,
            },
          );
        }
        return failed(ctx, 'credentials_request_action', error);
      }
    },
    {
      name: 'credentials_request_action',
      description: [
        'Carry out a catalogued action the person allowed with credentials_request_action_permission. For "self.identity-check" it asks Self for a link where they start an identity check (it works once and ends after about 15 minutes; the first device that opens it keeps it).',
        'Send the `message` (it holds the link) as it is. Keep the linkId to read progress with credentials_action_status. A new call replaces a link nobody has opened yet (the old one stops working), so call it again only when they need a new link. status "already_open": their check is in progress; relay the message and read progress with that linkId.',
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

  const LINK_WORDING: Record<LinkStatus, Wording> = {
    sent: {
      message: "You haven't opened the link yet.",
      hint: 'Wait for them; do not poll.',
    },
    opened: {
      message: 'You opened the link.',
      hint: 'Wait for them to go on; do not poll.',
    },
    in_progress: {
      message: "You're doing the identity check now.",
      hint: 'Wait for them to finish; do not poll.',
    },
    passed: {
      message: 'You passed the identity check and saved your credential.',
      hint: 'Go on with the task; credentials_check can now prove it.',
    },
    failed: {
      message: "The identity check didn't pass.",
      hint: 'Offer a new link only if they want to try again.',
    },
    expired: {
      message: 'The link ended before it was used.',
      hint: 'Offer a new link only if they still want the check.',
    },
    cancelled: {
      message: 'The link was cancelled.',
      hint: 'Offer a new link only if they still want the check.',
    },
  };

  const WAIT_WORDING: Wording = {
    message: "There's nothing new yet. Please give it a little while.",
    hint: 'You asked about this link too often (at most 6 a minute). Do not poll; wait for the person to say how it went.',
  };

  const actionStatus = tool(
    async (raw, ctx) => {
      const ready = readiness(ctx, cfg);
      if (isRefusal(ready)) return ready;
      const kv = kvOf(ctx);
      if (!kv) return unavailable();
      const args = ActionStatusInput.parse(raw);
      const stateAnswer = (state: {
        linkId: string;
        status: LinkStatus;
        updatedAt: number;
        expiresAt: number;
      }) =>
        said(LINK_WORDING[state.status], {
          linkId: state.linkId,
          status: state.status,
          updatedAt: state.updatedAt,
          expiresAt: state.expiresAt,
        });
      try {
        // At most 6 calls a minute per link; the status read last is kept
        // 5 s (a final one for good), so most calls never reach Self.
        const allowed = await chargeLinkStatus(kv, args.ref, now());
        const kept = await readLinkCache(kv, args.ref, now());
        if (!allowed)
          return kept
            ? stateAnswer(kept)
            : refusal('rate_limited', WAIT_WORDING);
        if (kept) return stateAnswer(kept);
        const deadline = now() + TOOL_DEADLINE_MS;
        const answer = await withGrants(
          ctx,
          ready,
          kv,
          args.action,
          deadline,
          async (grants) => {
            const link = grantFor(grants, 'link', LINK_CAPABILITY);
            if (!link) return refusal('internal_error', MESSAGES.ourSide);
            return selfClient(ctx, ready, deps, link, deadline).linkStatus(
              args.ref,
            );
          },
        );
        if ('error' in answer) return answer;
        await writeLinkCache(kv, answer, now());
        return stateAnswer(answer);
      } catch (error) {
        return failed(ctx, 'credentials_action_status', error);
      }
    },
    {
      name: 'credentials_action_status',
      description:
        'Read the progress of an action credentials_request_action started: for "self.identity-check" pass the linkId as ref (sent, opened, in_progress, passed, failed, expired, cancelled). No personal data comes back. Only call it when you need the answer; do not poll in a loop (at most 6 a minute per link; an answer is kept 5 seconds). WhatsApp only.',
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

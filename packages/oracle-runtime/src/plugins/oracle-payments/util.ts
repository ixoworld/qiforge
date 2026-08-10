import { z } from 'zod';
import type { CommerceRoutedService } from '../../modules/messages/commerce-router-port.js';
import type {
  CommerceEngagement,
  MergedConfig,
} from '../../plugin-api/types.js';
import type { ClaimNetwork } from './claim-lane.js';
import {
  CREDITS_PER_UNIT,
  MICRO_UNITS_PER_CREDIT,
  MICRO_UNITS_PER_UNIT,
  type AgentCardServiceView,
} from './types.js';

/** Just the reservation — everything the expiry helpers need to read. */
type Reserved = Pick<CommerceEngagement, 'intent'>;

/**
 * The engagement's escrow deadline in epoch milliseconds, or `undefined` when
 * the job carries no reservation or an unparseable one. An unknown deadline is
 * deliberately not a passed one: the chain is the authority, and guessing
 * "expired" would close a job whose escrow is still held.
 */
function intentDeadlineMs(engagement: Reserved): number | undefined {
  const expiresAt = engagement.intent?.expiresAt;
  if (expiresAt === undefined) return undefined;
  const deadline = Date.parse(expiresAt);
  return Number.isFinite(deadline) ? deadline : undefined;
}

/**
 * `true` once the escrow reserved for this job has auto-released on-chain.
 *
 * The one predicate for "this engagement is dead", shared by the active-engagement
 * lookup, the contract gate, and both claim lanes — an expired reservation holds
 * nothing, so the job it belongs to must never block a new one and must never be
 * claimed against without being re-reserved first. Three call sites reading the
 * deadline three ways is how a user ends up wedged in work mode.
 */
export function isEngagementExpired(engagement: Reserved, now: Date): boolean {
  const deadline = intentDeadlineMs(engagement);
  return deadline !== undefined && deadline <= now.getTime();
}

/**
 * Convert a USD price to a micro-unit coin in the GRANTED denom — the
 * `authz.maxAmount.denom` the portal named on the contract's spend
 * authorization, never a network guess (uPay spec §5 R1: guessing is how a
 * flipped grant denom fails every job as "max amount too low"). The single
 * conversion for the whole plugin: the gate's `maxAmount` check, the escrow
 * intent locked at engagement start, and the claim amount submitted at
 * delivery or cancellation all price the same service the same way, so the
 * escrow and the claim can never disagree.
 */
export function priceToCoin(
  priceUsd: number,
  denom: string,
): { denom: string; amount: number } {
  return {
    denom,
    amount: Math.round(priceUsd * MICRO_UNITS_PER_UNIT),
  };
}

/**
 * A service price as the credits the user is quoted for it. Card prices are in
 * settlement units (1 PAY = $1); the user never reads either, they read credits.
 */
export function priceToCredits(priceUsd: number): number {
  return Math.round(priceUsd * CREDITS_PER_UNIT);
}

/**
 * A raw micro-unit chain amount as credits, or `undefined` when it is not a
 * number at all. Every denom this lane settles is 6-decimal and $1-pegged (uPay
 * spec §5 R1), so the one scale answers for all of them.
 *
 * Rounds DOWN. The amounts read through here are balances and spend caps, and
 * rounding a cap of 1_999_999 up to "2,000 credits" would tell a user their
 * limit covers a 2,000-credit job it refuses.
 */
export function microUnitsToCredits(
  amount: string | number,
): number | undefined {
  const micro = typeof amount === 'number' ? amount : Number(amount);
  return Number.isFinite(micro)
    ? Math.floor(micro / MICRO_UNITS_PER_CREDIT)
    : undefined;
}

/** Credits as prose: `1 credit`, `500 credits`, `1,500 credits`. */
export function formatCredits(credits: number): string {
  return `${credits.toLocaleString('en-US')} credit${credits === 1 ? '' : 's'}`;
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Rewrite the micro-unit amounts inside a chain message as credits, so a
 * rejection relayed through the agent never reaches the user as
 * `5000000 upay`. The bank module states its arithmetic in the denom it moves
 * ("spendable balance 100000upay is smaller than 20000000upay"), and that
 * sentence is otherwise the most useful thing we can tell the user.
 *
 * Only the denom the job is priced in is rewritten — the one denom whose scale
 * is known here. Anything else is left exactly as the chain wrote it rather
 * than converted by guesswork.
 */
export function creditsInChainText(text: string, denom: string): string {
  if (denom.length === 0) return text;
  const amounts = new RegExp(`(\\d+)\\s*${escapeRegExp(denom)}\\b`, 'gi');
  return text.replace(amounts, (match, digits: string) => {
    const credits = microUnitsToCredits(digits);
    return credits === undefined ? match : formatCredits(credits);
  });
}

/**
 * The granted denom carried on a gate-issued engagement start or stamped on a
 * persisted engagement, or `undefined` when there is none to read. The shared
 * `CommerceEngagementStart`/`CommerceEngagement` types predate the field, so
 * it travels structurally — this is the one reader, and its `undefined` is a
 * fail-closed signal: a job without a granted denom is refused, never priced
 * in a guessed one.
 */
export function grantedDenom(job: {
  priceUsd: number;
  denom?: unknown;
}): string | undefined {
  const denom = job.denom;
  return typeof denom === 'string' && denom.length > 0 ? denom : undefined;
}

/**
 * Read a string env var out of the merged config, or `undefined` if absent.
 * Deliberately silent: most callers read legitimately-optional keys
 * (`EVAL_ENGINE_URL`, `PORTAL_URL`, `SANDBOX_MCP_URL`), so a miss is not an
 * event. The callers for which a key IS required already fail loudly and name
 * it (`requireConfig`), which is where that diagnostic belongs.
 */
export function readConfigString(
  config: MergedConfig,
  key: string,
): string | undefined {
  const value = config[key];
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

/**
 * `NETWORK` narrowed to the three networks the chain lane knows, defaulting to
 * devnet. The one normalization for the whole plugin — the escrow, the claim,
 * and the per-network service URLs below must all read the same network from
 * the same string.
 */
export function claimNetwork(network: string | undefined): ClaimNetwork {
  return network === 'mainnet' || network === 'testnet' ? network : 'devnet';
}

/** Portal deployments, indexed by the network whose claims they render. */
const PORTAL_URLS: Record<ClaimNetwork, string> = {
  devnet: 'https://dev.portal.qi.space',
  testnet: 'https://test.portal.qi.space',
  mainnet: 'https://portal.qi.space',
};

/** Evaluation-engine deployments, indexed by the network they settle on. */
const EVAL_ENGINE_URLS: Record<ClaimNetwork, string> = {
  devnet: 'https://dev.eval.ixo.earth',
  testnet: 'https://test.eval.ixo.earth',
  mainnet: 'https://eval.ixo.earth',
};

/**
 * The portal base URL: the operator's `PORTAL_URL` when set, otherwise the
 * portal deployed for `NETWORK`. Always resolves, so every receipt and payment
 * card carries a claim deep link without the operator configuring anything.
 */
export function resolvePortalUrl(
  portalUrl: string | undefined,
  network: string | undefined,
): string {
  return portalUrl ?? PORTAL_URLS[claimNetwork(network)];
}

/**
 * The evaluation-engine base URL: the operator's `EVAL_ENGINE_URL` when set,
 * otherwise the engine deployed for `NETWORK`. Always resolves — a contract
 * lookup has an engine to reach on every network, and an oracle on devnet never
 * reads mainnet contract records.
 */
export function resolveEvalEngineUrl(
  engineUrl: string | undefined,
  network: string | undefined,
): string {
  return engineUrl ?? EVAL_ENGINE_URLS[claimNetwork(network)];
}

/**
 * The shape of a Matrix HTTP error, as either SDK in the tree reports it:
 * `matrix-js-sdk` (what `MatrixStateManager` uses) carries `httpStatus`,
 * `matrix-bot-sdk` carries `statusCode`, and both carry `errcode`.
 */
const matrixErrorShape = z.object({
  errcode: z.string().optional(),
  httpStatus: z.number().optional(),
  statusCode: z.number().optional(),
});

/**
 * `true` when a Matrix read failed because the thing simply is not there.
 *
 * Structural on purpose. `instanceof MatrixError` cannot answer this: the
 * state manager throws `matrix-js-sdk`'s `MatrixError` while `@ixo/matrix`
 * re-exports `matrix-bot-sdk`'s, so the check is always false in production
 * and every empty read is reported as a failure. Reading `errcode`/status off
 * the error works for either class — and for neither, when the failure is a
 * genuine transport error with no Matrix response at all.
 */
export function isMatrixNotFound(error: unknown): boolean {
  const parsed = matrixErrorShape.safeParse(error);
  if (!parsed.success) return false;
  const { errcode, httpStatus, statusCode } = parsed.data;
  return errcode === 'M_NOT_FOUND' || httpStatus === 404 || statusCode === 404;
}

/**
 * The oracle's own bech32 account address — the `did:ixo:` localpart of its
 * account DID (`did:ixo:ixo1...` → `ixo1...`).
 */
export function oracleAddressFromDid(oracleDid: string): string {
  return oracleDid.startsWith('did:ixo:')
    ? oracleDid.slice('did:ixo:'.length)
    : oracleDid;
}

/**
 * Display currency when a card service omits one: PAY, the platform
 * settlement currency (1 PAY = 1 USD — the only conversion ever shown).
 */
export const DEFAULT_CURRENCY = 'PAY';

/** Shape a card service for the `list_services` component `props.services[]`. */
export function toListServiceProp(
  service: AgentCardServiceView,
): Record<string, unknown> {
  return {
    id: service.id,
    name: service.name,
    ...(service.description !== undefined && {
      description: service.description,
    }),
    price: {
      amount: service.price.amount,
      currency: service.price.currency ?? DEFAULT_CURRENCY,
    },
    deliverables: service.deliverables,
    ...(service.tags !== undefined && { tags: service.tags }),
    ...(service.examples !== undefined && { examples: service.examples }),
  };
}

/** Shape a card service for the `show_contract` component `props.service`. */
export function toContractServiceProp(
  service: AgentCardServiceView,
): Record<string, unknown> {
  return {
    id: service.id,
    name: service.name,
    ...(service.description !== undefined && {
      description: service.description,
    }),
    price: {
      amount: service.price.amount,
      currency: service.price.currency ?? DEFAULT_CURRENCY,
    },
    deliverables: service.deliverables,
    ...(service.doneMeans !== undefined && { doneMeans: service.doneMeans }),
  };
}

/**
 * Reduce a card service to what the router's classifier and the contract gate
 * read. Shared by the port registrar (classification) and `start_work` (an
 * in-turn gate check), so both gate the identical view of a service.
 */
export function toRoutedService(
  service: AgentCardServiceView,
): CommerceRoutedService {
  return {
    id: service.id,
    name: service.name,
    ...(service.description !== undefined && {
      description: service.description,
    }),
    ...(service.tags !== undefined && { tags: service.tags }),
    ...(service.examples !== undefined && { examples: service.examples }),
    priceUsd: service.price.amount,
  };
}

/**
 * A card price as the prose the model quotes and the user reads.
 *
 * Credits whenever the price is in the platform's settlement currency — the one
 * currency whose credit rate is known here. A publisher who priced a service in
 * something else keeps their own words: converting a rate we do not hold would
 * invent a number, and an honest "12 EUR" beats a confident wrong one.
 */
export function servicePriceLabel(price: {
  amount: number;
  currency?: string;
}): string {
  if (price.amount === 0) return 'free';
  const currency = price.currency ?? DEFAULT_CURRENCY;
  return currency === DEFAULT_CURRENCY
    ? formatCredits(priceToCredits(price.amount))
    : `${price.amount} ${currency}`;
}

/** Short plain-text summary of the services, used as the card `body` fallback. */
export function summarizeServices(services: AgentCardServiceView[]): string {
  const parts = services.map(
    (s) => `${s.name} (${servicePriceLabel(s.price)})`,
  );
  return `Services: ${parts.join(', ')}`;
}

/** Read a finite number out of the merged config, or `undefined` if absent/invalid. */
export function readConfigNumber(
  config: MergedConfig,
  key: string,
): number | undefined {
  const value = config[key];
  const parsed = typeof value === 'number' ? value : Number(value);
  return typeof value !== 'undefined' && Number.isFinite(parsed)
    ? parsed
    : undefined;
}

/** Filename-safe slug from free text: `Tax report 2025!` → `tax-report-2025`. */
export function slugify(text: string, maxLength = 60): string {
  const slug = text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, maxLength)
    .replace(/-+$/g, '');
  return slug.length > 0 ? slug : 'deliverable';
}

/**
 * The portal deep link for one claim. Shared by the delivery receipt and the
 * payment-update card so a user always lands on the same claim page. Takes the
 * already-resolved base URL — see {@link resolvePortalUrl}.
 */
export function claimDeepLink(portalUrl: string, claimId: string): string {
  return `${portalUrl.replace(/\/+$/, '')}/workspace/claims?claimId=${encodeURIComponent(claimId)}`;
}

/** Normalize any thrown value to a message string for logging. */
export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export interface RetryOptions {
  /** Total attempts including the first. Default 3. */
  attempts?: number;
  /** Delay before the first retry, doubled for each further one. Default 500ms. */
  delayMs?: number;
  /** Sleep seam — tests pass a resolved promise instead of waiting. */
  sleep?: (ms: number) => Promise<void>;
  /** Called with the failure that triggered a retry, before the wait. */
  onRetry?: (error: unknown, attempt: number) => void;
}

const sleepFor = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });

/**
 * Run `operation`, retrying a THROWN failure with exponential backoff. Bounded
 * and deliberately small: it exists to ride out a transport blip on a chain
 * write, not to mask a rejection. A returned value is never retried — a chain
 * response carrying a non-zero code is a decision, not a blip, and the caller
 * decides what it means.
 */
export async function retry<T>(
  operation: () => Promise<T>,
  options: RetryOptions = {},
): Promise<T> {
  const attempts = options.attempts ?? 3;
  const delayMs = options.delayMs ?? 500;
  const sleep = options.sleep ?? sleepFor;

  let lastError: unknown;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return await operation();
    } catch (error) {
      lastError = error;
      if (attempt === attempts) break;
      options.onRetry?.(error, attempt);
      await sleep(delayMs * 2 ** (attempt - 1));
    }
  }
  throw lastError;
}

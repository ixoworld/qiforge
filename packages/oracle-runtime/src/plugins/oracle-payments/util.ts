import type { MergedConfig } from '../../plugin-api/types.js';
import {
  MAINNET_USDC_IBC_DENOM,
  MICRO_UNITS_PER_UNIT,
  type AgentCardServiceView,
} from './types.js';

/**
 * Convert a USD price to the collection payment denom + micro-unit amount.
 * The single conversion for the whole plugin: the gate's `maxAmount` check, the
 * escrow intent locked at engagement start, and the claim amount submitted at
 * delivery all price the same service the same way, so the escrow and the claim
 * can never disagree.
 */
export function priceToCoin(
  priceUsd: number,
  network: string,
): { denom: string; amount: number } {
  return {
    denom: network === 'mainnet' ? MAINNET_USDC_IBC_DENOM : 'uixo',
    amount: Math.round(priceUsd * MICRO_UNITS_PER_UNIT),
  };
}

/** Read a string env var out of the merged config, or `undefined` if absent. */
export function readConfigString(
  config: MergedConfig,
  key: string,
): string | undefined {
  const value = config[key];
  return typeof value === 'string' && value.length > 0 ? value : undefined;
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

/** Default display currency when a card service omits one. */
const DEFAULT_CURRENCY = 'USDC';

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

/** Short plain-text summary of the services, used as the card `body` fallback. */
export function summarizeServices(services: AgentCardServiceView[]): string {
  const parts = services.map((s) => `${s.name} ($${s.price.amount})`);
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
 * The portal deep link for one claim, or `undefined` when no `PORTAL_URL` is
 * configured. Shared by the delivery receipt and the payment-update card so a
 * user always lands on the same claim page.
 */
export function claimDeepLink(
  portalUrl: string | undefined,
  claimId: string,
): string | undefined {
  return portalUrl
    ? `${portalUrl.replace(/\/+$/, '')}/workspace/claims?claimId=${encodeURIComponent(claimId)}`
    : undefined;
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

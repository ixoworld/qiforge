import { z } from 'zod';
import { isSecureUrl } from '../../artifacts/config';

export type CredentialsNetwork = 'devnet' | 'testnet' | 'mainnet';

/** Auth Hub (permission cards, the person's credentials wallet) per network. */
export const HUB_DEFAULT_URLS: Readonly<Record<CredentialsNetwork, string>> = {
  devnet: 'https://dev.auth.ixo.earth',
  testnet: 'https://test.auth.ixo.earth',
  mainnet: 'https://auth.ixo.earth',
};

/** The Credentials worker (catalog, presentation requests) per network. */
export const CREDENTIALS_DEFAULT_URLS: Readonly<
  Record<CredentialsNetwork, string>
> = {
  devnet: 'https://dev.credentials.ixo.earth',
  testnet: 'https://test.credentials.ixo.earth',
  mainnet: 'https://credentials.ixo.earth',
};

/** Self, the identity oracle (identity-check links) per network. */
export const SELF_DEFAULT_URLS: Readonly<Record<CredentialsNetwork, string>> = {
  devnet: 'https://api.dev.self.ixo.earth',
  testnet: 'https://api.test.self.ixo.earth',
  mainnet: 'https://api.self.ixo.earth',
};

/** The identity credential Self issues. */
export const IDENTITY_LEVEL1_VCT =
  'https://credentials.ixo.world/types/IdentityLevel1';

/** Self's issuer entity per network (the issuer of IdentityLevel1). */
export const SELF_ISSUER_DIDS: Readonly<Record<CredentialsNetwork, string>> = {
  devnet: 'did:ixo:entity:80f392610e8a128b4f4b1ed828dbeb7f',
  testnet: 'did:ixo:entity:f45746b09949bda3808d02439e212dcb',
  mainnet: 'did:ixo:entity:3ea2744791e5b8ce1ddd7d96c9fd27e7',
};

/** A did:ixo or did:web, as the catalog writes them. */
export const DID_PATTERN = /^did:(ixo|web):[A-Za-z0-9._:%-]+$/;
/** Most issuers one credential type may list (the Hub's card takes 1 to 5). */
export const MAX_ISSUERS_PER_TYPE = 5;

/**
 * The issuers this oracle trusts, per credential type: `{ "<vct>": [DIDs] }`.
 * The trust anchor of every check and card: the model can narrow it, never
 * widen it. Given as a JSON string or as an object `vars` entry.
 */
const TrustedIssuers = z.record(
  z.string().url().max(512),
  z
    .array(z.string().max(256).regex(DID_PATTERN))
    .min(1)
    .max(MAX_ISSUERS_PER_TYPE),
);
export type TrustedIssuers = z.infer<typeof TrustedIssuers>;

const trustedIssuersSchema = z.preprocess(
  (value) => jsonOf(value),
  TrustedIssuers,
);

/** The default trust anchor: Self's identity credential on this network. */
export function defaultTrustedIssuers(
  network: CredentialsNetwork,
): TrustedIssuers {
  return { [IDENTITY_LEVEL1_VCT]: [SELF_ISSUER_DIDS[network]] };
}

const jsonOf = (value: unknown) => {
  if (typeof value !== 'string') return value;
  try {
    return JSON.parse(value);
  } catch {
    // Not JSON: the record check refuses it, naming the key.
    return value;
  }
};

/** Operator words per credential type: why the oracle asks (shown in the wallet). */
const Purposes = z.record(
  z.string().url().max(512),
  z.string().min(1).max(140),
);

/**
 * Text that reaches the person's wallet or the public catalog: no links, no
 * markup, no control or invisible characters, one line, at most `max`.
 */
export function plainText(text: string, max = 140): string {
  return (
    text
      .replace(/<[^>]*>/g, ' ')
      .replace(/\b(?:https?|ftp):\/\/\S+/gi, ' ')
      .replace(/\bwww\.\S+/gi, ' ')
      // Control and invisible format characters (zero-width, bidi, BOM).
      .replace(/[\p{Cc}\p{Cf}]/gu, ' ')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, max)
      .trim()
  );
}

/** A readable name for a credential type from its vct (`IdentityLevel1` → `Identity Level 1`). */
export function typeNameOf(vct: string): string {
  let last = '';
  try {
    last = new URL(vct).pathname.split('/').filter(Boolean).pop() ?? '';
  } catch {
    last = '';
  }
  const words = decodeURIComponent(last)
    .replace(/[_-]+/g, ' ')
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .replace(/([A-Za-z])(\d)/g, '$1 $2');
  return plainText(words, 80) || 'credential';
}

const secureUrl = z
  .string()
  .url()
  .refine(isSecureUrl, 'must be https (http only for localhost)');

/**
 * Env the credentials plugin owns. `AUTH_HUB_URL` and
 * `AUTH_HUB_CHANNEL_SERVICE_KEY` are the same keys IXO Channels and Hub
 * actions read from the Worker env: the plugin declares them so they reach
 * its tools through `ctx.config`.
 */
export const credentialsConfigSchema = z.object({
  CREDENTIALS_ENABLED: z.enum(['true', 'false']).default('false'),
  CREDENTIALS_URL: secureUrl.optional(),
  SELF_API_URL: secureUrl.optional(),
  /** Origin of Self's web app, where identity-check links open. */
  SELF_WEB_URL: secureUrl.optional(),
  AUTH_HUB_URL: secureUrl.optional(),
  AUTH_HUB_CHANNEL_SERVICE_KEY: z.string().min(1).optional(),
  /**
   * The issuers accepted per credential type (JSON). Unset: Self's
   * IdentityLevel1 issuer of the oracle's network. When set it is the whole
   * list (the default is not added).
   */
  CREDENTIALS_TRUSTED_ISSUERS: trustedIssuersSchema.optional(),
  /**
   * Why the oracle asks, per credential type (JSON `{ "<vct>": "text" }`,
   * at most 140 characters): the words on the request in the person's
   * wallet and in the catalog. Default "Check your <type name>". Never
   * written by the model.
   */
  CREDENTIALS_PURPOSES: z
    .preprocess((value) => jsonOf(value), Purposes)
    .optional(),
});

/** Base-schema keys the plugin reads but does not own. */
const siblingSchema = z.object({
  NETWORK: z.enum(['mainnet', 'testnet', 'devnet']).optional(),
  ORACLE_DID: z.string().min(1).optional(),
  ORACLE_ENTITY_DID: z.string().min(1).optional(),
  ORACLE_PUBLIC_URL: z.string().optional(),
  BLOCKSYNC_GRAPHQL_URL: z.string().optional(),
});

/** One service the plugin calls: its origin and the did:web it signs UCANs to. */
export interface ServiceEndpoint {
  url: string;
  did: string;
}

export interface CredentialsConfig {
  enabled: boolean;
  network: CredentialsNetwork;
  hub: ServiceEndpoint;
  credentials: ServiceEndpoint;
  self: ServiceEndpoint;
  /** The only origin an identity-check link may be on. */
  selfWebOrigin: string;
  /** The issuers accepted per credential type: the trust anchor. */
  trustedIssuers: TrustedIssuers;
  /** Operator words per credential type (see `purposeFor`). */
  purposes: Record<string, string>;
  /** The oracle account's key for `/api/internal/*` on the Hub; absent = cards off. */
  serviceKey?: string;
  /** The oracle's own DID (`did:ixo:ixo1…`): the UCAN issuer, the verifier DID. */
  oracleDid?: string;
  oracleEntityDid?: string;
  /** The oracle's public origin (the verifier's response endpoint lives there). */
  publicUrl?: string;
  blocksyncUrl?: string;
  /** Local development: localhost response and status-list hosts are allowed. */
  allowLocal: boolean;
}

/**
 * The did:web of a service, from its host (`did:web:<host>`, a port's `:`
 * written `%3A`): the Hub, the Credentials worker and Self each sign as
 * the did:web of the host they are served from.
 */
export function didWebOf(url: string): string {
  const parsed = new URL(url);
  const host = parsed.hostname.toLowerCase();
  return parsed.port ? `did:web:${host}%3A${parsed.port}` : `did:web:${host}`;
}

function endpoint(url: string): ServiceEndpoint {
  const origin = new URL(url).origin;
  return { url: origin, did: didWebOf(origin) };
}

/**
 * Self's web origin: `SELF_WEB_URL`, else Self's API host without its
 * leading `api.` (`api.dev.self.ixo.earth` → `dev.self.ixo.earth`).
 */
function selfWebOriginOf(apiUrl: string, configured?: string): string {
  if (configured) return new URL(configured).origin;
  const api = new URL(apiUrl);
  return `${api.protocol}//${api.host.replace(/^api\./, '')}`;
}

function isLocal(url: string | undefined): boolean {
  if (!url) return false;
  const host = new URL(url).hostname;
  return host === 'localhost' || host === '127.0.0.1';
}

/** Network defaults, overridden per deployment by the env. */
export function resolveCredentialsConfig(config: unknown): CredentialsConfig {
  const own = credentialsConfigSchema.safeParse(config);
  const siblings = siblingSchema.safeParse(config);
  const owned = own.success ? own.data : undefined;
  const base = siblings.success ? siblings.data : undefined;
  const network: CredentialsNetwork = base?.NETWORK ?? 'mainnet';
  const selfUrl = owned?.SELF_API_URL ?? SELF_DEFAULT_URLS[network];
  const publicUrl =
    base?.ORACLE_PUBLIC_URL && isSecureUrl(base.ORACLE_PUBLIC_URL)
      ? new URL(base.ORACLE_PUBLIC_URL).origin
      : undefined;
  return {
    enabled: owned?.CREDENTIALS_ENABLED === 'true',
    network,
    hub: endpoint(owned?.AUTH_HUB_URL ?? HUB_DEFAULT_URLS[network]),
    credentials: endpoint(
      owned?.CREDENTIALS_URL ?? CREDENTIALS_DEFAULT_URLS[network],
    ),
    self: endpoint(selfUrl),
    selfWebOrigin: selfWebOriginOf(selfUrl, owned?.SELF_WEB_URL),
    trustedIssuers:
      owned?.CREDENTIALS_TRUSTED_ISSUERS ?? defaultTrustedIssuers(network),
    purposes: owned?.CREDENTIALS_PURPOSES ?? {},
    ...(owned?.AUTH_HUB_CHANNEL_SERVICE_KEY
      ? { serviceKey: owned.AUTH_HUB_CHANNEL_SERVICE_KEY }
      : {}),
    ...(base?.ORACLE_DID ? { oracleDid: base.ORACLE_DID } : {}),
    ...(base?.ORACLE_ENTITY_DID
      ? { oracleEntityDid: base.ORACLE_ENTITY_DID }
      : {}),
    ...(publicUrl ? { publicUrl } : {}),
    ...(base?.BLOCKSYNC_GRAPHQL_URL
      ? { blocksyncUrl: base.BLOCKSYNC_GRAPHQL_URL }
      : {}),
    allowLocal: isLocal(publicUrl),
  };
}

/**
 * Why the oracle asks for `vct`, as the person reads it in their wallet:
 * the operator's words (`CREDENTIALS_PURPOSES`) or "Check your <type
 * name>", cleaned of links and markup either way. Never model text.
 */
export function purposeFor(
  cfg: Pick<CredentialsConfig, 'purposes'>,
  vct: string,
): string {
  const configured = Object.hasOwn(cfg.purposes, vct)
    ? cfg.purposes[vct]
    : undefined;
  return (
    plainText(configured ?? `Check your ${typeNameOf(vct)}`) ||
    `Check your ${typeNameOf(vct)}`
  );
}

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

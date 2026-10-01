/**
 * Which Matrix homeserver does a user live on?
 *
 * The user↔oracle room alias is `#<user>_<oracle>:<SERVER>` where SERVER is the
 * USER's homeserver, not the oracle's — an oracle on `mx.example` serving a
 * user registered on `devmx.ixo.earth` must look the room up as
 * `#…:devmx.ixo.earth`. The Node runtime reads it per user from the DID
 * document's `MatrixHomeServer` service via Blocksync
 * (`getMatrixHomeServerCroppedForDid`); this is the Workers port, with the
 * same normalisation of the user-supplied `serviceEndpoint`.
 */

export const MATRIX_SERVICE_TYPE = 'MatrixHomeServer';

export interface DidService {
  id?: string;
  type?: string;
  serviceEndpoint?: string;
}

/**
 * On-chain `serviceEndpoint` values are registration-supplied and have been
 * seen with trailing slashes and stray whitespace/CRLF. Strip whitespace, add
 * `https://` to bare domains, drop trailing slashes. "" for empty input.
 */
export function normalizeMatrixHomeServerUrl(
  url: string | null | undefined,
): string {
  if (!url) return '';
  const trimmed = url.replace(/\s+/g, '');
  if (trimmed === '') return '';
  const withProtocol = /^https?:\/\//.test(trimmed)
    ? trimmed
    : `https://${trimmed}`;
  return withProtocol.replace(/\/+$/, '');
}

/** `https://devmx.ixo.earth/` → `devmx.ixo.earth` (the Matrix server name). */
export function extractUrlDomain(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    const cleaned = url.replace(/^https?:\/\//, '');
    return cleaned.split('/')[0] ?? cleaned;
  }
}

/** The server name from a DID document's services, or null when it has none. */
export function matrixServerNameFromServices(
  services: readonly DidService[] | null | undefined,
): string | null {
  const svc = (services ?? []).find((s) => s.type === MATRIX_SERVICE_TYPE);
  const normalized = normalizeMatrixHomeServerUrl(svc?.serviceEndpoint);
  if (!normalized) return null;
  const domain = extractUrlDomain(normalized);
  return domain ? domain.toLowerCase() : null;
}

const IID_SERVICES_QUERY = `
  query UserMatrixHomeServer($id: String!) {
    iids(filter: { id: { equalTo: $id } }) {
      nodes { id service }
    }
  }
`;

/**
 * Resolve a user's Matrix server name from Blocksync. Returns null when the
 * DID is unknown or carries no MatrixHomeServer service; throws on transport
 * failure so callers can decide whether to fall back.
 */
export async function fetchUserMatrixServerName(
  blocksyncGraphqlUrl: string,
  userDid: string,
  fetchImpl: typeof fetch = fetch,
): Promise<string | null> {
  const res = await fetchImpl(blocksyncGraphqlUrl, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      query: IID_SERVICES_QUERY,
      variables: { id: userDid },
    }),
  });
  if (!res.ok) {
    throw new Error(
      `Blocksync ${res.status} resolving MatrixHomeServer for ${userDid}`,
    );
  }
  const raw: unknown = await res.json();
  const body = raw as {
    data?: { iids?: { nodes?: Array<{ id: string; service?: unknown }> } };
    errors?: Array<{ message?: string }>;
  };
  if (body.errors?.length) {
    throw new Error(
      `Blocksync error resolving MatrixHomeServer for ${userDid}: ${body.errors[0]?.message ?? 'unknown'}`,
    );
  }
  const node = body.data?.iids?.nodes?.[0];
  if (!node) return null;
  const services: DidService[] = Array.isArray(node.service)
    ? node.service
    : [];
  return matrixServerNameFromServices(services);
}

/** A resolved server name as the gateway caches it (`hs:<did>` in its storage). */
export interface CachedUserServerName {
  serverName: string;
  /** When Blocksync answered (epoch ms). */
  at: number;
}

/**
 * Where a `lookupUserServerName` answer came from:
 * - `cache` — a cached Blocksync answer younger than the TTL;
 * - `blocksync` — Blocksync answered just now (and the answer was cached);
 * - `stale` — Blocksync failed and an EXPIRED cached answer was used;
 * - `unregistered` — the DID document names no homeserver: the default;
 * - `unconfigured` — no Blocksync URL is configured: the default.
 */
export type UserServerNameSource =
  | 'cache'
  | 'blocksync'
  | 'stale'
  | 'unregistered'
  | 'unconfigured';

export interface UserServerNameLookup {
  serverName: string;
  source: UserServerNameSource;
  /** The Blocksync failure a `stale` answer stands in for. */
  error?: unknown;
}

export interface UserServerNameLookupDeps {
  blocksyncGraphqlUrl: string | undefined;
  /** The answer for a DID that names no homeserver (the oracle's own server). */
  defaultServerName: string;
  /** How long a Blocksync answer is served from the cache without asking again. */
  ttlMs: number;
  readCache(userDid: string): Promise<CachedUserServerName | undefined>;
  writeCache(userDid: string, entry: CachedUserServerName): Promise<void>;
  now?: () => number;
  fetchImpl?: typeof fetch;
}

/** Blocksync could not be asked and nothing was ever cached: there is no answer to give. */
export class UserServerNameUnavailableError extends Error {
  constructor(userDid: string, cause: unknown) {
    super(
      `could not resolve ${userDid}'s homeserver from Blocksync and nothing is cached`,
      { cause },
    );
    this.name = 'UserServerNameUnavailableError';
  }
}

/**
 * The server a user's DID document registers, through a TTL cache over
 * Blocksync. A failed Blocksync request is not an answer: it is served from
 * the cached entry even when that has expired — a homeserver registration
 * rarely changes, while treating the failure as "the oracle's own server"
 * would make every user registered elsewhere look foreign for as long as
 * Blocksync is down. With nothing cached it throws
 * `UserServerNameUnavailableError`, and each caller decides: the sender check
 * gives no verdict, the room-alias lookup falls back to the oracle's server.
 */
export async function lookupUserServerName(
  userDid: string,
  deps: UserServerNameLookupDeps,
): Promise<UserServerNameLookup> {
  const now = deps.now ?? Date.now;
  const cached = await deps.readCache(userDid);
  if (cached && now() - cached.at < deps.ttlMs)
    return { serverName: cached.serverName, source: 'cache' };
  if (!deps.blocksyncGraphqlUrl)
    return { serverName: deps.defaultServerName, source: 'unconfigured' };
  let resolved: string | null;
  try {
    resolved = await fetchUserMatrixServerName(
      deps.blocksyncGraphqlUrl,
      userDid,
      deps.fetchImpl,
    );
  } catch (err) {
    if (cached)
      return { serverName: cached.serverName, source: 'stale', error: err };
    throw new UserServerNameUnavailableError(userDid, err);
  }
  if (!resolved)
    return { serverName: deps.defaultServerName, source: 'unregistered' };
  await deps.writeCache(userDid, { serverName: resolved, at: now() });
  return { serverName: resolved, source: 'blocksync' };
}

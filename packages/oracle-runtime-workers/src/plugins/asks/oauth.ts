/**
 * The OAuth 2.1 client side of asks.world's connector (RFC 6749 + PKCE,
 * RFC 8707 resource, RFC 9207 `iss`, RFC 7009 revocation). The oracle is a
 * public client named by a Client ID Metadata Document it serves itself
 * (`/asks/oauth/client.json`), so there is no registration state to keep.
 * Pure helpers over WebCrypto and `fetch`: no Worker bindings here.
 */

const encoder = new TextEncoder();

export const SCOPE = 'asks';

export function b64url(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary)
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

function fromB64url(text: string): Uint8Array {
  const binary = atob(text.replace(/-/g, '+').replace(/_/g, '/'));
  return Uint8Array.from(binary, (char) => char.charCodeAt(0));
}

export const randomToken = (bytes = 32): string =>
  b64url(crypto.getRandomValues(new Uint8Array(bytes)));

export async function pkceChallenge(verifier: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    'SHA-256',
    encoder.encode(verifier),
  );
  return b64url(new Uint8Array(digest));
}

/** asks.world's hosted connector on each IXO network; the runtime's `NETWORK` picks one. */
export const ASKS_MCP_URLS = {
  mainnet: 'https://asks.world/v1/mcp',
  testnet: 'https://test.asks.world/v1/mcp',
  devnet: 'https://dev.asks.world/v1/mcp',
} as const;

/** The connector for `NETWORK`, or null when it is missing or not an IXO network. */
export function asksMcpUrlOf(network: unknown): string | null {
  return network === 'mainnet' || network === 'testnet' || network === 'devnet'
    ? ASKS_MCP_URLS[network]
    : null;
}

/** Where everything lives, from the connector URL and the oracle's own origin. */
export interface AsksEndpoints {
  /** asks' issuer: the connector's origin (its RFC 8414 metadata says so). */
  issuer: string;
  authorize: string;
  token: string;
  revoke: string;
  /** The one protected resource, `<origin>/v1/mcp`. */
  resource: string;
  clientId: string;
  redirectUri: string;
}

export function endpointsOf(mcpUrl: string, publicUrl: string): AsksEndpoints {
  const mcp = new URL(mcpUrl);
  const self = publicUrl.replace(/\/+$/, '');
  return {
    issuer: mcp.origin,
    authorize: `${mcp.origin}/oauth/authorize`,
    token: `${mcp.origin}/oauth/token`,
    revoke: `${mcp.origin}/oauth/revoke`,
    resource: `${mcp.origin}${mcp.pathname.replace(/\/+$/, '')}`,
    clientId: `${self}/asks/oauth/client.json`,
    redirectUri: `${self}/asks/oauth/callback`,
  };
}

/** The Client ID Metadata Document asks fetches (JSON, under 5 kB, no redirect). */
export function clientDocument(endpoints: AsksEndpoints, name: string) {
  return {
    client_id: endpoints.clientId,
    client_name: name,
    redirect_uris: [endpoints.redirectUri],
    token_endpoint_auth_method: 'none',
    grant_types: ['authorization_code', 'refresh_token'],
    response_types: ['code'],
  };
}

export function authorizeUrl(
  endpoints: AsksEndpoints,
  state: string,
  challenge: string,
): string {
  const url = new URL(endpoints.authorize);
  url.search = new URLSearchParams({
    response_type: 'code',
    client_id: endpoints.clientId,
    redirect_uri: endpoints.redirectUri,
    state,
    code_challenge: challenge,
    code_challenge_method: 'S256',
    resource: endpoints.resource,
    scope: SCOPE,
  }).toString();
  return url.toString();
}

export interface Tokens {
  access: string;
  refresh: string;
  /** Epoch ms when the access token stops working. */
  expiresAt: number;
}

export type TokenAnswer =
  | { ok: true; tokens: Tokens }
  /**
   * `ended`: asks refused the request itself (a 4xx: `invalid_grant`,
   * `invalid_client`, ...), so the person signs in again. Not ended: no
   * answer, a timeout, a 5xx, 408 or 429; worth one retry.
   */
  | { ok: false; ended: boolean; error: string };

/** Each call to asks' OAuth endpoints gives up after this long. */
export const OAUTH_TIMEOUT_MS = 10_000;

/** POST to the token endpoint; never throws. */
export async function postToken(
  fetcher: typeof fetch,
  endpoints: AsksEndpoints,
  form: Record<string, string>,
  now: number,
): Promise<TokenAnswer> {
  let response: Response;
  try {
    response = await fetcher(endpoints.token, {
      method: 'POST',
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
        accept: 'application/json',
      },
      body: new URLSearchParams({
        ...form,
        client_id: endpoints.clientId,
        resource: endpoints.resource,
      }).toString(),
      signal: AbortSignal.timeout(OAUTH_TIMEOUT_MS),
    });
  } catch (error) {
    return { ok: false, ended: false, error: String(error) };
  }
  const body = (await response.json().catch(() => ({}))) as Record<
    string,
    unknown
  >;
  if (
    response.ok &&
    typeof body.access_token === 'string' &&
    typeof body.refresh_token === 'string'
  ) {
    const seconds = typeof body.expires_in === 'number' ? body.expires_in : 0;
    return {
      ok: true,
      tokens: {
        access: body.access_token,
        refresh: body.refresh_token,
        expiresAt: now + seconds * 1000,
      },
    };
  }
  const error =
    typeof body.error === 'string' ? body.error : `http_${response.status}`;
  const { status } = response;
  const ended =
    status >= 400 && status < 500 && status !== 408 && status !== 429;
  return { ok: false, ended, error };
}

/** The IXO account address a `did:ixo:<ixo1…>` DID names, or null. */
export function addressOfDid(did: string): string | null {
  return /^did:ixo:(ixo1[0-9a-z]{20,90})$/.exec(did)?.[1] ?? null;
}

/** `ixo1abcdef…wxyz`, for the chat. */
export const shortAccount = (address: string): string =>
  address.length > 16
    ? `${address.slice(0, 10)}…${address.slice(-4)}`
    : address;

export type AccountRead =
  | { kind: 'ok'; address: string }
  /** asks answered 401: the token is not (or no longer) good. */
  | { kind: 'refused' }
  /** No answer, a timeout, a 5xx, or an answer that names no account. */
  | { kind: 'unreachable' };

/**
 * Which asks account an access token acts for: an MCP `initialize` on the
 * connector, whose instructions open with "Signed in as <ixo1…>:"
 * (asks `services/openhands-mcp/src/server.ts`). Stateless and with no side
 * effect there (unlike `my_status`, which marks notices read).
 * shortcut: reads the address out of asks' instructions text; switch to a
 * structured field once asks names the account in one.
 */
export async function accountOf(
  fetcher: typeof fetch,
  endpoints: AsksEndpoints,
  access: string,
): Promise<AccountRead> {
  let response: Response;
  try {
    response = await fetcher(endpoints.resource, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${access}`,
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: {
          protocolVersion: '2025-06-18',
          capabilities: {},
          clientInfo: { name: 'ixo-oracle', version: '1.0.0' },
        },
      }),
      signal: AbortSignal.timeout(OAUTH_TIMEOUT_MS),
    });
  } catch {
    return { kind: 'unreachable' };
  }
  if (response.status === 401) return { kind: 'refused' };
  const body = (await response.json().catch(() => null)) as {
    result?: { instructions?: unknown };
  } | null;
  const instructions = body?.result?.instructions;
  const address =
    response.ok && typeof instructions === 'string'
      ? /^Signed in as (ixo1[0-9a-z]{20,90}):/.exec(instructions)?.[1]
      : undefined;
  return address ? { kind: 'ok', address } : { kind: 'unreachable' };
}

/**
 * RFC 7009: best effort, asks answers 200 whether or not it knew the token.
 * At asks either token of a connection ends the whole connection (both
 * tokens), so the refresh token alone is enough.
 */
export async function revokeToken(
  fetcher: typeof fetch,
  endpoints: AsksEndpoints,
  token: string,
): Promise<void> {
  await fetcher(endpoints.revoke, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      token,
      token_type_hint: 'refresh_token',
      client_id: endpoints.clientId,
    }).toString(),
    signal: AbortSignal.timeout(OAUTH_TIMEOUT_MS),
  }).catch(() => undefined);
}

/* ── keys: one ASKS_TOKEN_KEY, two derived keys ─────────────────────────── */

export interface AsksKeys {
  /** AES-GCM key for what the connection object stores. */
  seal: CryptoKey;
  /** HMAC key naming each person's connection object. */
  name: CryptoKey;
}

export async function deriveKeys(secret: string): Promise<AsksKeys> {
  const base = await crypto.subtle.importKey(
    'raw',
    encoder.encode(secret),
    'HKDF',
    false,
    ['deriveKey'],
  );
  const params = (info: string) => ({
    name: 'HKDF',
    hash: 'SHA-256',
    salt: new Uint8Array(0),
    info: encoder.encode(info),
  });
  const [seal, name] = await Promise.all([
    crypto.subtle.deriveKey(
      params('asks/tokens'),
      base,
      { name: 'AES-GCM', length: 256 },
      false,
      ['encrypt', 'decrypt'],
    ),
    crypto.subtle.deriveKey(
      params('asks/object-name'),
      base,
      { name: 'HMAC', hash: 'SHA-256', length: 256 },
      false,
      ['sign'],
    ),
  ]);
  return { seal, name };
}

/** The connection object's name for a person: HMAC(key, did), 64 hex. */
export async function objectNameOf(
  keys: AsksKeys,
  userDid: string,
): Promise<string> {
  const mac = await crypto.subtle.sign(
    'HMAC',
    keys.name,
    encoder.encode(userDid),
  );
  return [...new Uint8Array(mac)]
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

export const OBJECT_NAME = /^[0-9a-f]{64}$/;

/** The object a sign-in belongs to, from its `state` (`<object name>.<random>`). */
export function objectNameOfState(state: string): string | null {
  const [name, rest] = state.split('.');
  return name &&
    rest &&
    OBJECT_NAME.test(name) &&
    /^[A-Za-z0-9_-]{32,}$/.test(rest)
    ? name
    : null;
}

export interface Sealed {
  iv: string;
  data: string;
}

/** AES-GCM with a fresh IV; `kind` is bound as associated data. */
export async function seal(
  key: CryptoKey,
  kind: string,
  value: unknown,
): Promise<Sealed> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const data = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv, additionalData: encoder.encode(kind) },
    key,
    encoder.encode(JSON.stringify(value)),
  );
  return { iv: b64url(iv), data: b64url(new Uint8Array(data)) };
}

/** The sealed value, or null when it does not open under this key and kind. */
export async function unseal<T>(
  key: CryptoKey,
  kind: string,
  sealed: Sealed | undefined,
): Promise<T | null> {
  if (!sealed) return null;
  try {
    const plain = await crypto.subtle.decrypt(
      {
        name: 'AES-GCM',
        iv: fromB64url(sealed.iv),
        additionalData: encoder.encode(kind),
      },
      key,
      fromB64url(sealed.data),
    );
    return JSON.parse(new TextDecoder().decode(plain)) as T;
  } catch {
    return null;
  }
}

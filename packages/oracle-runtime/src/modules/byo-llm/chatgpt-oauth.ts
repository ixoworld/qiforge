/**
 * OAuth client for connecting a user's ChatGPT subscription — the same public
 * client the Codex CLI uses. Two connect paths:
 *
 *  - **Device flow** (preferred): OpenAI's custom device-auth protocol (NOT
 *    RFC 8628) — start returns `{device_auth_id, user_code}`, the user enters
 *    the code at auth.openai.com/codex/device, and a successful poll returns
 *    an authorization code WITH a server-minted PKCE verifier, exchanged
 *    against the device-auth redirect URI.
 *  - **Pasted redirect** (fallback): classic authorization-code + PKCE where
 *    the browser dead-ends on the registered localhost redirect and the user
 *    pastes that URL back; the client mints the PKCE pair.
 *
 * Refresh notes: the token endpoint takes a JSON body for refresh (the
 * auth-code exchange is form-encoded), all response fields are optional so
 * results must be MERGED over the previous tokens, and refresh tokens rotate —
 * `refresh_token_expired|reused|invalidated` are permanent failures that
 * require a re-connect.
 *
 * Pure HTTP + parsing; no storage. `ByoLlmService` owns persistence and
 * refresh scheduling. All wire constants live at the top of this file.
 */

import * as crypto from 'node:crypto';
import type { ChatGptOAuthTokens } from '../../llm/byo-catalog.js';

export const DEFAULT_CHATGPT_CLIENT_ID = 'app_EMoamEEZ73f0CkXaXp7hrann';

const AUTH_BASE_URL = 'https://auth.openai.com';
const AUTHORIZE_URL = `${AUTH_BASE_URL}/oauth/authorize`;
const TOKEN_URL = `${AUTH_BASE_URL}/oauth/token`;
const DEVICE_USERCODE_URL = `${AUTH_BASE_URL}/api/accounts/deviceauth/usercode`;
const DEVICE_TOKEN_URL = `${AUTH_BASE_URL}/api/accounts/deviceauth/token`;

/** Where the user types the device user-code. */
export const DEVICE_VERIFICATION_URL = `${AUTH_BASE_URL}/codex/device`;

/** Redirect URI the device-flow authorization code is exchanged against. */
const DEVICE_REDIRECT_URI = `${AUTH_BASE_URL}/deviceauth/callback`;

/**
 * The localhost redirect registered for the public client — the pasted-URL
 * fallback dead-ends here after login and the user copies the address bar.
 */
export const CHATGPT_REDIRECT_URI = 'http://localhost:1455/auth/callback';

const OAUTH_SCOPE =
  'openid profile email offline_access api.connectors.read api.connectors.invoke';

/**
 * Refresh this many ms before the access token's nominal expiry (mirrors the
 * Codex client's 5-minute window) so an in-flight turn never races expiry.
 */
export const TOKEN_REFRESH_SKEW_MS = 300_000;

/** Device codes are client-capped at 15 minutes. */
export const DEVICE_FLOW_EXPIRES_IN_SEC = 900;

/**
 * Hard timeout on every auth-endpoint call. Without it a stalled upstream
 * would be bounded only by undici's socket defaults (minutes) — and a
 * disconnect that awaits an in-flight refresh would stall with it.
 */
const AUTH_HTTP_TIMEOUT_MS = 15_000;

export interface PkcePair {
  codeVerifier: string;
  codeChallenge: string;
}

/** 64 random bytes, base64url unpadded — matches the Codex client. */
export function createPkcePair(): PkcePair {
  const codeVerifier = crypto.randomBytes(64).toString('base64url');
  const codeChallenge = crypto
    .createHash('sha256')
    .update(codeVerifier)
    .digest('base64url');
  return { codeVerifier, codeChallenge };
}

export function buildAuthorizeUrl(params: {
  clientId: string;
  codeChallenge: string;
  state: string;
}): string {
  const url = new URL(AUTHORIZE_URL);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('client_id', params.clientId);
  url.searchParams.set('redirect_uri', CHATGPT_REDIRECT_URI);
  url.searchParams.set('scope', OAUTH_SCOPE);
  url.searchParams.set('code_challenge', params.codeChallenge);
  url.searchParams.set('code_challenge_method', 'S256');
  url.searchParams.set('id_token_add_organizations', 'true');
  url.searchParams.set('codex_cli_simplified_flow', 'true');
  url.searchParams.set('originator', 'codex_cli_rs');
  url.searchParams.set('state', params.state);
  return url.toString();
}

export class ChatGptOAuthError extends Error {
  constructor(
    message: string,
    readonly code:
      | 'device_flow_unavailable'
      | 'exchange_failed'
      | 'refresh_failed'
      | 'reconnect_required',
  ) {
    super(message);
    this.name = 'ChatGptOAuthError';
  }
}

interface HttpJsonResult {
  ok: boolean;
  status: number;
  body: Record<string, unknown>;
}

async function postJson(
  url: string,
  payload: Record<string, string>,
): Promise<HttpJsonResult> {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(AUTH_HTTP_TIMEOUT_MS),
  });
  return { ok: res.ok, status: res.status, body: await safeJson(res) };
}

async function postForm(
  url: string,
  form: Record<string, string>,
): Promise<HttpJsonResult> {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(form).toString(),
    signal: AbortSignal.timeout(AUTH_HTTP_TIMEOUT_MS),
  });
  return { ok: res.ok, status: res.status, body: await safeJson(res) };
}

async function safeJson(res: Response): Promise<Record<string, unknown>> {
  try {
    const parsed: unknown = await res.json();
    return parsed && typeof parsed === 'object'
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

export interface DeviceAuthorization {
  deviceAuthId: string;
  userCode: string;
  verificationUri: string;
  /** Seconds until the code expires (client-capped). */
  expiresIn: number;
  /** Suggested polling interval, seconds. */
  interval: number;
}

export async function startDeviceAuthorization(
  clientId: string,
): Promise<DeviceAuthorization> {
  const { ok, status, body } = await postJson(DEVICE_USERCODE_URL, {
    client_id: clientId,
  });
  if (
    !ok ||
    typeof body.device_auth_id !== 'string' ||
    typeof body.user_code !== 'string'
  ) {
    throw new ChatGptOAuthError(
      `Device authorization unavailable (HTTP ${status})`,
      'device_flow_unavailable',
    );
  }
  // `interval` arrives as a JSON *string* (e.g. "5").
  const interval = Number(body.interval);
  return {
    deviceAuthId: body.device_auth_id,
    userCode: body.user_code,
    verificationUri: DEVICE_VERIFICATION_URL,
    expiresIn: DEVICE_FLOW_EXPIRES_IN_SEC,
    interval: Number.isFinite(interval) && interval > 0 ? interval : 5,
  };
}

export type DevicePollResult =
  | { status: 'pending' }
  | { status: 'complete'; tokens: ChatGptOAuthTokens }
  | { status: 'failed'; error: string };

/**
 * Single poll of the device grant — the connect UI drives the loop. HTTP
 * 403/404 mean "still pending" in this protocol. A 200 carries the
 * authorization code plus the server-minted PKCE verifier, which is exchanged
 * here immediately so callers get tokens in one step.
 */
export async function pollDeviceToken(params: {
  clientId: string;
  deviceAuthId: string;
  userCode: string;
}): Promise<DevicePollResult> {
  const { ok, status, body } = await postJson(DEVICE_TOKEN_URL, {
    device_auth_id: params.deviceAuthId,
    user_code: params.userCode,
  });
  if (!ok) {
    if (status === 403 || status === 404) return { status: 'pending' };
    return { status: 'failed', error: extractErrorMessage(body, status) };
  }
  const code = body.authorization_code;
  const verifier = body.code_verifier;
  if (typeof code !== 'string' || typeof verifier !== 'string') {
    return { status: 'failed', error: 'Malformed device-auth token response' };
  }
  const tokens = await exchangeAuthorizationCode({
    clientId: params.clientId,
    code,
    codeVerifier: verifier,
    redirectUri: DEVICE_REDIRECT_URI,
  });
  return { status: 'complete', tokens };
}

/** Authorization-code + PKCE exchange (form-encoded). */
export async function exchangeAuthorizationCode(params: {
  clientId: string;
  code: string;
  codeVerifier: string;
  /** Defaults to the localhost redirect (pasted-URL fallback path). */
  redirectUri?: string;
}): Promise<ChatGptOAuthTokens> {
  const { ok, status, body } = await postForm(TOKEN_URL, {
    grant_type: 'authorization_code',
    code: params.code,
    redirect_uri: params.redirectUri ?? CHATGPT_REDIRECT_URI,
    client_id: params.clientId,
    code_verifier: params.codeVerifier,
  });
  if (!ok) {
    throw new ChatGptOAuthError(
      `Authorization-code exchange failed: ${extractErrorMessage(body, status)}`,
      'exchange_failed',
    );
  }
  return mergeTokenResponse(body, undefined);
}

/**
 * Refresh (JSON body — deliberately different from the code exchange). The
 * response's fields are all optional and the refresh token rotates, so the
 * result is merged over `previous`. Permanent refresh-token errors surface as
 * `reconnect_required` so callers can distinguish "retry later" from "the
 * user must sign in again".
 */
export async function refreshChatGptTokens(params: {
  clientId: string;
  previous: ChatGptOAuthTokens;
}): Promise<ChatGptOAuthTokens> {
  const { ok, status, body } = await postJson(TOKEN_URL, {
    client_id: params.clientId,
    grant_type: 'refresh_token',
    refresh_token: params.previous.refreshToken,
  });
  if (!ok) {
    const message = extractErrorMessage(body, status);
    const code = extractErrorCode(body);
    const permanent =
      code === 'refresh_token_expired' ||
      code === 'refresh_token_reused' ||
      code === 'refresh_token_invalidated';
    throw new ChatGptOAuthError(
      `Token refresh failed: ${message}`,
      permanent ? 'reconnect_required' : 'refresh_failed',
    );
  }
  return mergeTokenResponse(body, params.previous);
}

/**
 * Normalize a token-endpoint response over the previous tokens (if any). The
 * ChatGPT account id (the `ChatGPT-Account-ID` header on backend calls) lives
 * in the id-token's namespaced claims; kept from `previous` when the response
 * carries no id token.
 */
function mergeTokenResponse(
  body: Record<string, unknown>,
  previous: ChatGptOAuthTokens | undefined,
): ChatGptOAuthTokens {
  const accessToken =
    typeof body.access_token === 'string' && body.access_token.length > 0
      ? body.access_token
      : (previous?.accessToken ?? '');
  const refreshToken =
    typeof body.refresh_token === 'string' && body.refresh_token.length > 0
      ? body.refresh_token
      : (previous?.refreshToken ?? '');
  const idToken = typeof body.id_token === 'string' ? body.id_token : undefined;

  const accountId =
    (idToken ? extractAccountId(idToken) : undefined) ??
    (accessToken ? extractAccountId(accessToken) : undefined) ??
    previous?.accountId ??
    '';

  return {
    accessToken,
    refreshToken,
    accountId,
    expiresAt: resolveExpiry(body, accessToken),
  };
}

/**
 * Expiry: prefer the access token's own JWT `exp` (the authoritative value),
 * fall back to `expires_in`, then a conservative 30 minutes.
 */
function resolveExpiry(
  body: Record<string, unknown>,
  accessToken: string,
): number {
  const claims = accessToken ? decodeJwtClaims(accessToken) : null;
  if (claims && typeof claims.exp === 'number') {
    return claims.exp * 1000;
  }
  if (typeof body.expires_in === 'number') {
    return Date.now() + body.expires_in * 1000;
  }
  return Date.now() + 30 * 60 * 1000;
}

function extractErrorMessage(
  body: Record<string, unknown>,
  status: number,
): string {
  const error = body.error;
  if (typeof error === 'string') return error;
  if (error && typeof error === 'object' && 'message' in error) {
    const { message } = error;
    if (typeof message === 'string') return message;
  }
  if (typeof body.detail === 'string') return body.detail;
  return `HTTP ${status}`;
}

function extractErrorCode(body: Record<string, unknown>): string | undefined {
  const error = body.error;
  if (error && typeof error === 'object' && 'code' in error) {
    const { code } = error;
    if (typeof code === 'string') return code;
  }
  return typeof error === 'string' ? error : undefined;
}

function extractAccountId(jwt: string): string | undefined {
  const claims = decodeJwtClaims(jwt);
  if (!claims) return undefined;
  const authClaim = claims['https://api.openai.com/auth'];
  if (
    authClaim &&
    typeof authClaim === 'object' &&
    'chatgpt_account_id' in authClaim
  ) {
    const { chatgpt_account_id: id } = authClaim;
    if (typeof id === 'string' && id.length > 0) return id;
  }
  const direct = claims.chatgpt_account_id;
  return typeof direct === 'string' && direct.length > 0 ? direct : undefined;
}

function decodeJwtClaims(jwt: string): Record<string, unknown> | null {
  const segments = jwt.split('.');
  const payloadSegment = segments[1];
  if (segments.length !== 3 || !payloadSegment) return null;
  try {
    const payload = Buffer.from(payloadSegment, 'base64url').toString('utf8');
    const parsed: unknown = JSON.parse(payload);
    return parsed && typeof parsed === 'object'
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ChatGptOAuthTokens } from '../../llm/byo-catalog.js';
import {
  buildAuthorizeUrl,
  ChatGptOAuthError,
  createPkcePair,
  exchangeAuthorizationCode,
  pollDeviceToken,
  refreshChatGptTokens,
  startDeviceAuthorization,
} from './chatgpt-oauth.js';

const CLIENT_ID = 'app_test';

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function makeJwt(claims: Record<string, unknown>): string {
  const enc = (o: unknown) =>
    Buffer.from(JSON.stringify(o)).toString('base64url');
  return `${enc({ alg: 'none' })}.${enc(claims)}.sig`;
}

const previous: ChatGptOAuthTokens = {
  accessToken: 'old-access',
  refreshToken: 'old-refresh',
  accountId: 'acc-old',
  expiresAt: 111,
};

const fetchMock = vi.fn<typeof fetch>();

beforeEach(() => {
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
  fetchMock.mockReset();
});

describe('createPkcePair', () => {
  it('mints a 64-byte base64url verifier with a matching S256 challenge', () => {
    const { codeVerifier, codeChallenge } = createPkcePair();
    expect(codeVerifier).toMatch(/^[A-Za-z0-9_-]{86}$/);
    expect(codeChallenge).toMatch(/^[A-Za-z0-9_-]{43}$/);
  });
});

describe('buildAuthorizeUrl', () => {
  it('carries the codex client params', () => {
    const url = new URL(
      buildAuthorizeUrl({
        clientId: CLIENT_ID,
        codeChallenge: 'ch',
        state: 'st',
      }),
    );
    expect(url.origin).toBe('https://auth.openai.com');
    expect(url.searchParams.get('client_id')).toBe(CLIENT_ID);
    expect(url.searchParams.get('redirect_uri')).toBe(
      'http://localhost:1455/auth/callback',
    );
    expect(url.searchParams.get('code_challenge_method')).toBe('S256');
    expect(url.searchParams.get('id_token_add_organizations')).toBe('true');
    expect(url.searchParams.get('codex_cli_simplified_flow')).toBe('true');
    expect(url.searchParams.get('originator')).toBe('codex_cli_rs');
  });
});

describe('startDeviceAuthorization', () => {
  it('parses the response including the string-typed interval', async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse(200, {
        device_auth_id: 'da-1',
        user_code: 'XV0J-9Q6FD',
        interval: '7',
        expires_at: '2026-07-29T13:48:55Z',
      }),
    );

    const result = await startDeviceAuthorization(CLIENT_ID);
    expect(result.deviceAuthId).toBe('da-1');
    expect(result.userCode).toBe('XV0J-9Q6FD');
    expect(result.interval).toBe(7);
    expect(result.verificationUri).toBe('https://auth.openai.com/codex/device');

    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe(
      'https://auth.openai.com/api/accounts/deviceauth/usercode',
    );
    expect(JSON.parse(String(init?.body))).toEqual({ client_id: CLIENT_ID });
  });

  it('throws device_flow_unavailable on upstream rejection', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(400, {}));
    await expect(startDeviceAuthorization(CLIENT_ID)).rejects.toMatchObject({
      code: 'device_flow_unavailable',
    });
  });
});

describe('pollDeviceToken', () => {
  it('treats 403 and 404 as pending', async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse(403, {
        error: { code: 'deviceauth_authorization_pending' },
      }),
    );
    expect(
      await pollDeviceToken({
        clientId: CLIENT_ID,
        deviceAuthId: 'da-1',
        userCode: 'code',
      }),
    ).toEqual({ status: 'pending' });

    fetchMock.mockResolvedValueOnce(jsonResponse(404, {}));
    expect(
      await pollDeviceToken({
        clientId: CLIENT_ID,
        deviceAuthId: 'da-1',
        userCode: 'code',
      }),
    ).toEqual({ status: 'pending' });
  });

  it('exchanges the server-minted verifier against the device redirect on success', async () => {
    const idToken = makeJwt({
      'https://api.openai.com/auth': { chatgpt_account_id: 'acc-9' },
    });
    fetchMock
      .mockResolvedValueOnce(
        jsonResponse(200, {
          authorization_code: 'authcode',
          code_challenge: 'ch',
          code_verifier: 'ver',
        }),
      )
      .mockResolvedValueOnce(
        jsonResponse(200, {
          access_token: makeJwt({ exp: 2_000_000_000 }),
          refresh_token: 'rt',
          id_token: idToken,
        }),
      );

    const result = await pollDeviceToken({
      clientId: CLIENT_ID,
      deviceAuthId: 'da-1',
      userCode: 'code',
    });
    expect(result.status).toBe('complete');
    if (result.status !== 'complete') return;
    expect(result.tokens.accountId).toBe('acc-9');
    expect(result.tokens.refreshToken).toBe('rt');
    expect(result.tokens.expiresAt).toBe(2_000_000_000 * 1000);

    const [, exchangeInit] = fetchMock.mock.calls[1];
    const body = new URLSearchParams(String(exchangeInit?.body));
    expect(body.get('grant_type')).toBe('authorization_code');
    expect(body.get('code_verifier')).toBe('ver');
    expect(body.get('redirect_uri')).toBe(
      'https://auth.openai.com/deviceauth/callback',
    );
  });

  it('fails on other statuses with the upstream message', async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse(400, { error: { message: 'denied' } }),
    );
    expect(
      await pollDeviceToken({
        clientId: CLIENT_ID,
        deviceAuthId: 'da-1',
        userCode: 'code',
      }),
    ).toEqual({ status: 'failed', error: 'denied' });
  });
});

describe('exchangeAuthorizationCode', () => {
  it('posts form-encoded with the localhost redirect by default', async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse(200, { access_token: 'a', refresh_token: 'r' }),
    );
    await exchangeAuthorizationCode({
      clientId: CLIENT_ID,
      code: 'c',
      codeVerifier: 'v',
    });
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('https://auth.openai.com/oauth/token');
    expect(init?.headers).toEqual({
      'Content-Type': 'application/x-www-form-urlencoded',
    });
    const body = new URLSearchParams(String(init?.body));
    expect(body.get('redirect_uri')).toBe(
      'http://localhost:1455/auth/callback',
    );
  });
});

describe('refreshChatGptTokens', () => {
  it('posts JSON and merges optional fields over the previous tokens', async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse(200, { access_token: makeJwt({ exp: 2_100_000_000 }) }),
    );

    const tokens = await refreshChatGptTokens({
      clientId: CLIENT_ID,
      previous,
    });
    expect(tokens.refreshToken).toBe('old-refresh');
    expect(tokens.accountId).toBe('acc-old');
    expect(tokens.expiresAt).toBe(2_100_000_000 * 1000);

    const [, init] = fetchMock.mock.calls[0];
    expect(init?.headers).toEqual({ 'Content-Type': 'application/json' });
    expect(JSON.parse(String(init?.body))).toEqual({
      client_id: CLIENT_ID,
      grant_type: 'refresh_token',
      refresh_token: 'old-refresh',
    });
  });

  it('adopts a rotated refresh token', async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse(200, { access_token: 'a2', refresh_token: 'rotated' }),
    );
    const tokens = await refreshChatGptTokens({
      clientId: CLIENT_ID,
      previous,
    });
    expect(tokens.refreshToken).toBe('rotated');
  });

  it('marks permanent refresh-token errors as reconnect_required', async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse(400, {
        error: { code: 'refresh_token_reused', message: 'replayed' },
      }),
    );
    await expect(
      refreshChatGptTokens({ clientId: CLIENT_ID, previous }),
    ).rejects.toMatchObject({ code: 'reconnect_required' });
  });

  it('keeps transient failures retryable', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(500, {}));
    const error = await refreshChatGptTokens({
      clientId: CLIENT_ID,
      previous,
    }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ChatGptOAuthError);
    expect((error as ChatGptOAuthError).code).toBe('refresh_failed');
  });
});

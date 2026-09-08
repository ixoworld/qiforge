/**
 * The `/byo-llm/*` HTTP surface — the Workers port of the Node runtime's
 * `ByoLlmController`. Served from inside `UserOracleDO` (the object owns the
 * user's credentials, secrets service and refresh state); the shell proxies
 * authenticated requests here, so `userDid` is always the UCAN-authenticated
 * caller.
 *
 * Routes (identical to the Nest controller):
 *   GET    /byo-llm/status                    — per-provider connection status
 *   POST   /byo-llm/chatgpt/device/start      — start the device-auth flow
 *   POST   /byo-llm/chatgpt/device/poll       — poll the device grant once
 *   GET    /byo-llm/chatgpt/authorize-url     — pasted-redirect fallback URL
 *   POST   /byo-llm/chatgpt/exchange          — exchange a pasted auth code
 *   POST   /byo-llm/validate/:provider        — live-check a credential
 *   PUT    /byo-llm/credentials/:provider     — save a provider API key
 *   DELETE /byo-llm/credentials/:provider     — disconnect a provider
 *
 * Error bodies use the Nest wire shape (`{ statusCode, message }`). When BYO
 * is disabled, `status` reports `{ enabled: false }` (as on Node) and every
 * other route 404s.
 */

import type { Logger } from '../plugin-api/types';
import { BYO_DEFAULT_MODEL, isByoProvider, toByoModelId } from './byo-catalog';
import type { WorkersByoService } from './byo-service';
import {
  buildAuthorizeUrl,
  ChatGptOAuthError,
  createOAuthState,
  createPkcePair,
  exchangeAuthorizationCode,
  pollDeviceToken,
  startDeviceAuthorization,
} from './chatgpt-oauth';

const NOT_ENABLED_MESSAGE =
  'Bring-your-own-credential LLMs are not enabled on this oracle';

const NOOP: Logger = {
  log: () => undefined,
  warn: () => undefined,
  error: () => undefined,
};

function json(payload: unknown, status = 200): Response {
  return Response.json(payload, { status });
}

function error(status: number, message: string): Response {
  return json({ statusCode: status, message }, status);
}

async function readJsonBody(
  request: Request,
): Promise<Record<string, unknown>> {
  try {
    const parsed: unknown = await request.json();
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

/**
 * Dispatch one `/byo-llm/*` request. Never throws — unexpected failures
 * become 500s with the Nest error body shape.
 */
export async function handleByoRequest(
  byo: WorkersByoService,
  userDid: string,
  request: Request,
  logger: Logger = NOOP,
): Promise<Response> {
  const url = new URL(request.url);
  const path = url.pathname.replace(/\/+$/, '');
  const method = request.method.toUpperCase();

  try {
    if (path === '/byo-llm/status' && method === 'GET') {
      // Reports { enabled: false } rather than 404 when BYO is off (Node
      // behaviour): the connect UI probes this unconditionally.
      const refresh = url.searchParams.get('refresh');
      return json(
        await byo.status(userDid, {
          refresh: refresh === 'true' || refresh === '1',
        }),
      );
    }

    if (!byo.isEnabled()) return error(404, NOT_ENABLED_MESSAGE);

    if (path === '/byo-llm/chatgpt/device/start' && method === 'POST') {
      try {
        const authorization = await startDeviceAuthorization(
          byo.chatGptClientId,
        );
        await byo.bindDeviceAuth(userDid, authorization.deviceAuthId);
        return json(authorization);
      } catch (err) {
        if (
          err instanceof ChatGptOAuthError &&
          err.code === 'device_flow_unavailable'
        ) {
          return error(502, err.message);
        }
        throw err;
      }
    }

    if (path === '/byo-llm/chatgpt/device/poll' && method === 'POST') {
      const body = await readJsonBody(request);
      const deviceAuthId = body.deviceAuthId;
      const userCode = body.userCode;
      if (
        typeof deviceAuthId !== 'string' ||
        deviceAuthId.length === 0 ||
        typeof userCode !== 'string' ||
        userCode.length === 0
      ) {
        return error(400, 'deviceAuthId and userCode are required');
      }
      // The flow must have been started by this account on this oracle — a
      // poll for someone else's (or an unknown) device-auth id can neither
      // complete the grant nor capture the resulting tokens.
      if (!(await byo.isDeviceAuthOwner(userDid, deviceAuthId))) {
        return json({
          status: 'failed',
          error: 'Unknown or expired sign-in attempt — please start again.',
        });
      }
      const result = await pollDeviceToken({
        clientId: byo.chatGptClientId,
        deviceAuthId,
        userCode,
      });
      if (result.status === 'pending') return json({ status: 'pending' });
      if (result.status === 'failed') {
        return json({ status: 'failed', error: result.error });
      }
      try {
        await byo.storeChatGptTokens(userDid, result.tokens);
      } catch (err) {
        // The sign-in itself succeeded and the authorization code is spent —
        // failing here would force a full restart of the flow. Hold the
        // tokens instead; the service retries persistence in the background.
        logger.error(
          `[byo] could not persist ChatGPT tokens for ${userDid} — holding: ${err instanceof Error ? err.message : String(err)}`,
        );
        await byo.holdUnpersistedChatGptTokens(userDid, result.tokens);
      }
      logger.log(`[byo] ChatGPT subscription connected for ${userDid}`);
      return json({
        status: 'connected',
        defaultModelId: toByoModelId('chatgpt', BYO_DEFAULT_MODEL.chatgpt),
      });
    }

    if (path === '/byo-llm/chatgpt/authorize-url' && method === 'GET') {
      const { codeVerifier, codeChallenge } = await createPkcePair();
      const state = createOAuthState();
      return json({
        url: buildAuthorizeUrl({
          clientId: byo.chatGptClientId,
          codeChallenge,
          state,
        }),
        codeVerifier,
        state,
      });
    }

    if (path === '/byo-llm/chatgpt/exchange' && method === 'POST') {
      const body = await readJsonBody(request);
      const code = body.code;
      const codeVerifier = body.codeVerifier;
      if (
        typeof code !== 'string' ||
        code.length === 0 ||
        typeof codeVerifier !== 'string' ||
        codeVerifier.length === 0
      ) {
        return error(400, 'code and codeVerifier are required');
      }
      let tokens;
      try {
        tokens = await exchangeAuthorizationCode({
          clientId: byo.chatGptClientId,
          code,
          codeVerifier,
        });
      } catch (err) {
        if (err instanceof ChatGptOAuthError) return error(502, err.message);
        throw err;
      }
      try {
        await byo.storeChatGptTokens(userDid, tokens);
      } catch (err) {
        // Same as the device path: the code is spent and the sign-in worked —
        // hold the tokens rather than failing a completed authentication.
        logger.error(
          `[byo] could not persist ChatGPT tokens for ${userDid} — holding: ${err instanceof Error ? err.message : String(err)}`,
        );
        await byo.holdUnpersistedChatGptTokens(userDid, tokens);
      }
      logger.log(`[byo] ChatGPT subscription connected for ${userDid}`);
      return json({
        connected: true,
        defaultModelId: toByoModelId('chatgpt', BYO_DEFAULT_MODEL.chatgpt),
      });
    }

    const validateMatch = /^\/byo-llm\/validate\/([^/]+)$/.exec(path);
    if (validateMatch && method === 'POST') {
      const provider = decodeURIComponent(validateMatch[1]!);
      if (!isByoProvider(provider)) {
        return error(400, `Unknown provider "${provider}"`);
      }
      return json(await byo.validate(userDid, provider));
    }

    const credentialsMatch = /^\/byo-llm\/credentials\/([^/]+)$/.exec(path);
    if (credentialsMatch && (method === 'PUT' || method === 'DELETE')) {
      const provider = decodeURIComponent(credentialsMatch[1]!);
      if (!isByoProvider(provider)) {
        return error(400, `Unknown provider "${provider}"`);
      }
      if (method === 'DELETE') {
        await byo.deleteCredential(userDid, provider);
        logger.log(`[byo] credential ${provider} disconnected for ${userDid}`);
        return json({ ok: true, provider });
      }
      if (provider === 'chatgpt') {
        return error(400, 'ChatGPT connects via OAuth, not an API key');
      }
      const body = await readJsonBody(request);
      const apiKey = typeof body.apiKey === 'string' ? body.apiKey.trim() : '';
      if (!apiKey) return error(400, 'API key must not be empty');
      if (apiKey.length > 512) {
        return error(400, 'API key must be at most 512 characters');
      }
      await byo.storeApiKey(userDid, provider, apiKey);
      logger.log(`[byo] API key for ${provider} stored for ${userDid}`);
      return json({ ok: true, provider });
    }

    return error(404, `Cannot ${method} ${path}`);
  } catch (err) {
    logger.error(
      `[byo] ${method} ${path} failed: ${err instanceof Error ? err.message : String(err)}`,
    );
    return error(500, err instanceof Error ? err.message : 'Internal error');
  }
}

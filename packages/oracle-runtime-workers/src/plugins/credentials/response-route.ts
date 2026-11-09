import { PLUGIN_INBOX_MAX_BODY_LENGTH } from '../../core/plugin-inbox';
import { userObjectName, type OracleWorkerEnv } from '../../do/contracts';
import type { PluginRoute } from '../../shell/app';

/**
 * The verifier's response endpoint (OpenID4VP `response_uri`): the wallet
 * (the Hub, or the person's own wallet) POSTs the encrypted answer to a
 * credential check here, and the answer is put in the inbox of the check in
 * the person's own object, where the waiting tool decrypts and verifies it.
 *
 * The URL carries a sealed token (AES-GCM under a key derived from the
 * oracle account's Hub key) naming the person, the check and its end: the
 * person's DID never appears in the request object, and a token that was
 * not made here, or has ended, is refused before any user object is woken.
 */

export const RESPONSE_ROUTE_PREFIX = 'credentials/response';
export const RESPONSE_ROUTE_PATH = `${RESPONSE_ROUTE_PREFIX}/:token`;
export const CREDENTIALS_KV_NAMESPACE = 'credentials';

const PERSON_DID = /^did:ixo:(ixo1[02-9ac-hj-np-z]{38})$/;
const ADDRESS = /^ixo1[02-9ac-hj-np-z]{38}$/;
const CHECK_ID = /^[A-Za-z0-9_-]{16,64}$/;
const TOKEN = /^[A-Za-z0-9_-]{40,400}$/;
const KEY_INFO = 'qiforge/credentials/response-route/v1';
const TOKEN_AAD = new TextEncoder().encode('credentials-response');

export interface ResponseTarget {
  ownerDid: string;
  checkId: string;
  /** Unix seconds. */
  expiresAt: number;
}

/** The inbox key of one check. */
export function inboxKeyOf(checkId: string): string {
  return `inbox:${checkId}`;
}

function base64url(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary)
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

function fromBase64url(text: string): Uint8Array | null {
  try {
    const binary = atob(
      text
        .replace(/-/g, '+')
        .replace(/_/g, '/')
        .padEnd(Math.ceil(text.length / 4) * 4, '='),
    );
    return Uint8Array.from(binary, (char) => char.charCodeAt(0));
  } catch {
    return null;
  }
}

const keyCache = new Map<string, Promise<CryptoKey>>();

/**
 * The token key: HKDF-SHA-256 of the oracle account's Hub key, salted with
 * the oracle's DID, for this one purpose. Cached per isolate.
 */
async function tokenKey(secret: string, oracleDid: string): Promise<CryptoKey> {
  const id = `${oracleDid}\n${secret}`;
  const cached = keyCache.get(id);
  if (cached) return cached;
  const key = (async () => {
    const material = await crypto.subtle.importKey(
      'raw',
      new TextEncoder().encode(secret),
      'HKDF',
      false,
      ['deriveKey'],
    );
    return crypto.subtle.deriveKey(
      {
        name: 'HKDF',
        hash: 'SHA-256',
        salt: new TextEncoder().encode(oracleDid),
        info: new TextEncoder().encode(KEY_INFO),
      },
      material,
      { name: 'AES-GCM', length: 256 },
      false,
      ['encrypt', 'decrypt'],
    );
  })();
  if (keyCache.size >= 8) keyCache.clear();
  keyCache.set(id, key);
  void key.catch(() => keyCache.delete(id));
  return key;
}

export async function sealResponseToken(
  target: ResponseTarget,
  secret: { serviceKey: string; oracleDid: string },
): Promise<string> {
  const address = PERSON_DID.exec(target.ownerDid)?.[1];
  if (!address || !CHECK_ID.test(target.checkId))
    throw new TypeError('Invalid response target');
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const plain = new TextEncoder().encode(
    `${address}.${target.checkId}.${target.expiresAt}`,
  );
  const sealed = new Uint8Array(
    await crypto.subtle.encrypt(
      { name: 'AES-GCM', iv, additionalData: TOKEN_AAD },
      await tokenKey(secret.serviceKey, secret.oracleDid),
      plain,
    ),
  );
  const token = new Uint8Array(iv.length + sealed.length);
  token.set(iv);
  token.set(sealed, iv.length);
  return base64url(token);
}

/** The target a token names; null when it was not made here or has ended. */
export async function openResponseToken(
  token: string,
  secret: { serviceKey: string; oracleDid: string },
  nowSeconds: number = Math.floor(Date.now() / 1000),
): Promise<ResponseTarget | null> {
  if (!TOKEN.test(token)) return null;
  const bytes = fromBase64url(token);
  if (!bytes || bytes.length < 12 + 16 + 1) return null;
  let plain: string;
  try {
    plain = new TextDecoder().decode(
      await crypto.subtle.decrypt(
        { name: 'AES-GCM', iv: bytes.slice(0, 12), additionalData: TOKEN_AAD },
        await tokenKey(secret.serviceKey, secret.oracleDid),
        bytes.slice(12),
      ),
    );
  } catch {
    return null;
  }
  const [address, checkId, end, ...rest] = plain.split('.');
  const expiresAt = Number(end);
  if (
    rest.length > 0 ||
    !address ||
    !ADDRESS.test(address) ||
    !checkId ||
    !CHECK_ID.test(checkId) ||
    !Number.isSafeInteger(expiresAt) ||
    expiresAt <= nowSeconds
  )
    return null;
  return { ownerDid: `did:ixo:${address}`, checkId, expiresAt };
}

/** Appends a body to the check's inbox in the owner's object. */
export type DeliverToOwner = (
  env: OracleWorkerEnv,
  target: ResponseTarget,
  body: string,
) => Promise<boolean>;

const deliverToOwnerObject: DeliverToOwner = (env, target, body) => {
  const stub = env.USER_ORACLE.get(
    env.USER_ORACLE.idFromName(userObjectName(target.ownerDid, env.ORACLE_DID)),
  );
  return stub.deliverPluginInbox(
    target.ownerDid,
    CREDENTIALS_KV_NAMESPACE,
    inboxKeyOf(target.checkId),
    body,
  );
};

/**
 * The body as UTF-8 text, reading at most `limit` bytes (a chunked body
 * declares no length); `too_large` past it, null when it is not UTF-8.
 */
async function readCapped(
  request: Request,
  limit: number,
): Promise<string | null | 'too_large'> {
  const reader = request.body?.getReader();
  if (!reader) return null;
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > limit) {
      await reader.cancel().catch(() => undefined);
      return 'too_large';
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return new TextDecoder('utf-8', { fatal: true, ignoreBOM: false }).decode(
      bytes,
    );
  } catch {
    return null;
  }
}

function answer(status: number, body: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'content-type': 'application/json',
      'cache-control': 'no-store',
    },
  });
}

/**
 * `POST /credentials/response/:token`. 200 `{}` once the answer is in the
 * check's inbox (the waiting tool verifies it); 404 for a token not made
 * here or ended; 410 when the check is closed or full; 413 for a body over
 * the inbox's limit; 503 when the owner's object could not be reached.
 */
export function credentialsResponseRoute(
  deliver: DeliverToOwner = deliverToOwnerObject,
): PluginRoute {
  return {
    method: 'POST',
    path: RESPONSE_ROUTE_PATH,
    handler: async (request, env) => {
      const serviceKey = env.AUTH_HUB_CHANNEL_SERVICE_KEY;
      if (!serviceKey || !env.ORACLE_DID)
        return answer(404, {
          error: 'not_found',
          message: 'There is nothing to answer here.',
        });
      const token = new URL(request.url).pathname.split('/').pop() ?? '';
      const target = await openResponseToken(token, {
        serviceKey,
        oracleDid: env.ORACLE_DID,
      });
      if (!target)
        return answer(404, {
          error: 'not_found',
          message: 'There is nothing to answer here.',
        });
      const declared = Number(request.headers.get('content-length') ?? '0');
      if (declared > PLUGIN_INBOX_MAX_BODY_LENGTH)
        return answer(413, {
          error: 'request_too_large',
          message: 'The answer is too large.',
        });
      const body = await readCapped(request, PLUGIN_INBOX_MAX_BODY_LENGTH);
      if (body === 'too_large')
        return answer(413, {
          error: 'request_too_large',
          message: 'The answer is too large.',
        });
      if (!body)
        return answer(400, {
          error: 'invalid_response',
          message: 'The answer is empty or unreadable.',
        });
      try {
        return (await deliver(env, target, body))
          ? answer(200)
          : answer(410, {
              error: 'check_closed',
              message: 'This check has already ended.',
            });
      } catch {
        return answer(503, {
          error: 'unavailable',
          message: 'Please try again in a moment.',
        });
      }
    },
  };
}

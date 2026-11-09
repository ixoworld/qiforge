import { userObjectName, type OracleWorkerEnv } from '../../do/contracts';
import { ipOverLimit, rateLimitKey, type PluginRoute } from '../../shell/app';
import { CREDENTIALS_KV_NAMESPACE } from './check-store';

/**
 * The verifier's response endpoint (OpenID4VP `response_uri`): the wallet
 * (the Hub, or the person's own wallet) POSTs the encrypted answer to a
 * credential check here. The person's own object (the only place holding the
 * check's private key and request) decrypts and verifies it on arrival
 * (`receiveAnswer`) and keeps it only when it proves to come from the
 * person; the waiting tool reads that verified result.
 *
 * The URL carries a sealed token (AES-GCM under a key derived from the
 * oracle account's Hub key) naming the person, the check, its end and the
 * `kid` of its answer key: the person's DID never appears in the request
 * object, and a token that was not made here, or has ended, is refused
 * before any user object is woken. So is a body that is not one encrypted
 * answer for that key (`response=<JWE>`, ECDH-ES, that `kid`), and calls
 * past the per-IP budget or a check's budget of failed answers.
 */

export const RESPONSE_ROUTE_PREFIX = 'credentials/response';
export const RESPONSE_ROUTE_PATH = `${RESPONSE_ROUTE_PREFIX}/:token`;
export { CREDENTIALS_KV_NAMESPACE };
/** Largest answer body, in bytes (an SD-JWT presentation of a few fields is a few KiB). */
export const MAX_ANSWER_BYTES = 24 * 1024;

const PERSON_DID = /^did:ixo:(ixo1[02-9ac-hj-np-z]{38})$/;
const ADDRESS = /^ixo1[02-9ac-hj-np-z]{38}$/;
const CHECK_ID = /^[A-Za-z0-9_-]{16,64}$/;
const TOKEN = /^[A-Za-z0-9_-]{40,400}$/;
const KID = /^[A-Za-z0-9_-]{1,64}$/;
const B64URL = /^[A-Za-z0-9_-]*$/;
/**
 * Answers to one check that fail verification, per minute, before the check
 * refuses more (a real flow sends one answer that verifies).
 */
export const FAILED_ANSWERS_PER_CHECK_PER_MINUTE = 20;
/**
 * Calls per IP per minute one isolate takes when the Worker has no
 * `CREDENTIALS_RATE_LIMIT` binding: generous, the Hub answers every person
 * from shared Cloudflare addresses.
 */
export const RESPONSES_PER_IP_PER_MINUTE = 2_000;
const KEY_INFO = 'qiforge/credentials/response-route/v1';
const TOKEN_AAD = new TextEncoder().encode('credentials-response');

export interface ResponseTarget {
  ownerDid: string;
  checkId: string;
  /** Unix seconds. */
  expiresAt: number;
  /** The `kid` of the check's answer key (the JWE header must name it). */
  kid: string;
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
  if (!address || !CHECK_ID.test(target.checkId) || !KID.test(target.kid))
    throw new TypeError('Invalid response target');
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const plain = new TextEncoder().encode(
    `${address}.${target.checkId}.${target.expiresAt}.${target.kid}`,
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
  const [address, checkId, end, kid, ...rest] = plain.split('.');
  const expiresAt = Number(end);
  if (
    rest.length > 0 ||
    !kid ||
    !KID.test(kid) ||
    !address ||
    !ADDRESS.test(address) ||
    !checkId ||
    !CHECK_ID.test(checkId) ||
    !Number.isSafeInteger(expiresAt) ||
    expiresAt <= nowSeconds
  )
    return null;
  return { ownerDid: `did:ixo:${address}`, checkId, expiresAt, kid };
}

function headerOf(segment: string): Record<string, unknown> | null {
  const bytes = fromBase64url(segment);
  if (!bytes) return null;
  try {
    const parsed: unknown = JSON.parse(new TextDecoder().decode(bytes));
    return parsed !== null &&
      typeof parsed === 'object' &&
      !Array.isArray(parsed)
      ? Object.fromEntries(Object.entries(parsed))
      : null;
  } catch {
    return null;
  }
}

/**
 * True for one encrypted OpenID4VP answer to this check: a form body whose
 * only field is `response`, a compact JWE of five base64url parts whose
 * protected header is ECDH-ES (with its `epk`), A128GCM or A256GCM, and
 * names `kid`. It proves nothing about who sent it (the person's object
 * decrypts and verifies); it keeps anything else from waking the person's object.
 */
export function isWellFormedDelivery(body: string, kid: string): boolean {
  let form: URLSearchParams;
  try {
    form = new URLSearchParams(body);
  } catch {
    return false;
  }
  const keys = [...form.keys()];
  const jwe = form.get('response');
  if (keys.length !== 1 || keys[0] !== 'response' || !jwe) return false;
  const parts = jwe.split('.');
  if (parts.length !== 5 || !parts.every((part) => B64URL.test(part)))
    return false;
  const [protectedHeader, encryptedKey, iv, ciphertext, tag] = parts;
  // ECDH-ES (direct key agreement): no encrypted key; the rest present.
  if (encryptedKey !== '' || !iv || !ciphertext || !tag || !protectedHeader)
    return false;
  const header = headerOf(protectedHeader);
  const epk = header?.epk;
  return (
    header?.alg === 'ECDH-ES' &&
    (header.enc === 'A128GCM' || header.enc === 'A256GCM') &&
    header.kid === kid &&
    epk !== null &&
    typeof epk === 'object'
  );
}

/**
 * A per-isolate fixed-window counter. `blocked` peeks, `charge` counts one.
 */
export class WindowLimiter {
  private readonly hits = new Map<string, { start: number; count: number }>();

  constructor(
    private readonly limit: number,
    private readonly windowMs = 60_000,
    private readonly maxKeys = 4096,
    private readonly now: () => number = Date.now,
  ) {}

  private entry(key: string) {
    const now = this.now();
    const entry = this.hits.get(key);
    if (entry && now - entry.start < this.windowMs) return entry;
    if (!entry && this.hits.size >= this.maxKeys) {
      const oldest = this.hits.keys().next().value;
      if (oldest !== undefined) this.hits.delete(oldest);
    }
    const fresh = { start: now, count: 0 };
    this.hits.delete(key);
    this.hits.set(key, fresh);
    return fresh;
  }

  /** `true` when `key` has used its budget for this window. */
  blocked(key: string): boolean {
    return this.entry(key).count >= this.limit;
  }

  /** Count one hit; `true` when it was within the budget. */
  charge(key: string): boolean {
    const entry = this.entry(key);
    entry.count += 1;
    return entry.count <= this.limit;
  }

  /** Use the rest of `key`'s budget (a shared limiter said it is spent). */
  exhaust(key: string): void {
    this.entry(key).count = this.limit;
  }
}

export interface ResponseLimits {
  /** Failed answers per check (charged only when an answer is refused). */
  perCheck: WindowLimiter;
  /** Calls per IP when the Worker has no `CREDENTIALS_RATE_LIMIT`. */
  perIp: WindowLimiter;
}

const isolateLimits: ResponseLimits = {
  perCheck: new WindowLimiter(FAILED_ANSWERS_PER_CHECK_PER_MINUTE),
  perIp: new WindowLimiter(RESPONSES_PER_IP_PER_MINUTE),
};

/** Runs the person's object's verification of one answer (its owner callback). */
export type VerifyInOwner = (
  env: OracleWorkerEnv,
  target: ResponseTarget,
  body: string,
) => Promise<{
  status: 200 | 400 | 404 | 410 | 503;
  body?: Record<string, string>;
}>;

const verifyInOwnerObject: VerifyInOwner = (env, target, body) => {
  const stub = env.USER_ORACLE.get(
    env.USER_ORACLE.idFromName(userObjectName(target.ownerDid, env.ORACLE_DID)),
  );
  return stub.ownerCallback(target.ownerDid, 'credentials', {
    key: target.checkId,
    body,
  });
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

function answer(
  status: number,
  body: Record<string, string> = {},
  headers: Record<string, string> = {},
): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'content-type': 'application/json',
      'cache-control': 'no-store',
      ...headers,
    },
  });
}

const NOTHING_HERE = {
  error: 'not_found',
  message: 'There is nothing to answer here.',
};

function tooMany(): Response {
  return answer(
    429,
    { error: 'rate_limited', message: 'Too many answers. Try again soon.' },
    { 'retry-after': '10' },
  );
}

/**
 * `POST /credentials/response/:token`, in this order: the plugin switched
 * on; the per-IP budget; the token (made here, not ended); the body (at
 * most 24 KiB, one encrypted answer for the check's key); the check's
 * budget of failed answers; then the person's object verifies it.
 *
 * 200 `{}` once a verified answer is stored (or one already was); 400 for a
 * body that is not an answer from the person; 404 for a token not made here
 * or ended, or the plugin off; 410 when the check has ended; 413 for a body
 * over the limit; 429 past a budget; 503 when the object or a dependency
 * could not be reached.
 */
export function credentialsResponseRoute(
  verify: VerifyInOwner = verifyInOwnerObject,
  limits: ResponseLimits = isolateLimits,
): PluginRoute {
  return {
    method: 'POST',
    path: RESPONSE_ROUTE_PATH,
    handler: async (request, env) => {
      const serviceKey = env.AUTH_HUB_CHANNEL_SERVICE_KEY;
      if (
        Reflect.get(env, 'CREDENTIALS_ENABLED') !== 'true' ||
        !serviceKey ||
        !env.ORACLE_DID
      )
        return answer(404, NOTHING_HERE);
      const ip = request.headers.get('cf-connecting-ip') ?? undefined;
      if (
        env.CREDENTIALS_RATE_LIMIT
          ? await ipOverLimit(
              env,
              'credentials-response',
              ip,
              env.CREDENTIALS_RATE_LIMIT,
            )
          : !limits.perIp.charge(ip ?? 'unknown')
      )
        return tooMany();
      const token = new URL(request.url).pathname.split('/').pop() ?? '';
      const target = await openResponseToken(token, {
        serviceKey,
        oracleDid: env.ORACLE_DID,
      });
      if (!target) return answer(404, NOTHING_HERE);
      const declared = Number(request.headers.get('content-length') ?? '0');
      if (declared > MAX_ANSWER_BYTES)
        return answer(413, {
          error: 'request_too_large',
          message: 'The answer is too large.',
        });
      const body = await readCapped(request, MAX_ANSWER_BYTES);
      if (body === 'too_large')
        return answer(413, {
          error: 'request_too_large',
          message: 'The answer is too large.',
        });
      if (!body || !isWellFormedDelivery(body, target.kid))
        return answer(400, {
          error: 'invalid_response',
          message: 'This is not an answer to this check.',
        });
      // Well-formed answers to a check whose budget of failed answers is
      // spent are not decrypted again this minute.
      if (limits.perCheck.blocked(target.checkId)) return tooMany();
      let verdict: Awaited<ReturnType<VerifyInOwner>>;
      try {
        verdict = await verify(env, target, body);
      } catch {
        return answer(503, {
          error: 'unavailable',
          message: 'Please try again in a moment.',
        });
      }
      if (verdict.status === 400) {
        limits.perCheck.charge(target.checkId);
        if (
          env.RATE_LIMIT &&
          !(
            await env.RATE_LIMIT.limit({
              key: rateLimitKey(env, 'credentials-check', target.checkId),
            })
          ).success
        )
          limits.perCheck.exhaust(target.checkId);
      }
      return answer(verdict.status, verdict.body ?? {});
    },
  };
}

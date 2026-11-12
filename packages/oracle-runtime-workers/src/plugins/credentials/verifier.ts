import {
  composeResolvers,
  createIxoResolver,
  createMemoryCache,
  createWebResolver,
  keysFor,
  ResolverUnavailable,
  type DidResolver,
  type KeyValueCache,
} from '@ixo/credentials-kit/did';
import {
  createAuthorizationRequest,
  decodeOwnAuthorizationRequest,
  generateResponseKeyPair,
  parseAuthorizationResponse,
  verifyAuthorizationResponse,
  type DcqlQuery,
  type P256PrivateJwk,
} from '@ixo/credentials-kit/oid4vp';
import { base64url } from '@ixo/credentials-kit/jose';
import { VerificationUnavailable } from '@ixo/credentials-kit/verify';

/**
 * The oracle as an OpenID4VP verifier, with `@ixo/credentials-kit`: the
 * signed request object (DCQL for one credential type, its accepted issuers
 * and the fields asked for, holder binding required, the answer encrypted
 * to a key of this check), and the verification of an answer.
 */

/** The one credential query of a check. */
export const QUERY_ID = 'credential';

export interface CredentialQuery {
  vct: string;
  issuers: string[];
  claims: string[];
}

/** DCQL for one credential of `vct` from one of `issuers`, disclosing `claims`. */
export function credentialDcql(query: CredentialQuery): DcqlQuery {
  return {
    credentials: [
      {
        id: QUERY_ID,
        format: 'dc+sd-jwt',
        meta: { vct_values: [query.vct] },
        claims: [
          ...query.claims.map((claim) => {
            const path: [string] = [claim];
            return { path };
          }),
          // The accepted-issuer filter: only these issuers' credentials.
          { path: ['iss'], values: [...query.issuers] },
        ],
        require_cryptographic_holder_binding: true,
      },
    ],
  };
}

/** A random token of `bytes` bytes, base64url without padding (URL-safe). */
export function randomToken(bytes = 24): string {
  const raw = crypto.getRandomValues(new Uint8Array(bytes));
  let binary = '';
  for (const byte of raw) binary += String.fromCharCode(byte);
  return btoa(binary)
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

function sameBytes(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= (a[i] ?? 0) ^ (b[i] ?? 0);
  return diff === 0;
}

/** The host's scoped signer (`ctx.ucan.signJws`, `ctx.ucan.oraclePublicKey`). */
export interface OracleJwsSigner {
  signJws: (input: {
    typ: 'oauth-authz-req+jwt';
    kid: string;
    payload: Record<string, unknown>;
  }) => Promise<{ jws: string } | { error: string }>;
  oraclePublicKey: () => Promise<Uint8Array | null>;
}

/** The JWS `typ` of an OpenID4VP request object, the one the host signs. */
const REQUEST_OBJECT_TYP = 'oauth-authz-req+jwt';

function jsonOfSegment(segment: string): unknown {
  return JSON.parse(new TextDecoder().decode(base64url.decode(segment)));
}

function isJsonObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/**
 * The kit's `Signer` over the host's scoped signer: the kit hands over the
 * bytes `<header>.<payload>` it wants signed; the adapter checks the header
 * is exactly the request object's, gives the host the payload, and returns
 * the signature only when the host signed those very bytes.
 */
export function requestObjectSigner(signer: OracleJwsSigner, kid: string) {
  return {
    kid,
    sign: async (bytes: Uint8Array): Promise<Uint8Array> => {
      const signingInput = new TextDecoder().decode(bytes);
      const [head, body, ...rest] = signingInput.split('.');
      if (!head || !body || rest.length > 0)
        throw new VerifierSetupError('no_signing_key');
      const header = jsonOfSegment(head);
      const payload = jsonOfSegment(body);
      if (
        !isJsonObject(header) ||
        header.alg !== 'EdDSA' ||
        header.typ !== REQUEST_OBJECT_TYP ||
        header.kid !== kid ||
        Object.keys(header).length !== 3 ||
        !isJsonObject(payload)
      )
        throw new VerifierSetupError('no_signing_key');
      const signed = await signer.signJws({
        typ: REQUEST_OBJECT_TYP,
        kid,
        payload,
      });
      if ('error' in signed || !signed.jws.startsWith(`${signingInput}.`))
        throw new VerifierSetupError('no_signing_key');
      return base64url.decode(signed.jws.slice(signingInput.length + 1));
    },
  };
}

export class VerifierSetupError extends Error {
  constructor(readonly code: 'no_signing_key' | 'key_not_on_did') {
    super(
      code === 'no_signing_key'
        ? 'The oracle cannot sign'
        : "The oracle's signing key is not on its DID document",
    );
    this.name = 'VerifierSetupError';
  }
}

/**
 * Per-isolate verifier dependencies: DID resolvers (did:ixo through
 * Blocksync, did:web), the status-list cache, and the `kid` of the oracle's
 * key on its own DID document (looked up once: the verification method
 * whose Ed25519 key is the key the oracle signs with).
 */
export class VerifierContext {
  readonly resolver: DidResolver;
  readonly statusCache: KeyValueCache;
  private kid: { did: string; kid: string } | null = null;

  constructor(
    blocksyncUrl: string,
    readonly allowLocal: boolean,
    // Never the bare global: workerd refuses `fetch` called as a method of
    // another object ("Illegal invocation"), which the kit reports as a
    // resolver being down.
    private readonly fetchImpl: typeof fetch = (input, init) =>
      fetch(input, init),
  ) {
    // A plain call, never `this.fetchImpl(...)`: a host's `kitFetch` may be
    // the global itself.
    const kitFetch = (input: string, init?: RequestInit) =>
      fetchImpl(input, init);
    const cache = createMemoryCache({ maxEntries: 512 });
    this.resolver = composeResolvers(
      createIxoResolver({ blocksyncUrl, fetch: kitFetch, cache }),
      createWebResolver({
        fetch: kitFetch,
        cache,
        ...(allowLocal ? { allowHttp: true, allowLocal: true } : {}),
      }),
    );
    this.statusCache = createMemoryCache({ maxEntries: 256 });
  }

  get fetch() {
    const fetchImpl = this.fetchImpl;
    return (input: string, init?: RequestInit) => fetchImpl(input, init);
  }

  /** The kid of the oracle's signing key on `oracleDid`'s document. */
  async oracleKid(oracleDid: string, signer: OracleJwsSigner): Promise<string> {
    if (this.kid?.did === oracleDid) return this.kid.kid;
    const publicKey = await signer.oraclePublicKey();
    if (!publicKey) throw new VerifierSetupError('no_signing_key');
    const doc = await this.resolver(oracleDid);
    const key = doc
      ? [
          ...keysFor(doc, 'assertionMethod'),
          ...keysFor(doc, 'authentication'),
        ].find((k) => sameBytes(k.publicKey, publicKey))
      : undefined;
    if (!key) throw new VerifierSetupError('key_not_on_did');
    this.kid = { did: oracleDid, kid: key.id };
    return key.id;
  }
}

/** One check's request: the signed object and the secrets kept for its answer. */
export interface BuiltRequest {
  requestJwt: string;
  privateJwk: P256PrivateJwk;
}

/** The answer's encryption keys: the public one goes in the request, with its `kid`. */
export type ResponseKeys = Awaited<ReturnType<typeof generateResponseKeyPair>>;

/** A fresh key pair for one check (P-256, `kid` `enc-…`). */
export function newResponseKeys(): Promise<ResponseKeys> {
  return generateResponseKeyPair();
}

export async function buildCredentialRequest(input: {
  verifier: VerifierContext;
  oracleDid: string;
  signer: OracleJwsSigner;
  responseUri: string;
  query: CredentialQuery;
  expiresAt: number;
  keys: ResponseKeys;
}): Promise<BuiltRequest> {
  const kid = await input.verifier.oracleKid(input.oracleDid, input.signer);
  const { keys } = input;
  const requestJwt = await createAuthorizationRequest({
    signer: requestObjectSigner(input.signer, kid),
    clientDid: input.oracleDid,
    responseUri: input.responseUri,
    nonce: randomToken(),
    state: randomToken(),
    dcql: credentialDcql(input.query),
    responseEncryptionJwk: keys.publicJwk,
    exp: input.expiresAt,
    ...(input.verifier.allowLocal ? { allowHttp: true, allowLocal: true } : {}),
  });
  return { requestJwt, privateJwk: keys.privateJwk };
}

export type CheckOutcome =
  | {
      result: 'valid';
      claims: Record<string, unknown>;
      issuer: string;
    }
  | { result: 'invalid' | 'revoked' | 'expired'; code: string };

/**
 * Verify one delivery to the check's response endpoint. `null` when it does
 * not prove to come from the person for this request (anyone holding the
 * public request object can post something): the check stays open. Throws
 * `VerificationUnavailable` / `ResolverUnavailable` when a dependency is
 * down (try again later; never a pass or a refusal).
 */
export async function verifyDelivery(input: {
  verifier: VerifierContext;
  body: string;
  requestJwt: string;
  privateJwk: P256PrivateJwk;
  subject: string;
  query: CredentialQuery;
}): Promise<CheckOutcome | null> {
  const request = decodeOwnAuthorizationRequest(input.requestJwt, {
    allowHttp: true,
    allowLocal: true,
  });
  let parsed;
  try {
    parsed = await parseAuthorizationResponse(input.body, {
      decryptionKey: input.privateJwk,
      request,
    });
  } catch (error) {
    // Junk, or a wallet error sent in the clear (it cannot be
    // authenticated): the worker's status says whether the person declined.
    // Anything but a dependency being down is a bad answer (malformed
    // JWE, wrong key, broken JSON): invalid, never a server fault.
    if (isVerificationUnavailable(error)) throw error;
    return null;
  }
  if (parsed.state !== request.state) return null;
  let out;
  try {
    out = await verifyAuthorizationResponse({
      vpToken: parsed.vpToken,
      request,
      state: parsed.state,
      policyFor: () => ({
        issuers: input.query.issuers,
        vcts: [input.query.vct],
        expectedSubject: input.subject,
      }),
      deps: {
        resolver: input.verifier.resolver,
        fetch: input.verifier.fetch,
        statusCache: input.verifier.statusCache,
        ...(input.verifier.allowLocal
          ? { allowHttp: true, allowLocal: true }
          : {}),
      },
    });
  } catch (error) {
    if (isVerificationUnavailable(error)) throw error;
    return null;
  }
  if (!out.holderAuthenticated) return null;
  const answer = out.results[QUERY_ID];
  if (out.ok && answer?.ok) {
    const claims: Record<string, unknown> = {};
    for (const name of input.query.claims)
      if (Object.hasOwn(answer.claims, name))
        claims[name] = answer.claims[name];
    return { result: 'valid', claims, issuer: answer.issuer };
  }
  const failed = Object.values(out.results).find((r) => !r.ok);
  const code = failed && !failed.ok ? failed.code : 'missing_presentation';
  if (code === 'revoked') return { result: 'revoked', code };
  if (code === 'expired') return { result: 'expired', code };
  return { result: 'invalid', code };
}

/** True for the kit's "a dependency is down" errors. */
export function isVerificationUnavailable(error: unknown): boolean {
  return (
    error instanceof VerificationUnavailable ||
    error instanceof ResolverUnavailable
  );
}

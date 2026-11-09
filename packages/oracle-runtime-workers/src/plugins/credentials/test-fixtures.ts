/**
 * Test doubles for the credentials plugin: a routing fetch, a UCAN adapter
 * that records what it was asked to sign, did:ixo parties with real
 * Ed25519 keys, and a WhatsApp runtime context.
 */
import { base58btc, signerFromEd25519Seed } from '@ixo/credentials-kit/jose';
import { makeRuntimeContext } from '../../core/test-fixtures';
import type { UcanAdapter } from '../../core/runtime-context';
import { createMemoryUserKv } from '../../core/user-kv';
import type { RuntimeContext, UserKvSurface } from '../../plugin-api/types';
import { resolveCredentialsConfig, type CredentialsConfig } from './config';

export const ORACLE_ADDRESS = 'ixo1n8yrmeatsk74dw0zs95ess9sgzptd6thgjgcj2';
export const PERSON_ADDRESS = 'ixo10e8pu63ee3p4y62wlu9myuyh2p08upm8xp4jw7';
export const ORACLE_DID = `did:ixo:${ORACLE_ADDRESS}`;
export const PERSON_DID = `did:ixo:${PERSON_ADDRESS}`;
export const ISSUER_DID = 'did:ixo:entity:00046b59059562e773694ea495bc1b23';
export const VCT = 'https://credentials.ixo.world/types/IdentityLevel1';
export const SERVICE_KEY = 'oracle-account-key-for-tests';
export const PUBLIC_URL = 'https://oracle.ixo.world';
export const BLOCKSYNC_URL = 'https://blocksync.ixo.world/graphql';

export const HUB = 'https://dev.auth.ixo.earth';
export const WORKER = 'https://dev.credentials.ixo.earth';
export const SELF = 'https://api.dev.self.ixo.earth';

/** A deterministic 32-byte seed from a label. */
export function seed(label: string): Uint8Array {
  const out = new Uint8Array(32);
  const bytes = new TextEncoder().encode(label);
  for (let i = 0; i < 32; i++)
    out[i] = ((bytes[i % bytes.length] ?? 0) + i * 7) & 0xff;
  return out;
}

/** A did:ixo party as Blocksync serves it: `<did>#<base58 key>` under both relationships. */
export function party(label: string, did: string) {
  const s = seed(label);
  const probe = signerFromEd25519Seed(s, 'x');
  const kid = `${did}#${base58btc.encode(probe.publicKey)}`;
  const signer = signerFromEd25519Seed(s, kid);
  return {
    did,
    signer,
    doc: {
      id: did,
      controller: [did],
      verificationMethod: [
        {
          id: kid,
          type: 'Ed25519VerificationKey2018',
          controller: did,
          publicKeyBase58: base58btc.encode(signer.publicKey),
        },
      ],
      authentication: [kid],
      assertionMethod: [kid],
    },
  };
}

export const json = (
  body: unknown,
  status = 200,
  headers: Record<string, string> = {},
) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  });

export interface RecordedCall {
  method: string;
  url: string;
  headers: Headers;
  body: string;
}

type Route = (call: RecordedCall) => Response | Promise<Response>;

/** A Request-based fetch double routing on `METHOD url` (query kept). */
export function routedFetch(routes: Record<string, Route | Route[]>) {
  const calls: RecordedCall[] = [];
  const seen = new Map<string, number>();
  const fetchImpl = async (request: Request): Promise<Response> => {
    const call: RecordedCall = {
      method: request.method,
      url: request.url,
      headers: request.headers,
      body: request.method === 'GET' ? '' : await request.text(),
    };
    calls.push(call);
    const key = `${request.method} ${request.url}`;
    const route = routes[key];
    if (!route) return json({ error: 'not_found', message: 'no route' }, 404);
    if (Array.isArray(route)) {
      const n = seen.get(key) ?? 0;
      seen.set(key, n + 1);
      const step = route[Math.min(n, route.length - 1)];
      return step ? step(call) : json({}, 500);
    }
    return route(call);
  };
  return { fetchImpl, calls };
}

export interface MintRecord {
  kind: 'self-signed' | 'delegated';
  audience: string;
  capability: { can: string; with: string };
  facts: readonly Record<string, unknown>[];
  delegation?: string;
}

/** A UCAN adapter that signs with a real key and records every mint. */
export function recordingUcan(oracleSeedLabel = 'oracle') {
  const mints: MintRecord[] = [];
  const oracleKey = party(oracleSeedLabel, ORACLE_DID);
  let n = 0;
  const adapter: UcanAdapter = {
    hasCapability: () => true,
    requireCapability: () => undefined,
    mintInvocation: async () => 'unused',
    resolveServiceDid: async () => null,
    hasSigningKey: () => true,
    createInvocationFromDelegation: async (
      delegation,
      audience,
      capability,
      options,
    ) => {
      mints.push({
        kind: 'delegated',
        audience,
        capability,
        facts: options?.facts ?? [],
        delegation,
      });
      return { invocation: `inv-${++n}` };
    },
    mintSelfSignedInvocation: async (audience, capability, options) => {
      mints.push({
        kind: 'self-signed',
        audience,
        capability,
        facts: options?.facts ?? [],
      });
      return { invocation: `inv-${++n}` };
    },
    signWithOracleKey: async (bytes) => ({
      signature: await oracleKey.signer.sign(bytes),
      publicKey: oracleKey.signer.publicKey,
    }),
    getServiceDelegation: async () => ({ error: 'no-delegation' as const }),
  };
  return { adapter, mints, oracleKey };
}

export const BINDING = { bindingId: 'bind_1', bindingRevision: 3 };

/** A turn from our WhatsApp channel (or another surface with `client`/`provider`). */
export function channelCtx(
  ucan: UcanAdapter,
  opts: {
    kv?: UserKvSurface;
    client?: RuntimeContext['session']['client'];
    provider?: string;
    timezone?: string;
  } = {},
): RuntimeContext {
  const base = makeRuntimeContext({}, { ambient: { ucan } });
  const client = opts.client ?? 'channel';
  return {
    ...base,
    user: {
      ...base.user,
      did: PERSON_DID,
      ...(opts.timezone ? { timezone: opts.timezone } : {}),
    },
    session: {
      ...base.session,
      client,
      runId: 'run-1',
      ...(client === 'channel'
        ? { channel: { provider: opts.provider ?? 'whatsapp', ...BINDING } }
        : {}),
    },
    toolCallId: 'call-1',
    kv: opts.kv ?? createMemoryUserKv(),
  };
}

/** The plugin's config on devnet, every key set. */
export function testConfig(
  overrides: Record<string, unknown> = {},
): CredentialsConfig {
  return resolveCredentialsConfig({
    NETWORK: 'devnet',
    ORACLE_DID,
    ORACLE_ENTITY_DID: 'did:ixo:entity:309db22aa6e41e3929597dcb185a23be',
    ORACLE_PUBLIC_URL: PUBLIC_URL,
    BLOCKSYNC_GRAPHQL_URL: BLOCKSYNC_URL,
    CREDENTIALS_ENABLED: 'true',
    AUTH_HUB_CHANNEL_SERVICE_KEY: SERVICE_KEY,
    ...overrides,
  });
}

export const noSleep = async () => undefined;

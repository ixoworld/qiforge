/**
 * Helpers for driving the local ixo testing harness
 * (`~/dev/ixo/testing-harness`: Synapse `ixo.test` on :34008, Blocksync
 * GraphQL on :34582, static users tester/alice/bob/charlie) from the E2E and
 * stress scripts. Everything here is local-dev only.
 */
import { spawn } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  createDelegation,
  createInvocation,
  serializeDelegation,
  serializeInvocation,
  signerFromMnemonic,
  type Capability,
} from '@ixo/ucan';

export const HARNESS_DIR =
  process.env.IXO_HARNESS_DIR ??
  join(process.env.HOME ?? '', 'dev/ixo/testing-harness');
export const MATRIX_BASE_URL =
  process.env.MATRIX_TEST_BASE_URL ?? 'http://localhost:34008';
export const MATRIX_SERVER_NAME = 'ixo.test';
export const BLOCKSYNC_GRAPHQL_URL =
  process.env.BLOCKSYNC_GRAPHQL_URL ?? 'http://localhost:34582/graphql';
export const REGISTRATION_TOKEN = 'ixo-harness-registration-token';

const HERE = dirname(fileURLToPath(import.meta.url));
const ACCOUNTS_FILE = join(HERE, '..', '.accounts.json');

export interface HarnessAccount {
  name: string;
  address: string;
  did: string;
  /** Ed25519 mnemonic registered as a verification method on the IID — signs UCANs. */
  edSigningMnemonic: string;
  matrixUserId: string;
  matrixPassword: string;
  matrixMnemonic: string;
}

/** The four users the harness snapshot registers end-to-end (docs/CREDENTIALS.md). */
export const STATIC_ACCOUNTS: HarnessAccount[] = [
  {
    name: 'tester',
    address: 'ixo1n8yrmeatsk74dw0zs95ess9sgzptd6thgjgcj2',
    did: 'did:ixo:ixo1n8yrmeatsk74dw0zs95ess9sgzptd6thgjgcj2',
    edSigningMnemonic:
      'hobby engage pluck hospital ketchup render crazy tip tuition situate maze silly',
    matrixUserId:
      '@did-ixo-ixo1n8yrmeatsk74dw0zs95ess9sgzptd6thgjgcj2:ixo.test',
    matrixPassword: 'ZGYxOGQ4YzRiOTliY2E0ZWUy',
    matrixMnemonic:
      'scare ticket combine noodle ready fly gossip smooth two parade dial tank',
  },
  {
    name: 'alice',
    address: 'ixo12am7v5xgjh72c7xujreyvtncqwue3w0v6ud3r4',
    did: 'did:ixo:ixo12am7v5xgjh72c7xujreyvtncqwue3w0v6ud3r4',
    edSigningMnemonic:
      'gospel state question leave rate upon word dawn skull asset leader short',
    matrixUserId:
      '@did-ixo-ixo12am7v5xgjh72c7xujreyvtncqwue3w0v6ud3r4:ixo.test',
    matrixPassword: 'MzUyZDQ1MWQyYjk5ODY0ZDhk',
    matrixMnemonic:
      'wing gossip super history jeans shell ugly diet spice scorpion inside bulb',
  },
  {
    name: 'bob',
    address: 'ixo13dy867pyn8jda82vnshy7jjjv42n69k7497jrh',
    did: 'did:ixo:ixo13dy867pyn8jda82vnshy7jjjv42n69k7497jrh',
    edSigningMnemonic:
      'volume senior daughter accuse mystery cover tonight uncle simple crash panic caution',
    matrixUserId:
      '@did-ixo-ixo13dy867pyn8jda82vnshy7jjjv42n69k7497jrh:ixo.test',
    matrixPassword: 'NWZkNTAwNTkxNjdlOTE1MmQ4',
    matrixMnemonic:
      'slush egg symptom display document clarify run void october arrive festival term',
  },
  {
    name: 'charlie',
    address: 'ixo1fewufqrjy0r8kercq3wazsr7v0cymhvgteq442',
    did: 'did:ixo:ixo1fewufqrjy0r8kercq3wazsr7v0cymhvgteq442',
    edSigningMnemonic:
      'coffee annual day strategy robot sense supreme salon canoe kind swallow outside',
    matrixUserId:
      '@did-ixo-ixo1fewufqrjy0r8kercq3wazsr7v0cymhvgteq442:ixo.test',
    matrixPassword: 'ZGUzNjc1MWQwOWMyNTlhNjQ5',
    matrixMnemonic:
      'betray wheel remove ill mansion rug balcony shuffle climb elbow section favorite',
  },
];

interface CreatedAccountJson {
  name: string;
  address: string;
  did: string;
  matrixMnemonic: string;
  edSigningMnemonic: string;
  matrix?: { userId?: string; password?: string };
}

function loadCreated(): HarnessAccount[] {
  if (!existsSync(ACCOUNTS_FILE)) return [];
  return JSON.parse(readFileSync(ACCOUNTS_FILE, 'utf8')) as HarnessAccount[];
}

/** Mint a brand-new fully registered harness account via `create-account.mjs`. */
export async function createHarnessAccount(
  name: string,
): Promise<HarnessAccount> {
  const out = await run(
    'node',
    ['scripts/create-account.mjs', '--name', name],
    HARNESS_DIR,
    240_000,
  );
  const marker = out.indexOf('=== new account');
  if (marker === -1)
    throw new Error(
      `create-account.mjs produced no account JSON:\n${out.slice(-2000)}`,
    );
  const jsonStart = out.indexOf('{', marker);
  const json = JSON.parse(out.slice(jsonStart)) as CreatedAccountJson;
  const matrixUserId =
    json.matrix?.userId ?? `@did-ixo-${json.address}:${MATRIX_SERVER_NAME}`;
  const matrixPassword =
    json.matrix?.password ?? passwordFromMnemonic(json.matrixMnemonic);
  const account: HarnessAccount = {
    name: json.name,
    address: json.address,
    did: json.did,
    edSigningMnemonic: json.edSigningMnemonic,
    matrixUserId,
    matrixPassword,
    matrixMnemonic: json.matrixMnemonic,
  };
  const all = loadCreated().filter((a) => a.name !== name);
  all.push(account);
  writeFileSync(ACCOUNTS_FILE, JSON.stringify(all, null, 2));
  return account;
}

/** `password = base64(utf8(md5hex(mnemonic without spaces))).slice(0,24)` (docs/CREDENTIALS.md). */
export function passwordFromMnemonic(mnemonic: string): string {
  const md5 = createMd5Hex(mnemonic.replace(/ /g, ''));
  return Buffer.from(md5, 'utf8').toString('base64').slice(0, 24);
}

async function createMd5HexAsync(input: string): Promise<string> {
  const { createHash } = await import('node:crypto');
  return createHash('md5').update(input).digest('hex');
}
// Synchronous variant for the helper above (node:crypto is always available here).
function createMd5Hex(input: string): string {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { createHash } = require('node:crypto') as typeof import('node:crypto');
  return createHash('md5').update(input).digest('hex');
}
void createMd5HexAsync;

export const ORACLE_ACCOUNT_NAME = 'qf-workers-oracle';

/** A cached-or-created named account (mirrors `ensureOracleAccount`). */
export async function ensureNamedAccount(
  name: string,
): Promise<HarnessAccount> {
  const cached = loadCreated().find((a) => a.name === name);
  if (cached) return cached;
  console.log(`[harness] creating account ${name} …`);
  return createHarnessAccount(name);
}

/**
 * The oracle's own on-chain identity: the UCAN validator resolves the
 * oracle DID through Blocksync, so it must be a registered IID. Its Matrix
 * account (`@did-ixo-<addr>:ixo.test`) doubles as the bot account — exactly
 * how production oracles are identified.
 */
export async function ensureOracleAccount(): Promise<HarnessAccount> {
  const cached = loadCreated().find((a) => a.name === ORACLE_ACCOUNT_NAME);
  if (cached) return cached;
  console.log(`[harness] creating oracle account ${ORACLE_ACCOUNT_NAME} …`);
  return createHarnessAccount(ORACLE_ACCOUNT_NAME);
}

/** Return `n` user accounts: the static four first, then cached/created ones. */
export async function ensureAccounts(n: number): Promise<HarnessAccount[]> {
  const accounts = [
    ...STATIC_ACCOUNTS,
    ...loadCreated().filter((a) => a.name !== ORACLE_ACCOUNT_NAME),
  ];
  let i = accounts.length;
  while (accounts.length < n) {
    const name = `qf-workers-${i++}`;
    console.log(`[harness] creating account ${name} …`);
    accounts.push(await createHarnessAccount(name));
  }
  return accounts.slice(0, n);
}

// --- UCAN ------------------------------------------------------------------

const AUTH_CAPABILITY: Capability = { can: '*', with: 'ixo:oracle' };

export async function mintAuthInvocation(
  account: HarnessAccount,
  oracleDid: string,
  ttlSec = 300,
): Promise<string> {
  const { signer } = await signerFromMnemonic(
    account.edSigningMnemonic,
    account.did as `did:ixo:${string}`,
  );
  const invocation = await createInvocation({
    issuer: signer,
    audience: oracleDid,
    capability: AUTH_CAPABILITY,
    proofs: [],
    expiration: Math.floor(Date.now() / 1000) + ttlSec,
  });
  return serializeInvocation(invocation);
}

export async function mintDelegation(
  account: HarnessAccount,
  oracleDid: string,
  capabilities: Capability[],
  ttlSec = 7 * 24 * 3600,
): Promise<string> {
  const { signer } = await signerFromMnemonic(
    account.edSigningMnemonic,
    account.did as `did:ixo:${string}`,
  );
  const delegation = await createDelegation({
    issuer: signer,
    audience: oracleDid,
    capabilities,
    expiration: Math.floor(Date.now() / 1000) + ttlSec,
  });
  return serializeDelegation(delegation);
}

// --- VFS / UCAN-store workers (scripts/vfs-workers.sh) ------------------------

export const VFS_BASE_URL =
  process.env.VFS_BASE_URL ?? 'http://localhost:34670';
export const UCAN_STORE_URL =
  process.env.UCAN_STORE_URL ?? 'http://localhost:34671';

/** Resolve a worker's did:web from its `/.well-known/did.json`. */
export async function resolveServiceDid(serviceUrl: string): Promise<string> {
  const res = await fetchWithRetry(`${serviceUrl}/.well-known/did.json`);
  if (!res.ok)
    throw new Error(`${serviceUrl}/.well-known/did.json → ${res.status}`);
  const doc = (await res.json()) as { id?: string };
  if (!doc.id) throw new Error(`${serviceUrl} did.json has no id`);
  return doc.id;
}

/**
 * The capability the user's ONE delegation to the oracle must carry for the
 * Workers runtime to keep the owner copy in the user's VFS — the Portal
 * mints it into the same delegation as the sandbox/memory/skills grants.
 * All three parts matter:
 *   - `can: '*'`   — the VFS grant lattice has no `fs/*` entry; `'*'` is the
 *     owner grant that covers fs/read|write|list|delete.
 *   - `with: 'ixo:filesystem/.oracles'` — the user's own namespace, scoped to
 *     the dot-folder that holds per-oracle state (the whole personal library
 *     `ixo:filesystem` would qualify too; nothing narrower does).
 *   - `nb.hidden: ['/.oracles']` — the state file lives in a dot-folder, so
 *     it is HIDDEN by the VFS dotfile convention; this reveal (intersected
 *     with the oracle's own `nb.hidden: ['*']` invocations) is what lets the
 *     oracle see the `/.oracles` subtree — and nothing else that is hidden.
 */
export const VFS_OWNER_COPY_CAPABILITY: Capability = {
  can: '*',
  with: 'ixo:filesystem/.oracles',
  nb: { hidden: ['/.oracles'] },
} as Capability;

/**
 * The library-wide grant the vfs PLUGIN's file tools (`vfs_read`, `vfs_write`,
 * …) resolve from the UCAN store worker — a separate, user-initiated share
 * of the whole personal filesystem, unrelated to the owner copy above. The
 * user mints it to the oracle and deposits it with a self-signed `store/add`.
 */
export async function depositVfsDelegation(
  account: HarnessAccount,
  oracleDid: string,
  storeUrl: string = UCAN_STORE_URL,
  ttlSec = 7 * 24 * 3600,
): Promise<{ cid: string; token: string }> {
  const { signer } = await signerFromMnemonic(
    account.edSigningMnemonic,
    account.did as `did:ixo:${string}`,
  );
  const delegation = await createDelegation({
    issuer: signer,
    audience: oracleDid,
    capabilities: [
      { can: '*', with: 'ixo:filesystem', nb: { hidden: ['/.oracles'] } },
    ],
    expiration: Math.floor(Date.now() / 1000) + ttlSec,
  });
  const token = await serializeDelegation(delegation);

  const storeDid = await resolveServiceDid(storeUrl);
  const invocation = await createInvocation({
    issuer: signer,
    audience: storeDid,
    capability: { can: 'store/add', with: 'ixo:ucan-store' },
    proofs: [],
    expiration: Math.floor(Date.now() / 1000) + 300,
    facts: [{ nonce: crypto.randomUUID() }],
  });
  const res = await fetch(`${storeUrl}/api/delegations`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${await serializeInvocation(invocation)}`,
      'x-auth-type': 'ucan',
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      token,
      note: `qiforge-workers e2e: VFS grant for ${oracleDid}`,
    }),
  });
  if (res.status !== 200 && res.status !== 201)
    throw new Error(`deposit delegation → ${res.status}: ${await res.text()}`);
  const body = (await res.json()) as { delegation: { cid: string } };
  return { cid: body.delegation.cid, token };
}

/**
 * `fetch` with one retry when the CONNECTION fails (`TypeError: fetch
 * failed` — DNS/VPN/network blips on the test machine). A failure after the
 * request reached the server is not retried, so turns are never doubled.
 */
export async function fetchWithRetry(
  input: string | URL,
  init?: RequestInit,
): Promise<Response> {
  let last: unknown;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      return await fetch(input, init);
    } catch (err) {
      if (!/fetch failed/i.test(String(err))) throw err;
      last = err;
      await new Promise((resolve) => setTimeout(resolve, 2000 * (attempt + 1)));
    }
  }
  const cause =
    last instanceof Error && last.cause instanceof Error
      ? last.cause.message
      : String((last as { cause?: unknown } | undefined)?.cause ?? '');
  throw new Error(
    `fetch failed after 3 attempts: ${init?.method ?? 'GET'} ${String(input)}${cause ? ` (cause: ${cause})` : ''}`,
  );
}

/**
 * Call the VFS worker AS THE USER (namespace owner): a fresh self-signed
 * single-use invocation per request. `nb.hidden: ['*']` reveals the user's
 * own hidden files (an owner token — nothing to attenuate against).
 */
export async function vfsUserRequest(
  account: HarnessAccount,
  can: 'fs/list' | 'fs/read' | 'fs/write' | 'fs/delete',
  method: string,
  pathAndQuery: string,
  opts: { body?: string; contentType?: string; vfsUrl?: string } = {},
): Promise<Response> {
  const vfsUrl = opts.vfsUrl ?? VFS_BASE_URL;
  const { signer } = await signerFromMnemonic(
    account.edSigningMnemonic,
    account.did as `did:ixo:${string}`,
  );
  const invocation = await createInvocation({
    issuer: signer,
    audience: await resolveServiceDid(vfsUrl),
    capability: { can, with: 'ixo:filesystem', nb: { hidden: ['*'] } },
    proofs: [],
    expiration: Math.floor(Date.now() / 1000) + 120,
    facts: [{ nonce: crypto.randomUUID() }],
  });
  return fetchWithRetry(`${vfsUrl}/api/fs${pathAndQuery}`, {
    method,
    headers: {
      authorization: `Bearer ${await serializeInvocation(invocation)}`,
      'x-auth-type': 'ucan',
      ...(opts.body !== undefined
        ? { 'content-type': opts.contentType ?? 'application/json' }
        : {}),
    },
    ...(opts.body !== undefined ? { body: opts.body } : {}),
  });
}

// --- Matrix -------------------------------------------------------------------

export interface MatrixSession {
  userId: string;
  accessToken: string;
  deviceId: string;
}

export async function matrixLogin(
  userId: string,
  password: string,
): Promise<MatrixSession> {
  const res = await fetch(`${MATRIX_BASE_URL}/_matrix/client/v3/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      type: 'm.login.password',
      identifier: { type: 'm.id.user', user: userId },
      password,
      initial_device_display_name: 'qiforge-workers e2e',
    }),
  });
  if (!res.ok)
    throw new Error(
      `matrix login ${userId} failed: ${res.status} ${await res.text()}`,
    );
  const body = (await res.json()) as {
    user_id: string;
    access_token: string;
    device_id: string;
  };
  return {
    userId: body.user_id,
    accessToken: body.access_token,
    deviceId: body.device_id,
  };
}

export async function matrixRequest<T>(
  session: MatrixSession,
  method: string,
  path: string,
  body?: unknown,
): Promise<T> {
  const res = await fetch(`${MATRIX_BASE_URL}${path}`, {
    method,
    headers: {
      authorization: `Bearer ${session.accessToken}`,
      'content-type': 'application/json',
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`${method} ${path} → ${res.status} ${text}`);
  return (text ? JSON.parse(text) : {}) as T;
}

/** The harness rooms appservice (`appservice-rooms.yaml`): owns `#did-ixo-*` aliases. */
export const APPSERVICE_BOT = `@ixo-room-bot:${MATRIX_SERVER_NAME}`;
const APPSERVICE_AS_TOKEN = 'ixo-harness-asrooms-as-token';

/** Call the client API as the appservice bot (`as_token` + `user_id` masquerade). */
export async function appserviceRequest<T>(
  method: string,
  path: string,
  body?: unknown,
): Promise<T> {
  const sep = path.includes('?') ? '&' : '?';
  const res = await fetch(
    `${MATRIX_BASE_URL}${path}${sep}user_id=${encodeURIComponent(APPSERVICE_BOT)}`,
    {
      method,
      headers: {
        authorization: `Bearer ${APPSERVICE_AS_TOKEN}`,
        'content-type': 'application/json',
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    },
  );
  const text = await res.text();
  if (!res.ok)
    throw new Error(`[appservice] ${method} ${path} → ${res.status} ${text}`);
  return (text ? JSON.parse(text) : {}) as T;
}

// --- process helpers ------------------------------------------------------------

export function run(
  cmd: string,
  args: string[],
  cwd: string,
  timeoutMs = 120_000,
): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { cwd, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    child.stdout.on('data', (d: Buffer) => (out += d.toString()));
    child.stderr.on('data', (d: Buffer) => (out += d.toString()));
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(
        new Error(
          `${cmd} ${args.join(' ')} timed out after ${timeoutMs}ms\n${out.slice(-2000)}`,
        ),
      );
    }, timeoutMs);
    child.on('exit', (code) => {
      clearTimeout(timer);
      if (code === 0) resolve(out);
      else
        reject(
          new Error(
            `${cmd} ${args.join(' ')} exited ${code}\n${out.slice(-3000)}`,
          ),
        );
    });
  });
}

export async function waitFor(
  fn: () => Promise<boolean>,
  timeoutMs: number,
  label: string,
  intervalMs = 500,
): Promise<void> {
  const start = Date.now();
  for (;;) {
    if (await fn().catch(() => false)) return;
    if (Date.now() - start > timeoutMs)
      throw new Error(`Timed out waiting for ${label}`);
    await new Promise((r) => setTimeout(r, intervalMs));
  }
}

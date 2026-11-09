import { z } from 'zod';
import { CredentialsServiceError } from './errors';
import { callService, type FetchLike } from './http';
import { canonicalJson, jsonBodySha256 } from './hub-client';

/**
 * The Credentials worker, called by the oracle as a verifier: its verifier
 * entry in the catalog (the name and the checks the person's wallet shows),
 * and presentation requests (deposit, status, cancel).
 *
 * Writes are UCAN invocations issued by the oracle's own DID to the
 * worker's did:web, capability `credentials/verify` on `ixo:credentials`,
 * bound to the call by a `{ method, path }` fact. Catalog reads are public.
 */

export const VERIFY_CAPABILITY = {
  can: 'credentials/verify',
  with: 'ixo:credentials',
} as const;

/** Catalog limits (the worker refuses larger entries). */
const MAX_ACCEPTS = 50;
const MAX_CLAIMS = 100;
const MAX_ISSUERS = 50;

/** One check the verifier declares: a type, its fields, the issuers it accepts. */
export interface VerifierAccept {
  purpose: string;
  vct: string;
  claims: string[];
  issuers: string[];
}

const Accept = z.object({
  purpose: z.string().min(1).max(140),
  vct: z.string().min(1).max(512),
  claims: z.array(z.string().min(1).max(100)).max(MAX_CLAIMS),
  issuers: z.array(z.string().min(1).max(256)).max(MAX_ISSUERS),
});

const VerifierRecord = z.object({
  entry: z.object({
    did: z.string(),
    name: z.string(),
    description: z.string().optional(),
    url: z.string().optional(),
    accepts: z.array(Accept).max(MAX_ACCEPTS),
    logo_uri: z.string().optional(),
    color: z.string().optional(),
  }),
});
export type VerifierEntry = z.infer<typeof VerifierRecord>['entry'];

const Deposited = z.object({
  id: z.string().regex(/^[A-Za-z0-9_-]{1,128}$/),
  request_uri: z.string().url(),
  wallet_url: z.string().url().optional(),
  status: z.enum(['pending', 'answered', 'declined', 'cancelled', 'expired']),
});
export type DepositedRequest = z.infer<typeof Deposited>;

const RequestView = z.object({
  id: z.string(),
  status: z.enum(['pending', 'answered', 'declined', 'cancelled', 'expired']),
  expires_at: z.number().int().optional(),
});
export type RequestView = z.infer<typeof RequestView>;

function sortedUnique(values: readonly string[]): string[] {
  return [...new Set(values)].sort();
}

/**
 * `entry` with `need` declared: the accept for the same type gains the
 * missing fields and issuers, or a new accept is added. `changed` is false
 * when the entry already covers it (nothing to write). `null` when the
 * entry would grow past the catalog's limits (it is left as it is; the
 * person's wallet then notes that the request asks for more than is
 * published).
 */
export function mergeVerifierAccept(
  entry: Pick<VerifierEntry, 'accepts'>,
  need: VerifierAccept,
): { accepts: VerifierAccept[]; changed: boolean } | null {
  const accepts = entry.accepts.map((a) => ({
    ...a,
    claims: [...a.claims],
    issuers: [...a.issuers],
  }));
  const index = accepts.findIndex((a) => a.vct === need.vct);
  if (index < 0) {
    if (accepts.length >= MAX_ACCEPTS) return null;
    accepts.push({
      purpose: need.purpose,
      vct: need.vct,
      claims: sortedUnique(need.claims),
      issuers: sortedUnique(need.issuers),
    });
    return { accepts, changed: true };
  }
  const current = accepts[index];
  if (!current) return null;
  const claims = sortedUnique([...current.claims, ...need.claims]);
  const issuers = sortedUnique([...current.issuers, ...need.issuers]);
  if (claims.length > MAX_CLAIMS || issuers.length > MAX_ISSUERS) return null;
  const changed =
    claims.length !== new Set(current.claims).size ||
    issuers.length !== new Set(current.issuers).size;
  accepts[index] = { ...current, claims, issuers };
  return { accepts, changed };
}

/** Mints one self-signed invocation to the worker, bound by `facts`. */
export type MintWorkerInvocation = (
  facts: Record<string, unknown>[],
) => Promise<string>;

export interface CredentialsWorkerClientOptions {
  baseUrl: string;
  mint: MintWorkerInvocation;
  fetchImpl?: FetchLike;
  timeoutMs?: number;
  sleep?: (ms: number) => Promise<void>;
  /** The tool's deadline (unix ms), see `ServiceCall.deadline`. */
  deadline?: number;
  now?: () => number;
}

export class CredentialsWorkerClient {
  private readonly origin: string;

  constructor(private readonly opts: CredentialsWorkerClientOptions) {
    this.origin = new URL(opts.baseUrl).origin;
  }

  private invalid(): never {
    throw new CredentialsServiceError({
      service: 'credentials',
      status: 502,
      code: 'invalid_response',
    });
  }

  /**
   * One signed call. A body is sent in its canonical form and bound by the
   * first fact: `{ method, path, body_sha256 }`.
   */
  private async signed(
    method: 'GET' | 'POST' | 'PUT',
    path: string,
    json?: unknown,
  ) {
    const body = json === undefined ? undefined : canonicalJson(json);
    const fact =
      json === undefined
        ? { method, path }
        : { method, path, body_sha256: await jsonBodySha256(json) };
    return {
      service: 'credentials' as const,
      method,
      url: `${this.origin}${path}`,
      prepare: async () => ({
        headers: {
          authorization: `Bearer ${await this.opts.mint([fact])}`,
          ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
        },
        ...(body !== undefined ? { body } : {}),
      }),
      ...this.transport(),
    };
  }

  /** The oracle's verifier entry, or null when it has none yet. */
  async getVerifierEntry(did: string): Promise<VerifierEntry | null> {
    try {
      const answer = await callService({
        service: 'credentials',
        method: 'GET',
        url: `${this.origin}/v1/catalog/verifiers/${did}`,
        prepare: async () => ({ headers: {} }),
        ...this.transport(),
      });
      const parsed = VerifierRecord.safeParse(answer.body);
      if (!parsed.success) this.invalid();
      return parsed.data.entry;
    } catch (error) {
      if (error instanceof CredentialsServiceError && error.status === 404)
        return null;
      throw error;
    }
  }

  async putVerifierEntry(entry: VerifierEntry): Promise<void> {
    await callService(
      await this.signed('PUT', `/v1/catalog/verifiers/${entry.did}`, entry),
    );
  }

  /** Deposit a signed request object for `subject`; idempotent on `ref`. */
  async deposit(input: {
    subject: string;
    ref: string;
    request: string;
    purpose: string;
    expiresAt: number;
  }): Promise<DepositedRequest> {
    const answer = await callService(
      await this.signed('POST', '/v1/requests', {
        subject: input.subject,
        ref: input.ref,
        request: input.request,
        purpose: input.purpose,
        expires_at: input.expiresAt,
      }),
    );
    const parsed = Deposited.safeParse(answer.body);
    if (!parsed.success) this.invalid();
    return parsed.data;
  }

  /** The verifier's view of a request: its status only. */
  async requestStatus(id: string): Promise<RequestView> {
    const path = `/v1/requests/${encodeURIComponent(id)}`;
    const answer = await callService(await this.signed('GET', path));
    const parsed = RequestView.safeParse(answer.body);
    if (!parsed.success || parsed.data.id !== id) this.invalid();
    return parsed.data;
  }

  private transport() {
    return {
      ...(this.opts.fetchImpl ? { fetchImpl: this.opts.fetchImpl } : {}),
      ...(this.opts.timeoutMs ? { timeoutMs: this.opts.timeoutMs } : {}),
      ...(this.opts.sleep ? { sleep: this.opts.sleep } : {}),
      ...(this.opts.deadline !== undefined
        ? { deadline: this.opts.deadline }
        : {}),
      ...(this.opts.now ? { now: this.opts.now } : {}),
    };
  }
}

/** How long one isolate trusts that the catalog entry covers a check. */
export const VERIFIER_ENTRY_MEMO_MS = 60 * 60 * 1000;
/** Distinct checks one isolate remembers (oldest dropped first). */
const VERIFIER_ENTRY_MEMO_SIZE = 256;

/**
 * Per-isolate memo of the checks whose catalog entry is known to be
 * published, with in-flight dedupe: concurrent checks for the same need
 * share one GET (and at most one PUT).
 */
export class VerifierEntryMemo {
  private readonly done = new Map<string, number>();
  private readonly inFlight = new Map<string, Promise<void>>();

  constructor(private readonly now: () => number = Date.now) {}

  private keyOf(did: string, baseUrl: string, need: VerifierAccept): string {
    return JSON.stringify([
      baseUrl,
      did,
      need.vct,
      sortedUnique(need.claims),
      sortedUnique(need.issuers),
    ]);
  }

  /**
   * Make sure the oracle's entry declares `need`: read it, merge, write it
   * when it changed. Name and description come from the oracle's config.
   */
  async ensure(
    client: CredentialsWorkerClient,
    baseUrl: string,
    identity: { did: string; name: string; description?: string },
    need: VerifierAccept,
  ): Promise<void> {
    const key = this.keyOf(identity.did, baseUrl, need);
    const until = this.done.get(key);
    if (until !== undefined && until > this.now()) return;
    const pending = this.inFlight.get(key);
    if (pending) return pending;
    const work = (async () => {
      const current = await client.getVerifierEntry(identity.did);
      const merged = mergeVerifierAccept(current ?? { accepts: [] }, need);
      const description = identity.description?.slice(0, 1000);
      const name = identity.name.slice(0, 100);
      const renamed =
        !current ||
        current.name !== name ||
        (description !== undefined && current.description !== description);
      if (merged && (merged.changed || renamed))
        await client.putVerifierEntry({
          ...(current ?? {}),
          did: identity.did,
          name,
          ...(description ? { description } : {}),
          accepts: merged.accepts,
        });
      if (this.done.size >= VERIFIER_ENTRY_MEMO_SIZE) {
        const oldest = this.done.keys().next().value;
        if (oldest !== undefined) this.done.delete(oldest);
      }
      this.done.set(key, this.now() + VERIFIER_ENTRY_MEMO_MS);
    })().finally(() => {
      this.inFlight.delete(key);
    });
    this.inFlight.set(key, work);
    return work;
  }
}

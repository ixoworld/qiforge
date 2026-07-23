import type { Logger } from '../../plugin-api/types.js';
import { ContractRecordSchema, type ContractRecord } from './types.js';
import { errorMessage } from './util.js';

/** Per-subscriber cache lifetime — matches the engine's own ~5 min cache. */
const RECORD_CACHE_TTL_MS = 300_000;

/** The resource the oracle-signed invocation targets on the engine. */
export const EVAL_ENGINE_RESOURCE = 'ixo:eval-engine';

/**
 * Mints an oracle-signed UCAN token for the engine. `engineUrl` resolves the
 * engine's did:web audience; `resource` is `ixo:eval-engine`. Returns `null`
 * when the oracle has no signing key yet (boot not complete) — the lookup then
 * degrades to `null` rather than calling the engine unauthenticated.
 */
export type EngineTokenProvider = (
  engineUrl: string,
  resource: string,
) => Promise<string | null>;

export interface ContractRecordServiceDeps {
  fetchImpl?: typeof fetch;
  tokenProvider?: EngineTokenProvider;
  clock?: () => number;
  logger?: Logger;
}

interface CacheEntry {
  record: ContractRecord | null;
  expiresAt: number;
}

/**
 * Client for the engine's oracle-facing contract lookup
 * (`GET /v1/agents/contracts/for-oracle?subscriberDid=…`), authenticated with
 * an oracle-signed UCAN invocation. Read-only, per-subscriber cache (300s), with
 * an explicit `invalidate` the `ixo.oracle.contracted` listener drives.
 *
 * A `404` is a normal "no contract" and caches as `null`; network / 5xx errors
 * return `null` + warn without caching (transient). Errors never throw into a
 * turn.
 */
export class ContractRecordService {
  private readonly fetchImpl: typeof fetch;
  private tokenProvider?: EngineTokenProvider;
  private readonly clock: () => number;
  private readonly logger?: Logger;
  private readonly cache = new Map<string, CacheEntry>();
  private disabledLogged = false;

  constructor(deps: ContractRecordServiceDeps = {}) {
    this.fetchImpl = deps.fetchImpl ?? fetch;
    this.tokenProvider = deps.tokenProvider;
    this.clock = deps.clock ?? Date.now;
    this.logger = deps.logger;
  }

  /** Wire the oracle-signed token minter (done once at module init). */
  setTokenProvider(provider: EngineTokenProvider): void {
    this.tokenProvider = provider;
  }

  /** Drop a subscriber's cached record so the next lookup re-queries the engine. */
  invalidate(subscriberDid: string): void {
    this.cache.delete(subscriberDid);
  }

  /**
   * Look up the contract record for `subscriberDid`. `null` on no engine URL,
   * no signing key, 404, or any error. Cached per subscriber for 300s (positive
   * and 404 results only).
   */
  async lookup(params: {
    engineUrl?: string;
    subscriberDid: string;
  }): Promise<ContractRecord | null> {
    const { engineUrl, subscriberDid } = params;

    if (!engineUrl) {
      if (!this.disabledLogged) {
        this.disabledLogged = true;
        this.logger?.warn?.(
          '[oracle-payments] EVAL_ENGINE_URL is unset — contract lookups are disabled.',
        );
      }
      return null;
    }

    const cached = this.cache.get(subscriberDid);
    if (cached && cached.expiresAt > this.clock()) {
      return cached.record;
    }

    if (!this.tokenProvider) {
      this.logger?.warn?.(
        '[oracle-payments] no engine token provider wired — cannot look up contracts.',
      );
      return null;
    }

    let token: string | null;
    try {
      token = await this.tokenProvider(engineUrl, EVAL_ENGINE_RESOURCE);
    } catch (error) {
      this.logger?.warn?.(
        `[oracle-payments] failed to mint engine token: ${errorMessage(error)}`,
      );
      return null;
    }
    if (!token) {
      this.logger?.warn?.(
        '[oracle-payments] engine token unavailable (no signing key yet) — skipping lookup.',
      );
      return null;
    }

    const url = `${engineUrl}/v1/agents/contracts/for-oracle?subscriberDid=${encodeURIComponent(
      subscriberDid,
    )}`;
    let res: Response;
    try {
      res = await this.fetchImpl(url, {
        headers: {
          Authorization: `Bearer ${token}`,
          'X-Auth-Type': 'ucan',
        },
      });
    } catch (error) {
      this.logger?.warn?.(
        `[oracle-payments] contract lookup network error: ${errorMessage(error)}`,
      );
      return null;
    }

    if (res.status === 404) {
      this.store(subscriberDid, null);
      return null;
    }
    if (!res.ok) {
      this.logger?.warn?.(
        `[oracle-payments] contract lookup returned ${res.status} for ${subscriberDid}.`,
      );
      return null;
    }

    let body: unknown;
    try {
      body = await res.json();
    } catch (error) {
      this.logger?.warn?.(
        `[oracle-payments] contract lookup returned invalid JSON: ${errorMessage(error)}`,
      );
      return null;
    }

    const parsed = ContractRecordSchema.safeParse(body);
    if (!parsed.success) {
      this.logger?.warn?.(
        `[oracle-payments] contract record failed validation for ${subscriberDid}.`,
      );
      return null;
    }

    this.store(subscriberDid, parsed.data);
    return parsed.data;
  }

  private store(subscriberDid: string, record: ContractRecord | null): void {
    this.cache.set(subscriberDid, {
      record,
      expiresAt: this.clock() + RECORD_CACHE_TTL_MS,
    });
  }
}

import { Logger as NestLogger } from '@nestjs/common';
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
 * The outcome of one contract lookup. `record: null` with no `error` is the
 * real answer "this user has no contract"; `record: null` WITH an `error` means
 * the question was never answered — the engine was unreachable, misconfigured,
 * or answered with something unreadable.
 *
 * The two are kept apart because collapsing them tells a contracted user they
 * are not contracted whenever the engine hiccups, which is both false and
 * unexplainable: every caller that speaks to the agent relays `error` instead.
 */
export interface ContractRecordLookup {
  record: ContractRecord | null;
  error?: string;
}

/**
 * Client for the engine's oracle-facing contract lookup
 * (`GET /v1/agents/contracts/for-oracle?subscriberDid=…`), authenticated with
 * an oracle-signed UCAN invocation. Read-only, per-subscriber cache (300s), with
 * an explicit `invalidate` the `ixo.oracle.contracted` listener drives.
 *
 * A `404` is a normal "no contract" and caches as `null`; network / 5xx errors
 * come back as an `error` on the result without caching (transient). Errors
 * never throw into a turn — they are reported, not raised.
 */
export class ContractRecordService {
  private readonly fetchImpl: typeof fetch;
  private tokenProvider?: EngineTokenProvider;
  private readonly clock: () => number;
  private readonly logger: Logger;
  private readonly cache = new Map<string, CacheEntry>();
  private disabledLogged = false;

  constructor(deps: ContractRecordServiceDeps = {}) {
    this.fetchImpl = deps.fetchImpl ?? fetch;
    this.tokenProvider = deps.tokenProvider;
    this.clock = deps.clock ?? Date.now;
    this.logger = deps.logger ?? new NestLogger(ContractRecordService.name);
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
   * Look up the contract record for `subscriberDid`. A 404 answers `{ record:
   * null }` — no contract. Everything else that keeps the engine from
   * answering (no engine URL, no signing key, transport, 5xx, unreadable body)
   * answers `{ record: null, error }`, so the caller can say why instead of
   * reporting an uncontracted user. Cached per subscriber for 300s (positive
   * and 404 results only).
   */
  async lookup(params: {
    engineUrl?: string;
    subscriberDid: string;
  }): Promise<ContractRecordLookup> {
    const { engineUrl, subscriberDid } = params;
    this.logger.debug?.(
      `[oracle-payments] contract lookup for ${subscriberDid} (engine ${engineUrl ?? 'unset'})`,
    );

    if (!engineUrl) {
      if (!this.disabledLogged) {
        this.disabledLogged = true;
        this.logger.warn(
          '[oracle-payments] EVAL_ENGINE_URL is unset — contract lookups are disabled.',
        );
      }
      return {
        record: null,
        error:
          'this oracle has no evaluation engine configured (EVAL_ENGINE_URL is unset), so contracts cannot be checked at all',
      };
    }

    const cached = this.cache.get(subscriberDid);
    if (cached && cached.expiresAt > this.clock()) {
      return { record: cached.record };
    }

    if (!this.tokenProvider) {
      this.logger.warn(
        '[oracle-payments] no engine token provider wired — cannot look up contracts.',
      );
      return {
        record: null,
        error:
          'this oracle cannot authenticate to the evaluation engine (no token provider is wired)',
      };
    }

    let token: string | null;
    try {
      token = await this.tokenProvider(engineUrl, EVAL_ENGINE_RESOURCE);
    } catch (error) {
      const detail = errorMessage(error);
      this.logger.warn(
        `[oracle-payments] failed to mint engine token: ${detail}`,
      );
      return {
        record: null,
        error: `the oracle could not sign its request to the evaluation engine (${detail})`,
      };
    }
    if (!token) {
      this.logger.warn(
        '[oracle-payments] engine token unavailable (no signing key yet) — skipping lookup.',
      );
      return {
        record: null,
        error:
          "the oracle's signing key is not loaded yet, so the evaluation engine could not be asked",
      };
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
      const detail = errorMessage(error);
      this.logger.warn(
        `[oracle-payments] contract lookup network error: ${detail}`,
      );
      return {
        record: null,
        error: `the evaluation engine could not be reached (${detail})`,
      };
    }

    if (res.status === 404) {
      this.store(subscriberDid, null);
      return { record: null };
    }
    if (!res.ok) {
      this.logger.warn(
        `[oracle-payments] contract lookup returned ${res.status} for ${subscriberDid}.`,
      );
      return {
        record: null,
        error: `the evaluation engine answered ${res.status} when asked for this user's contract`,
      };
    }

    let body: unknown;
    try {
      body = await res.json();
    } catch (error) {
      const detail = errorMessage(error);
      this.logger.warn(
        `[oracle-payments] contract lookup returned invalid JSON: ${detail}`,
      );
      return {
        record: null,
        error: `the evaluation engine returned an unreadable response (${detail})`,
      };
    }

    const parsed = ContractRecordSchema.safeParse(body);
    this.logger.debug?.(
      `[oracle-payments] contract record parsed for ${subscriberDid}:`,
      parsed,
    );
    if (!parsed.success) {
      this.logger.warn(
        `[oracle-payments] contract record failed validation for ${subscriberDid}.`,
      );
      return {
        record: null,
        error:
          'the evaluation engine returned a contract record this oracle could not read (it did not match the expected shape)',
      };
    }

    this.store(subscriberDid, parsed.data);
    return { record: parsed.data };
  }

  private store(subscriberDid: string, record: ContractRecord | null): void {
    this.cache.set(subscriberDid, {
      record,
      expiresAt: this.clock() + RECORD_CACHE_TTL_MS,
    });
  }
}

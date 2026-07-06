import type { RuntimeContext } from '../../plugin-api/types.js';
import {
  mintInvocationSafely,
  resolveServiceDidSafely,
} from '../ucan-failure.js';

/** Public capsules registry served by ai-skills. */
export const DEFAULT_CAPSULES_BASE_URL = 'https://capsules.skills.ixo.earth';

/**
 * Mints an `ixo:skills` invocation for an outbound capsules-registry call, or
 * returns `undefined` so the caller falls back to public-only. Never throws.
 */
export type CapsuleUcanBuilder = (
  serviceUrl: string,
  rt: RuntimeContext,
) => Promise<string | undefined>;

/** Carrier handed to a {@link CapsuleContentFetcher} for one retrieval. */
export interface CapsuleFetchContext {
  baseUrl: string;
  network: string;
  headers: Record<string, string>;
}

/**
 * Retrieves a capsule's `SKILL.md` text from the registry. Injected so tests
 * stub it and so the confirmed retrieval path (a content endpoint vs the
 * sandbox `load_skill` extraction) can be slotted in without touching the
 * client's auth / caching concerns.
 */
export type CapsuleContentFetcher = (
  capsuleName: string,
  ctx: CapsuleFetchContext,
) => Promise<string>;

export interface CapsuleContentClientOptions {
  /** Registry base URL. Defaults to {@link DEFAULT_CAPSULES_BASE_URL}. */
  baseUrl?: string;
  /** Routing hint forwarded as `X-IXO-Network`. Defaults to `'mainnet'`. */
  network?: string;
  /** UCAN minter. Defaults to a shared-helper builder for `ixo:skills`. */
  ucanBuilder?: CapsuleUcanBuilder;
  /** Registry retrieval. Defaults to a fetcher that errors until wired. */
  fetcher?: CapsuleContentFetcher;
}

const defaultUcanBuilder: CapsuleUcanBuilder = async (serviceUrl, rt) => {
  const did = await resolveServiceDidSafely(rt, serviceUrl, 'pod-creator');
  if (!did) {
    return undefined;
  }
  const invocation = await mintInvocationSafely(
    rt,
    { did, capability: 'ixo:skills' },
    'pod-creator',
  );
  return invocation ?? undefined;
};

const notConfiguredFetcher: CapsuleContentFetcher = async (capsuleName) => {
  throw new Error(
    `CapsuleContentClient: no content fetcher configured; cannot retrieve SKILL.md for "${capsuleName}". ` +
      'Provide a CapsuleContentFetcher once the registry content path is wired.',
  );
};

function buildRegistryHeaders(
  network: string,
  ucan: string | undefined,
): Record<string, string> {
  const headers: Record<string, string> = { 'X-IXO-Network': network };
  if (ucan) {
    headers.Authorization = `Bearer ${ucan}`;
    headers['X-Auth-Type'] = 'ucan';
  }
  return headers;
}

/**
 * Resolves design-pod role capsules to their `SKILL.md` text for use as
 * sub-agent system prompts. Owns the cross-cutting concerns — `ixo:skills`
 * auth, the network header, and a per-thread cache so a multi-turn design
 * session does not refetch the same role each turn. The registry-specific
 * retrieval is delegated to an injectable {@link CapsuleContentFetcher}.
 */
export class CapsuleContentClient {
  private readonly baseUrl: string;
  private readonly network: string;
  private readonly ucanBuilder: CapsuleUcanBuilder;
  private readonly fetcher: CapsuleContentFetcher;
  /** Cache keyed by `${threadId}:${capsuleName}`. */
  private readonly cache = new Map<string, string>();

  constructor(options: CapsuleContentClientOptions = {}) {
    this.baseUrl = options.baseUrl ?? DEFAULT_CAPSULES_BASE_URL;
    this.network = options.network ?? 'mainnet';
    this.ucanBuilder = options.ucanBuilder ?? defaultUcanBuilder;
    this.fetcher = options.fetcher ?? notConfiguredFetcher;
  }

  /**
   * Resolve a capsule to its `SKILL.md` text, scoped to the caller's thread.
   * Mints an `ixo:skills` invocation when possible so the registry can serve
   * the caller's private capsules; degrades to public-only without throwing on
   * auth failure. The result is cached per thread.
   */
  async getSkillMarkdown(
    capsuleName: string,
    rt: RuntimeContext,
  ): Promise<string> {
    const cacheKey = `${rt.session.id}:${capsuleName}`;
    const cached = this.cache.get(cacheKey);
    if (cached !== undefined) {
      return cached;
    }
    const ucan = await this.ucanBuilder(this.baseUrl, rt);
    const headers = buildRegistryHeaders(this.network, ucan);
    const markdown = await this.fetcher(capsuleName, {
      baseUrl: this.baseUrl,
      network: this.network,
      headers,
    });
    this.cache.set(cacheKey, markdown);
    return markdown;
  }
}

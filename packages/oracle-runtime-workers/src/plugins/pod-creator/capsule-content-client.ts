import type { RuntimeContext } from '../../plugin-api/types';
import { mintInvocationSafely, resolveServiceDidSafely } from '../ucan-failure';
import { BoundedMap } from './bounded-map';
import { DEFAULT_NETWORK } from './config';

/** Public capsules registry served by ai-skills. */
export const DEFAULT_CAPSULES_BASE_URL = 'https://capsules.skills.ixo.earth';

/**
 * Capsule texts cached across requests. Keyed by capsule name only, so the
 * twelve roles fill at most twelve entries; the cap is a guard, not a budget.
 */
const CACHE_MAX_ENTRIES = 64;
const CACHE_TTL_MS = 6 * 60 * 60 * 1000;

/**
 * How long a failed fetch is remembered: within it every turn uses the
 * built-in prompt without another request (and without another log line).
 */
export const CAPSULE_FAILURE_TTL_MS = 5 * 60 * 1000;

/** Default deadline of one registry instructions request. */
export const DEFAULT_CAPSULE_FETCH_TIMEOUT_MS = 10_000;

/** Largest instructions body accepted from the registry (a larger one is refused). */
export const MAX_CAPSULE_INSTRUCTIONS_BYTES = 64 * 1024;

/** The registry's skill-name rule (`GET /skills/{name}/instructions`). */
const SKILL_NAME_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const SKILL_NAME_MAX_LENGTH = 64;

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
  /** The turn's abort signal: a cancelled turn abandons the fetch. */
  signal?: AbortSignal;
}

/**
 * Retrieves a capsule's `SKILL.md` text from the registry. Injected so tests
 * stub it and so a deployment chooses the retrieval path without touching the
 * client's auth / caching concerns.
 */
export type CapsuleContentFetcher = (
  capsuleName: string,
  ctx: CapsuleFetchContext,
) => Promise<string>;

export interface CapsuleContentClientOptions {
  /** Registry base URL. Defaults to {@link DEFAULT_CAPSULES_BASE_URL}. */
  baseUrl?: string;
  /** Routing hint forwarded as `X-IXO-Network`. Defaults to {@link DEFAULT_NETWORK}. */
  network?: string;
  /** UCAN minter. Defaults to a shared-helper builder for `ixo:skills`. */
  ucanBuilder?: CapsuleUcanBuilder;
  /**
   * Registry retrieval. Omitted: no registry is contacted (no fetch, no UCAN
   * mint) and every specialist runs on its built-in prompt.
   */
  fetcher?: CapsuleContentFetcher;
  /** Clock override for tests (failure-cache expiry). */
  now?: () => number;
}

const defaultUcanBuilder: CapsuleUcanBuilder = async (serviceUrl, rt) => {
  const did = await resolveServiceDidSafely(rt, serviceUrl, 'pod-creator');
  if (!did) {
    return undefined;
  }
  // Claim the ability the user's delegation grants for the registry: on
  // Workers an unqualified mint claims `'*'`, which only a `'*'` grant covers
  // (same claim as the skills plugin).
  const invocation = await mintInvocationSafely(
    rt,
    { did, capability: 'ixo:skills' },
    'pod-creator',
    { can: 'skills/*' },
  );
  return invocation ?? undefined;
};

/**
 * A {@link CapsuleContentFetcher} over the registry's
 * `GET /skills/{name}/instructions`, which returns the `SKILL.md` body
 * (frontmatter stripped) of the latest PUBLIC version of a skill. The
 * endpoint serves public mainnet skills only: the auth and network headers
 * are sent but do not widen what it returns. Each request is bounded by
 * `timeoutMs`, by the turn's abort signal and by
 * {@link MAX_CAPSULE_INSTRUCTIONS_BYTES} (a larger body is refused, not
 * truncated). A non-2xx answer (404 for an unpublished capsule) is an error,
 * which the client turns into the built-in fallback prompt.
 */
export function createRegistryInstructionsFetcher(
  options: { timeoutMs?: number } = {},
): CapsuleContentFetcher {
  const timeoutMs = options.timeoutMs ?? DEFAULT_CAPSULE_FETCH_TIMEOUT_MS;
  return async (capsuleName, ctx) => {
    if (
      capsuleName.length > SKILL_NAME_MAX_LENGTH ||
      !SKILL_NAME_PATTERN.test(capsuleName)
    ) {
      throw new Error(`"${capsuleName}" is not a valid registry skill name`);
    }
    const url = new URL(
      `/skills/${encodeURIComponent(capsuleName)}/instructions`,
      ctx.baseUrl,
    );
    // A timer that is always cleared, not `AbortSignal.timeout`: a pending
    // timer keeps the user's Durable Object resident until it fires.
    const deadline = new AbortController();
    const timer = setTimeout(() => deadline.abort(), timeoutMs);
    try {
      const response = await fetch(url.toString(), {
        headers: { ...ctx.headers, Accept: 'text/markdown' },
        signal: ctx.signal
          ? AbortSignal.any([ctx.signal, deadline.signal])
          : deadline.signal,
      });
      if (!response.ok) {
        // Release the connection without reading an error body we discard.
        await response.body?.cancel();
        throw new Error(
          `registry answered ${response.status} for the instructions of "${capsuleName}"`,
        );
      }
      const text = await readCapped(response, capsuleName);
      if (text.trim().length === 0) {
        throw new Error(
          `registry returned empty instructions for "${capsuleName}"`,
        );
      }
      return text;
    } finally {
      clearTimeout(timer);
    }
  };
}

/**
 * The response body as text, refusing it once it passes
 * {@link MAX_CAPSULE_INSTRUCTIONS_BYTES} — by the declared length when there
 * is one, and by the bytes actually read either way.
 */
async function readCapped(
  response: Response,
  capsuleName: string,
): Promise<string> {
  const tooLarge = (): Error =>
    new Error(
      `registry instructions for "${capsuleName}" exceed ${MAX_CAPSULE_INSTRUCTIONS_BYTES} bytes`,
    );
  const declared = Number(response.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > MAX_CAPSULE_INSTRUCTIONS_BYTES) {
    await response.body?.cancel();
    throw tooLarge();
  }
  if (!response.body) return '';
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > MAX_CAPSULE_INSTRUCTIONS_BYTES) {
      await reader.cancel();
      throw tooLarge();
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(bytes);
}

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
 * sub-agent system prompts, or to `undefined` when the built-in prompt should
 * be used. Owns the cross-cutting concerns — `ixo:skills` auth, the network
 * header, caching — and delegates the retrieval to an injectable
 * {@link CapsuleContentFetcher}.
 *
 * Without a fetcher (the bundled default) it answers `undefined` at once: no
 * request, no UCAN mint, no log line.
 *
 * The cache lives on the plugin instance — isolate memory shared by every
 * user object the isolate hosts — and is keyed by capsule name alone. That
 * is sound because the registry endpoint serves public content only; a
 * custom fetcher must likewise return text that is the same for every user.
 * A failure is remembered for {@link CAPSULE_FAILURE_TTL_MS} and logged once
 * per capsule per window, so an unpublished capsule costs one request and one
 * warn line per window, not one per turn.
 */
export class CapsuleContentClient {
  private readonly baseUrl: string;
  private readonly network: string;
  private readonly ucanBuilder: CapsuleUcanBuilder;
  private readonly fetcher?: CapsuleContentFetcher;
  private readonly cache: BoundedMap<string>;
  private readonly failures: BoundedMap<true>;

  constructor(options: CapsuleContentClientOptions = {}) {
    this.baseUrl = options.baseUrl ?? DEFAULT_CAPSULES_BASE_URL;
    this.network = options.network ?? DEFAULT_NETWORK;
    this.ucanBuilder = options.ucanBuilder ?? defaultUcanBuilder;
    this.fetcher = options.fetcher;
    const clock = options.now ? { now: options.now } : {};
    this.cache = new BoundedMap({
      maxEntries: CACHE_MAX_ENTRIES,
      ttlMs: CACHE_TTL_MS,
      ...clock,
    });
    this.failures = new BoundedMap({
      maxEntries: CACHE_MAX_ENTRIES,
      ttlMs: CAPSULE_FAILURE_TTL_MS,
      ...clock,
    });
  }

  /**
   * The capsule's `SKILL.md` text, or `undefined` when there is no fetcher,
   * when the fetch fails, or while a recent failure is remembered. Never
   * throws. Mints an `ixo:skills` invocation for the request when possible
   * and degrades to unauthenticated on auth failure.
   */
  async getSkillMarkdown(
    capsuleName: string,
    rt: RuntimeContext,
  ): Promise<string | undefined> {
    if (!this.fetcher) return undefined;
    const cached = this.cache.get(capsuleName);
    if (cached !== undefined) return cached;
    if (this.failures.get(capsuleName)) return undefined;
    try {
      const ucan = await this.ucanBuilder(this.baseUrl, rt);
      const markdown = await this.fetcher(capsuleName, {
        baseUrl: this.baseUrl,
        network: this.network,
        headers: buildRegistryHeaders(this.network, ucan),
        signal: rt.abortSignal,
      });
      this.cache.set(capsuleName, markdown);
      return markdown;
    } catch (error) {
      // A cancelled turn says nothing about the registry: don't remember it.
      if (rt.abortSignal.aborted) return undefined;
      this.failures.set(capsuleName, true);
      rt.logger.warn(
        `[pod-creator] registry instructions for "${capsuleName}" unavailable (${
          error instanceof Error ? error.message : String(error)
        }); using the built-in prompt for ${Math.round(
          CAPSULE_FAILURE_TTL_MS / 60_000,
        )} min before retrying.`,
      );
      return undefined;
    }
  }
}

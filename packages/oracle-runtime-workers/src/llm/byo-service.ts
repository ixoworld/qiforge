/**
 * Bring-your-own-credential LLM service — the Workers port of the Node
 * runtime's `modules/byo-llm/byo-llm.service.ts`.
 *
 * Credentials live as room secrets in the canonical user↔oracle room
 * (`BYO_SECRET_NAMES`), read and written through `WorkersSecretsService`
 * (JWE to the oracle's own P-256 key) — wire-identical to the Node runtime
 * and the portal, so connected credentials survive the runtime swap.
 *
 * The service is constructed per `UserOracleDO`, which is single-threaded
 * per user — that replaces the Node service's in-process synchronization
 * outright while keeping the same safety properties:
 *
 *  - per-user single-flight so concurrent turns share one token refresh;
 *  - a credential epoch bumped on every write/delete, so a read that
 *    overlapped a write refuses to cache its (possibly stale) result and a
 *    refresh that lost a race with a disconnect refuses to write back;
 *  - refreshed-but-unpersisted ChatGPT tokens are held (refresh tokens
 *    ROTATE on use — the in-memory result is the only valid copy) and, on
 *    Workers, additionally persisted through the host `ByoStateStore`
 *    (Durable Object storage) so an eviction cannot strand them.
 */

import type { Logger } from '../plugin-api/types';
import {
  BYO_DEFAULT_MODEL,
  BYO_PROVIDER_INFO,
  BYO_PROVIDERS,
  BYO_SECRET_NAMES,
  buildByoModelListing,
  isByoModelId,
  parseByoModelId,
  parseChatGptOAuthTokens,
  providerForSecretName,
  toByoModelId,
  type ByoCredential,
  type ByoProvider,
  type ChatGptOAuthTokens,
} from './byo-catalog';
import {
  DEEPSEEK_BASE_URL,
  GEMINI_OPENAI_COMPAT_BASE_URL,
  type ChatGptBackendConfig,
  chatGptBackendHeaders,
  DEFAULT_CHATGPT_BACKEND,
} from './byo-client';
import type { ModelListItem } from '../core/llm';
import {
  buildByoFallbackNotice,
  type ByoFallbackNoticePayload,
} from './provider-error';
import {
  ChatGptOAuthError,
  DEFAULT_CHATGPT_CLIENT_ID,
  refreshChatGptTokens,
  TOKEN_REFRESH_SKEW_MS,
} from './chatgpt-oauth';

/**
 * Parsed credentials are cached briefly so the per-turn resolution costs one
 * cache read instead of a Matrix room-state fetch. Short on purpose: a key
 * added from the portal becomes usable within this window without any
 * cross-service invalidation (the connect UI can also force `refresh`).
 */
const CREDS_CACHE_TTL_MS = 60_000;

/** Device-auth bindings live as long as the device code's 15-minute window. */
const DEVICE_BIND_TTL_MS = 15 * 60 * 1000;

/**
 * Cooldowns after a failed ChatGPT token refresh so a dead credential doesn't
 * retry the token endpoint on every message. Permanent failures (rotated /
 * expired refresh token) back off longer than transient ones; a successful
 * refresh or reconnect clears the cooldown.
 */
const REFRESH_COOLDOWN_TRANSIENT_MS = 2 * 60 * 1000;
const REFRESH_COOLDOWN_RECONNECT_MS = 30 * 60 * 1000;

export type ByoCredentialMap = Partial<Record<ByoProvider, ByoCredential>>;

/** Everything a BYO turn needs; built once per request by the host. */
export interface ByoTurnState {
  provider: ByoProvider;
  credential: ByoCredential;
  /** Provider-native id serving the `main` role. */
  mainModelId: string;
  /** Namespaced id the turn is recorded as (goes on `requestCtx.model`). */
  byoModelId: string;
  /** ChatGPT lane only: backend/proxy the turn's requests go to. */
  chatGptBackend?: ChatGptBackendConfig;
}

export interface ByoProviderStatus {
  provider: ByoProvider;
  label: string;
  authType: 'oauth' | 'api-key';
  badge: string;
  connected: boolean;
  /** Present when connected — picker entries for this provider. */
  models: ModelListItem[];
  /** Namespaced default model id (picker preselect after connect). */
  defaultModelId: string;
}

/** The slice of `WorkersSecretsService` the BYO service consumes. */
export interface ByoSecretsBackend {
  getIndex(roomId: string): Promise<Array<{ name: string; eventId: string }>>;
  getValues(roomId: string, names: string[]): Promise<Record<string, string>>;
  putSecret(roomId: string, name: string, value: string): Promise<void>;
  deleteSecret(roomId: string, name: string): Promise<void>;
}

/**
 * Small durable KV the host supplies (Durable Object storage in production,
 * a Map in tests) for the state that must survive object eviction: the
 * device-auth bindings and unpersisted rotated ChatGPT tokens.
 */
export interface ByoStateStore {
  get(key: string): Promise<string | undefined>;
  put(key: string, value: string, ttlMs?: number): Promise<void>;
  delete(key: string): Promise<void>;
}

export interface WorkersByoServiceOptions {
  enabled: boolean;
  /** Override of the public ChatGPT OAuth client id. */
  chatGptClientId?: string;
  secrets: ByoSecretsBackend;
  /** Canonical user↔oracle room lookup (gateway alias resolution). */
  resolveRoomId: (userDid: string) => Promise<string | null>;
  store: ByoStateStore;
  logger?: Logger;
  /** Fetch used for the ChatGPT-backend reachability probe (tests). */
  probeFetch?: typeof fetch;
  /** Where ChatGPT-subscription requests go (default: the real backend). */
  chatGptBackend?: ChatGptBackendConfig;
}

/** How long a ChatGPT-backend reachability verdict is trusted. */
const CHATGPT_PROBE_TTL_MS = 10 * 60 * 1000;

const NOOP: Logger = {
  log: () => undefined,
  warn: () => undefined,
  error: () => undefined,
};

interface CachedCreds {
  creds: ByoCredentialMap;
  expiresAt: number;
}

export class WorkersByoService {
  private readonly enabled: boolean;
  private readonly secrets: ByoSecretsBackend;
  private readonly resolveRoomIdFn: (userDid: string) => Promise<string | null>;
  private readonly store: ByoStateStore;
  private readonly logger: Logger;
  readonly chatGptClientId: string;

  private readonly credsCache = new Map<string, CachedCreds>();
  /** Per-user single-flight so concurrent turns share one token refresh. */
  private readonly refreshInFlight = new Map<
    string,
    Promise<ChatGptOAuthTokens | null>
  >();
  /** Per-user credential epoch — bumped on every credential write/delete. */
  private readonly credsEpoch = new Map<string, number>();
  /** In-memory mirror of the store-backed pending (unpersisted) tokens. */
  private readonly pendingChatGptTokens = new Map<string, ChatGptOAuthTokens>();
  /** Dedup for background retries of a pending token write-back. */
  private readonly pendingPersistInFlight = new Set<string>();
  /** Per-user refresh-failure cooldown (epoch-ms deadline). */
  private readonly refreshCooldownUntil = new Map<string, number>();
  private readonly probeFetch: typeof fetch;
  readonly chatGptBackend: ChatGptBackendConfig;
  /** Last ChatGPT-backend reachability verdict (deployment-wide, not per user). */
  private chatGptProbe: { blocked: boolean; at: number } | null = null;

  constructor(opts: WorkersByoServiceOptions) {
    this.enabled = opts.enabled;
    this.secrets = opts.secrets;
    this.resolveRoomIdFn = opts.resolveRoomId;
    this.store = opts.store;
    this.logger = opts.logger ?? NOOP;
    this.chatGptClientId = opts.chatGptClientId ?? DEFAULT_CHATGPT_CLIENT_ID;
    // Never store the bare global: workerd rejects `fetch` invoked with a
    // foreign `this` ("Illegal invocation"), and this field is called as a
    // method. Resolve the global at call time so the probe really runs.
    this.probeFetch =
      opts.probeFetch ?? ((input, init) => globalThis.fetch(input, init));
    this.chatGptBackend = opts.chatGptBackend ?? DEFAULT_CHATGPT_BACKEND;
  }

  /**
   * Is the ChatGPT subscription backend reachable from THIS deployment?
   *
   * `chatgpt.com/backend-api/codex` sits behind a WAF that answers some
   * egress networks (Cloudflare Workers among them) with a 403 HTML block
   * page before any authentication happens. Discovering that mid-turn means
   * a failed turn with no reply, so probe once (a cheap GET the backend
   * answers with a JSON 404/405 when reachable) and trust the verdict for
   * `CHATGPT_PROBE_TTL_MS`. Only an HTML 403 counts as blocked — a network
   * error or any JSON status is "reachable", so a probe hiccup never hides
   * the user's own provider errors.
   */
  private async chatGptBackendBlocked(accessToken: string): Promise<boolean> {
    if (
      this.chatGptProbe &&
      Date.now() - this.chatGptProbe.at < CHATGPT_PROBE_TTL_MS
    ) {
      return this.chatGptProbe.blocked;
    }
    let blocked = false;
    try {
      const res = await this.probeFetch(
        `${this.chatGptBackend.baseUrl}/responses`,
        {
          method: 'GET',
          headers: {
            ...chatGptBackendHeaders(this.chatGptBackend),
            Authorization: `Bearer ${accessToken}`,
            originator: 'codex_cli_rs',
          },
        },
      );
      const type = res.headers.get('content-type') ?? '';
      blocked = res.status === 403 && /text\/html/i.test(type);
      if (blocked) {
        this.logger.warn(
          `[byo] ChatGPT backend is WAF-blocked from this deployment (HTTP 403 HTML) — ChatGPT turns fall back to the platform model for ${Math.round(CHATGPT_PROBE_TTL_MS / 60_000)} min`,
        );
      }
    } catch (err) {
      this.logger.warn(
        `[byo] ChatGPT backend probe failed (treated as reachable): ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    this.chatGptProbe = { blocked, at: Date.now() };
    return blocked;
  }

  isEnabled(): boolean {
    return this.enabled;
  }

  private epochOf(userDid: string): number {
    return this.credsEpoch.get(userDid) ?? 0;
  }

  private bumpEpoch(userDid: string): void {
    this.credsEpoch.set(userDid, this.epochOf(userDid) + 1);
  }

  private pendingKey(userDid: string): string {
    return `pending_chatgpt:${userDid}`;
  }

  private deviceBindKey(deviceAuthId: string): string {
    return `device:${deviceAuthId}`;
  }

  private cooldownActive(userDid: string): boolean {
    const until = this.refreshCooldownUntil.get(userDid);
    if (until === undefined) return false;
    if (until <= Date.now()) {
      this.refreshCooldownUntil.delete(userDid);
      return false;
    }
    return true;
  }

  private clearCooldown(userDid: string): void {
    this.refreshCooldownUntil.delete(userDid);
  }

  /**
   * Bind a started device-auth flow to the account that started it, so a
   * poll from any other account (or for a flow this oracle never issued)
   * cannot complete the connect and capture the resulting tokens.
   */
  async bindDeviceAuth(userDid: string, deviceAuthId: string): Promise<void> {
    await this.store.put(
      this.deviceBindKey(deviceAuthId),
      userDid,
      DEVICE_BIND_TTL_MS,
    );
  }

  async isDeviceAuthOwner(
    userDid: string,
    deviceAuthId: string,
  ): Promise<boolean> {
    const owner = await this.store.get(this.deviceBindKey(deviceAuthId));
    return owner === userDid;
  }

  private async pendingTokensOf(
    userDid: string,
  ): Promise<ChatGptOAuthTokens | null> {
    const inMemory = this.pendingChatGptTokens.get(userDid);
    if (inMemory) return inMemory;
    const stored = await this.store.get(this.pendingKey(userDid));
    if (!stored) return null;
    const parsed = parseChatGptOAuthTokens(stored);
    if (parsed) this.pendingChatGptTokens.set(userDid, parsed);
    return parsed;
  }

  private async setPendingTokens(
    userDid: string,
    tokens: ChatGptOAuthTokens,
  ): Promise<void> {
    this.pendingChatGptTokens.set(userDid, tokens);
    await this.store.put(this.pendingKey(userDid), JSON.stringify(tokens));
  }

  private async clearPendingTokens(userDid: string): Promise<void> {
    this.pendingChatGptTokens.delete(userDid);
    await this.store.delete(this.pendingKey(userDid));
  }

  /**
   * Read + parse the user's BYO credentials from the canonical room's
   * secrets. Cached for {@link CREDS_CACHE_TTL_MS}; `refresh` bypasses the
   * cache (used by the connect UI right after saving a key).
   */
  async getCredentials(
    userDid: string,
    opts?: { refresh?: boolean },
  ): Promise<ByoCredentialMap> {
    if (!this.enabled) return {};

    if (!opts?.refresh) {
      const cached = this.credsCache.get(userDid);
      if (cached && cached.expiresAt > Date.now()) return cached.creds;
    }

    const epochAtRead = this.epochOf(userDid);
    const roomId = await this.resolveRoomIdFn(userDid);
    if (!roomId) return {};

    const index = await this.secrets.getIndex(roomId);
    const byoNames = index
      .map((entry) => entry.name)
      .filter((name) => providerForSecretName(name) !== undefined);
    const values =
      byoNames.length > 0 ? await this.secrets.getValues(roomId, byoNames) : {};

    const creds: ByoCredentialMap = {};
    for (const [name, value] of Object.entries(values)) {
      const provider = providerForSecretName(name);
      if (!provider || !value) continue;
      if (provider === 'chatgpt') {
        const oauth = parseChatGptOAuthTokens(value);
        if (oauth) {
          creds.chatgpt = { provider: 'chatgpt', oauth };
        } else {
          this.logger.warn(
            `[byo] stored ChatGPT OAuth blob for ${userDid} is malformed — treating as disconnected`,
          );
        }
      } else {
        creds[provider] = { provider, apiKey: value.trim() };
      }
    }

    // Unpersisted (rotated) tokens shadow the room-stored ones — the stored
    // refresh token is already consumed upstream. Once the room state carries
    // an equally-fresh or fresher credential, the shadow copy is dropped.
    const pending = await this.pendingTokensOf(userDid);
    if (pending) {
      const stored = creds.chatgpt;
      const storedOauth =
        stored?.provider === 'chatgpt' ? stored.oauth : undefined;
      if (!storedOauth || storedOauth.expiresAt < pending.expiresAt) {
        creds.chatgpt = { provider: 'chatgpt', oauth: pending };
      } else {
        await this.clearPendingTokens(userDid);
      }
    }

    // Cache only when no write raced this read — a store/delete that landed
    // mid-read supersedes what was read, and caching it would poison the next
    // minute of turns (worst case: resurrecting a consumed refresh token).
    if (this.epochOf(userDid) === epochAtRead) {
      this.credsCache.set(userDid, {
        creds,
        expiresAt: Date.now() + CREDS_CACHE_TTL_MS,
      });
    }
    return creds;
  }

  /** Presence check. Not cached beyond `getCredentials`' own 60s window. */
  async hasCredentials(userDid: string): Promise<boolean> {
    if (!this.enabled) return false;
    const creds = await this.getCredentials(userDid);
    return Object.keys(creds).length > 0;
  }

  /**
   * Per-turn resolution, called by the host before the agent build.
   *
   * - A `byo:` model on the request activates that provider (credential
   *   required — otherwise the turn falls back to the platform default).
   * - A platform model on the request keeps the turn platform-paid (the
   *   caller skips this method entirely in that case).
   * - No model on the request (Matrix ingress) prefers the connected
   *   subscription, then the first connected API key.
   *
   * Returns `null` for "platform turn" — the caller changes nothing.
   * Degradations the user should know about are reported via `onNotice`
   * (the host forwards them onto the turn's SSE stream).
   */
  async resolveForTurn(params: {
    userDid: string;
    requestedModel?: string;
    onNotice?: (notice: ByoFallbackNoticePayload) => void;
  }): Promise<ByoTurnState | null> {
    if (!this.enabled) return null;
    const { userDid, requestedModel, onNotice } = params;

    let requested: { provider: ByoProvider; modelId: string } | null = null;
    if (requestedModel !== undefined) {
      if (!isByoModelId(requestedModel)) return null;
      requested = parseByoModelId(requestedModel);
      if (!requested) {
        this.logger.warn(
          `[byo] ignoring unknown BYO model "${requestedModel}" — falling back to the platform default.`,
        );
        return null;
      }
    }

    const creds = await this.getCredentials(userDid);

    if (requested) {
      const credential = creds[requested.provider];
      if (!credential) {
        this.logger.warn(
          `[byo] model "${requestedModel}" requested but no ${requested.provider} credential is connected — falling back to the platform default.`,
        );
        // The picker still shows their BYO model — without a signal the user
        // has no way to know this reply ran on the platform model instead.
        onNotice?.(buildByoFallbackNotice('not_connected', requested.provider));
        return null;
      }
      return this.finalizeTurn(
        userDid,
        credential,
        requested.modelId,
        onNotice,
      );
    }

    for (const provider of BYO_PROVIDERS) {
      const credential = creds[provider];
      if (credential) {
        return this.finalizeTurn(
          userDid,
          credential,
          BYO_DEFAULT_MODEL[provider],
          onNotice,
        );
      }
    }
    return null;
  }

  private async finalizeTurn(
    userDid: string,
    credential: ByoCredential,
    mainModelId: string,
    onNotice?: (notice: ByoFallbackNoticePayload) => void,
  ): Promise<ByoTurnState | null> {
    let effective = credential;
    if (credential.provider === 'chatgpt') {
      const fresh = await this.ensureFreshChatGptTokens(
        userDid,
        credential.oauth,
      );
      if (!fresh) {
        this.logger.warn(
          `[byo] ChatGPT token refresh failed for ${userDid} — turn falls back to the platform default (user must reconnect).`,
        );
        onNotice?.(buildByoFallbackNotice('reconnect_required', 'chatgpt'));
        return null;
      }
      if (await this.chatGptBackendBlocked(fresh.accessToken)) {
        onNotice?.(buildByoFallbackNotice('unreachable', 'chatgpt'));
        return null;
      }
      effective = { provider: 'chatgpt', oauth: fresh };
    }
    return {
      provider: effective.provider,
      credential: effective,
      mainModelId,
      byoModelId: toByoModelId(effective.provider, mainModelId),
      ...(effective.provider === 'chatgpt'
        ? { chatGptBackend: this.chatGptBackend }
        : {}),
    };
  }

  /**
   * Return tokens valid for at least {@link TOKEN_REFRESH_SKEW_MS} more ms,
   * refreshing (single-flight per user) and writing back when needed.
   */
  private async ensureFreshChatGptTokens(
    userDid: string,
    oauth: ChatGptOAuthTokens,
  ): Promise<ChatGptOAuthTokens | null> {
    if (oauth.expiresAt - TOKEN_REFRESH_SKEW_MS > Date.now()) {
      // Fresh enough — but if these tokens are an unpersisted shadow copy,
      // retry the write-back in the background so an eviction can't strand
      // the only valid copy of the rotated refresh token.
      if (this.pendingChatGptTokens.get(userDid)) {
        void this.retryPendingPersist(userDid);
      }
      return oauth;
    }

    // A recent refresh failure short-circuits the retry so a dead credential
    // costs one map read per turn, not a token-endpoint round-trip.
    if (this.cooldownActive(userDid)) return null;

    const inFlight = this.refreshInFlight.get(userDid);
    if (inFlight) return inFlight;

    const refresh = (async (): Promise<ChatGptOAuthTokens | null> => {
      const epochAtStart = this.epochOf(userDid);
      let tokens: ChatGptOAuthTokens;
      try {
        tokens = await refreshChatGptTokens({
          clientId: this.chatGptClientId,
          previous: oauth,
        });
      } catch (error) {
        const reconnect =
          error instanceof ChatGptOAuthError &&
          error.code === 'reconnect_required';
        this.logger.error(
          `[byo] ChatGPT token refresh failed for ${userDid}${reconnect ? ' (refresh token expired/rotated — reconnect required)' : ''}: ${error instanceof Error ? error.message : String(error)}`,
        );
        this.refreshCooldownUntil.set(
          userDid,
          Date.now() +
            (reconnect
              ? REFRESH_COOLDOWN_RECONNECT_MS
              : REFRESH_COOLDOWN_TRANSIENT_MS),
        );
        this.refreshInFlight.delete(userDid);
        return null;
      }

      try {
        if (this.epochOf(userDid) !== epochAtStart) {
          // A disconnect (or another write) superseded this refresh while it
          // was in flight — do not resurrect the credential.
          this.logger.log(
            `[byo] discarding refreshed ChatGPT tokens for ${userDid} — credential changed mid-refresh`,
          );
          return null;
        }
        await this.storeChatGptTokens(userDid, tokens);
        return tokens;
      } catch (error) {
        // The refresh SUCCEEDED — only persisting it failed. The old refresh
        // token is already consumed upstream, so these tokens are the only
        // valid copy: hold them (no cooldown — nothing is wrong with the
        // credential) and let reads/retries pick them up.
        this.logger.error(
          `[byo] ChatGPT tokens refreshed but write-back failed for ${userDid} — holding and retrying: ${error instanceof Error ? error.message : String(error)}`,
        );
        await this.holdUnpersistedChatGptTokens(userDid, tokens);
        return tokens;
      } finally {
        this.refreshInFlight.delete(userDid);
      }
    })();
    this.refreshInFlight.set(userDid, refresh);
    return refresh;
  }

  /**
   * Keep freshly-obtained tokens usable when persisting them failed: shadow
   * them (memory + durable store), drop the (stale) cached credential map so
   * the next read substitutes them, and clear any cooldown — the credential
   * itself is fine.
   */
  async holdUnpersistedChatGptTokens(
    userDid: string,
    tokens: ChatGptOAuthTokens,
  ): Promise<void> {
    this.bumpEpoch(userDid);
    await this.setPendingTokens(userDid, tokens);
    this.credsCache.delete(userDid);
    this.clearCooldown(userDid);
  }

  /** Background retry of a pending token write-back, deduped per user. */
  private async retryPendingPersist(userDid: string): Promise<void> {
    if (this.pendingPersistInFlight.has(userDid)) return;
    this.pendingPersistInFlight.add(userDid);
    try {
      const pending = await this.pendingTokensOf(userDid);
      if (!pending) return;
      await this.storeChatGptTokens(userDid, pending);
      this.logger.log(
        `[byo] persisted previously-held ChatGPT tokens for ${userDid}`,
      );
    } catch (error) {
      this.logger.warn(
        `[byo] retry of ChatGPT token write-back failed for ${userDid}: ${error instanceof Error ? error.message : String(error)}`,
      );
    } finally {
      this.pendingPersistInFlight.delete(userDid);
    }
  }

  /**
   * Persist ChatGPT OAuth tokens into the canonical room (JWE to the oracle's
   * own key) and patch the credential cache in place.
   */
  async storeChatGptTokens(
    userDid: string,
    tokens: ChatGptOAuthTokens,
  ): Promise<void> {
    const roomId = await this.resolveRoomIdFn(userDid);
    if (!roomId) {
      throw new Error(
        `[byo] cannot store ChatGPT tokens — no oracle room for ${userDid}`,
      );
    }
    // Bump on both sides of the Matrix write so a credential read overlapping
    // ANY part of it (started before, or started mid-write against the old
    // room state) fails the epoch check and refuses to cache a stale result.
    this.bumpEpoch(userDid);
    await this.secrets.putSecret(
      roomId,
      BYO_SECRET_NAMES.chatgpt,
      JSON.stringify(tokens),
    );
    this.bumpEpoch(userDid);
    // Durably persisted — any shadow copy from an earlier failed write-back
    // is superseded (unless it is strictly fresher than what was just written).
    const pending = await this.pendingTokensOf(userDid);
    if (pending && pending.expiresAt <= tokens.expiresAt) {
      await this.clearPendingTokens(userDid);
    }

    const cached = this.credsCache.get(userDid);
    const next: ByoCredentialMap = {
      ...(cached && cached.expiresAt > Date.now() ? cached.creds : {}),
      chatgpt: { provider: 'chatgpt', oauth: tokens },
    };
    this.credsCache.set(userDid, {
      creds: next,
      expiresAt: Date.now() + CREDS_CACHE_TTL_MS,
    });
    this.clearCooldown(userDid);
  }

  /**
   * Store a provider API key server-side, same as the OAuth path: encrypted
   * by the oracle to its own key and written into the canonical room. A
   * client-side write through the agent-secrets flow depends on cross-device
   * Matrix key sharing — when the room-key to-device message goes missing the
   * oracle stores ciphertext it can never read. Server-side writes are always
   * readable by construction, and the oracle decrypts the key on every BYO
   * turn anyway, so the exposure is identical.
   */
  async storeApiKey(
    userDid: string,
    provider: Exclude<ByoProvider, 'chatgpt'>,
    apiKey: string,
  ): Promise<void> {
    const roomId = await this.resolveRoomIdFn(userDid);
    if (!roomId) {
      throw new Error(
        `[byo] cannot store API key — no oracle room for ${userDid}`,
      );
    }
    // Same both-sides epoch bump as the token store: an overlapping
    // credential read must refuse to cache around this write.
    this.bumpEpoch(userDid);
    await this.secrets.putSecret(roomId, BYO_SECRET_NAMES[provider], apiKey);
    this.bumpEpoch(userDid);

    const cached = this.credsCache.get(userDid);
    const next: ByoCredentialMap = {
      ...(cached && cached.expiresAt > Date.now() ? cached.creds : {}),
      [provider]: { provider, apiKey },
    };
    this.credsCache.set(userDid, {
      creds: next,
      expiresAt: Date.now() + CREDS_CACHE_TTL_MS,
    });
  }

  /** Remove a stored credential (index cleared, value redacted, caches dropped). */
  async deleteCredential(
    userDid: string,
    provider: ByoProvider,
  ): Promise<void> {
    // Let any in-flight token refresh land first, then bump the epoch on
    // both sides of the Matrix delete — together these guarantee a refresh
    // can neither write after the delete nor start a late write-back, and a
    // credential read overlapping any part of the delete refuses to cache
    // the not-yet-deleted state.
    const inFlight = this.refreshInFlight.get(userDid);
    if (inFlight) {
      await inFlight;
    }
    this.bumpEpoch(userDid);

    const roomId = await this.resolveRoomIdFn(userDid);
    if (!roomId) {
      throw new Error(
        `[byo] cannot delete credential — no oracle room for ${userDid}`,
      );
    }
    await this.secrets.deleteSecret(roomId, BYO_SECRET_NAMES[provider]);
    this.bumpEpoch(userDid);
    if (provider === 'chatgpt') {
      await this.clearPendingTokens(userDid);
    }
    this.credsCache.delete(userDid);
    this.clearCooldown(userDid);
  }

  /** Per-provider connection status + picker entries for the connect UI. */
  async status(
    userDid: string,
    opts?: { refresh?: boolean },
  ): Promise<{ enabled: boolean; providers: ByoProviderStatus[] }> {
    if (!this.enabled) {
      return { enabled: false, providers: [] };
    }
    const creds = await this.getCredentials(userDid, opts);
    const providers = BYO_PROVIDERS.map((provider): ByoProviderStatus => {
      const info = BYO_PROVIDER_INFO[provider];
      const connected = creds[provider] !== undefined;
      return {
        provider,
        label: info.label,
        authType: info.authType,
        badge: info.badge,
        connected,
        models: connected ? buildByoModelListing([provider]) : [],
        defaultModelId: toByoModelId(provider, BYO_DEFAULT_MODEL[provider]),
      };
    });
    return { enabled: true, providers };
  }

  /**
   * Live-check a stored credential: API keys make a cheap `GET /models`
   * against their provider; the subscription checks token freshness
   * (refreshing when stale). Never throws — the result is UI feedback.
   */
  async validate(
    userDid: string,
    provider: ByoProvider,
  ): Promise<{ valid: boolean; error?: string }> {
    const creds = await this.getCredentials(userDid, { refresh: true });
    const credential = creds[provider];
    if (!credential) {
      return { valid: false, error: 'Not connected' };
    }

    if (credential.provider === 'chatgpt') {
      // A user-initiated check is an explicit retry — lift any cooldown so
      // the refresh really runs instead of reporting the cached failure.
      this.clearCooldown(userDid);
      const fresh = await this.ensureFreshChatGptTokens(
        userDid,
        credential.oauth,
      );
      return fresh
        ? { valid: true }
        : { valid: false, error: 'Token refresh failed — please reconnect' };
    }

    try {
      const { url, headers } = validationRequestFor(
        credential.provider,
        credential.apiKey,
      );
      const res = await fetch(url, { headers });
      if (res.ok) return { valid: true };
      return {
        valid: false,
        error:
          res.status === 401 || res.status === 403
            ? 'The provider rejected this key'
            : `Provider check failed (HTTP ${res.status})`,
      };
    } catch (error) {
      return {
        valid: false,
        error: `Could not reach the provider: ${error instanceof Error ? error.message : String(error)}`,
      };
    }
  }
}

function validationRequestFor(
  provider: Exclude<ByoProvider, 'chatgpt'>,
  apiKey: string,
): { url: string; headers: Record<string, string> } {
  switch (provider) {
    case 'openai':
      return {
        url: 'https://api.openai.com/v1/models',
        headers: { Authorization: `Bearer ${apiKey}` },
      };
    case 'deepseek':
      return {
        url: `${DEEPSEEK_BASE_URL}/models`,
        headers: { Authorization: `Bearer ${apiKey}` },
      };
    case 'gemini':
      return {
        url: `${GEMINI_OPENAI_COMPAT_BASE_URL}models`,
        headers: { Authorization: `Bearer ${apiKey}` },
      };
    case 'anthropic':
      return {
        url: 'https://api.anthropic.com/v1/models',
        headers: { 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' },
      };
  }
}

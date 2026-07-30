import { MatrixManager } from '@ixo/matrix';
import { type Cache, CACHE_MANAGER } from '@nestjs/cache-manager';
import { Inject, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
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
} from '../../llm/byo-catalog.js';
import {
  DEEPSEEK_BASE_URL,
  GEMINI_OPENAI_COMPAT_BASE_URL,
} from '../../llm/byo-client.js';
import type { ModelListItem } from '../../llm/model-catalog.js';
import { HomeServerCache } from '../messages/homeserver-cache.js';
import { SecretsService } from '../secrets/secrets.service.js';
import {
  ChatGptOAuthError,
  DEFAULT_CHATGPT_CLIENT_ID,
  refreshChatGptTokens,
  TOKEN_REFRESH_SKEW_MS,
} from './chatgpt-oauth.js';

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

/** Everything a BYO turn needs; built once per request in `AgentBuilder`. */
export interface ByoTurnState {
  provider: ByoProvider;
  credential: ByoCredential;
  /** Provider-native id serving the `main` role. */
  mainModelId: string;
  /** Namespaced id the turn is recorded as (goes on `requestCtx.model`). */
  byoModelId: string;
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

@Injectable()
export class ByoLlmService {
  private readonly logger = new Logger(ByoLlmService.name);

  /** Per-user single-flight so concurrent turns share one token refresh. */
  private readonly refreshInFlight = new Map<
    string,
    Promise<ChatGptOAuthTokens | null>
  >();

  /**
   * Per-user credential epoch (in-process, like `refreshInFlight` — the
   * runtime deploys single-instance). Bumped on every credential write or
   * delete. Two races die on it: a Matrix read that started before a
   * concurrent write refuses to cache its (possibly stale) result, so a
   * freshly-rotated refresh token can never be clobbered back to a consumed
   * one; and a token refresh that lost a race with a disconnect refuses to
   * write the credential back.
   */
  private readonly credsEpoch = new Map<string, number>();

  /**
   * ChatGPT tokens whose Matrix write-back failed. Refresh tokens ROTATE on
   * use — once a refresh succeeds upstream, the in-memory result is the only
   * valid copy, and discarding it over a Matrix blip would permanently brick
   * the connection (the stored refresh token is already consumed). Held here
   * and substituted over the room-stored credential on every read until a
   * later write-back succeeds.
   */
  private readonly pendingChatGptTokens = new Map<string, ChatGptOAuthTokens>();

  /** Dedup for background retries of a pending token write-back. */
  private readonly pendingPersistInFlight = new Set<string>();

  private epochOf(userDid: string): number {
    return this.credsEpoch.get(userDid) ?? 0;
  }

  private bumpEpoch(userDid: string): void {
    this.credsEpoch.set(userDid, this.epochOf(userDid) + 1);
  }

  constructor(
    private readonly config: ConfigService,
    @Inject(CACHE_MANAGER) private readonly cacheManager: Cache,
    private readonly homeServers: HomeServerCache,
  ) {}

  isEnabled(): boolean {
    return this.config.get<boolean>('BYO_LLM_ENABLED') === true;
  }

  get chatGptClientId(): string {
    return (
      this.config.get<string>('BYO_CHATGPT_CLIENT_ID') ??
      DEFAULT_CHATGPT_CLIENT_ID
    );
  }

  private credsKey(userDid: string): string {
    return `byo_creds:${userDid}`;
  }

  private deviceBindKey(deviceAuthId: string): string {
    return `byo_device:${deviceAuthId}`;
  }

  private refreshCooldownKey(userDid: string): string {
    return `byo_refresh_cooldown:${userDid}`;
  }

  /**
   * Bind a started device-auth flow to the account that started it, so a
   * poll from any other account (or for a flow this process never issued)
   * cannot complete the connect and capture the resulting tokens.
   */
  async bindDeviceAuth(userDid: string, deviceAuthId: string): Promise<void> {
    await this.cacheManager.set(
      this.deviceBindKey(deviceAuthId),
      userDid,
      DEVICE_BIND_TTL_MS,
    );
  }

  async isDeviceAuthOwner(
    userDid: string,
    deviceAuthId: string,
  ): Promise<boolean> {
    const owner = await this.cacheManager.get<string>(
      this.deviceBindKey(deviceAuthId),
    );
    return owner === userDid;
  }

  /**
   * The canonical user↔oracle room — where the portal deposits credentials
   * and where server-originated tokens are written back. Deliberately NOT the
   * per-session room: the credential is account-level for this oracle.
   * `MatrixManager` caches the alias→id resolution internally.
   */
  private async resolveRoomId(
    userDid: string,
    homeServerName?: string,
  ): Promise<string | null> {
    try {
      const oracleEntityDid =
        this.config.getOrThrow<string>('ORACLE_ENTITY_DID');
      const userHomeServer =
        homeServerName ?? (await this.homeServers.get(userDid));
      const result =
        await MatrixManager.getInstance().getOracleRoomIdWithHomeServer({
          userDid,
          oracleEntityDid,
          userHomeServer,
        });
      return result.roomId ?? null;
    } catch (error) {
      this.logger.warn(
        `Could not resolve oracle room for ${userDid}: ${error instanceof Error ? error.message : String(error)}`,
      );
      return null;
    }
  }

  /**
   * Read + parse the user's BYO credentials from the canonical room's
   * secrets. Cached for {@link CREDS_CACHE_TTL_MS}; `refresh` bypasses the
   * cache (used by the connect UI right after saving a key).
   */
  async getCredentials(
    userDid: string,
    homeServerName?: string,
    opts?: { refresh?: boolean },
  ): Promise<ByoCredentialMap> {
    if (!this.isEnabled()) return {};

    if (!opts?.refresh) {
      const cached = await this.cacheManager.get<ByoCredentialMap>(
        this.credsKey(userDid),
      );
      if (cached) return cached;
    }

    const epochAtRead = this.epochOf(userDid);
    const roomId = await this.resolveRoomId(userDid, homeServerName);
    if (!roomId) return {};

    const secrets = SecretsService.getInstance();
    const index = await secrets.getSecretIndex(roomId);
    const byoEntries = index.filter((entry) =>
      providerForSecretName(entry.name),
    );
    const values =
      byoEntries.length > 0
        ? await secrets.loadSecretValues(roomId, byoEntries)
        : {};

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
            `Stored ChatGPT OAuth blob for ${userDid} is malformed — treating as disconnected`,
          );
        }
      } else {
        creds[provider] = { provider, apiKey: value.trim() };
      }
    }

    // Unpersisted (rotated) tokens shadow the room-stored ones — the stored
    // refresh token is already consumed upstream. Once the room state carries
    // an equally-fresh or fresher credential, the shadow copy is dropped.
    const pending = this.pendingChatGptTokens.get(userDid);
    if (pending) {
      const stored = creds.chatgpt;
      const storedOauth =
        stored?.provider === 'chatgpt' ? stored.oauth : undefined;
      if (!storedOauth || storedOauth.expiresAt < pending.expiresAt) {
        creds.chatgpt = { provider: 'chatgpt', oauth: pending };
      } else {
        this.pendingChatGptTokens.delete(userDid);
      }
    }

    // Cache only when no write raced this read — a store/delete that landed
    // mid-read supersedes what was read, and caching it would poison the next
    // minute of turns (worst case: resurrecting a consumed refresh token).
    if (this.epochOf(userDid) === epochAtRead) {
      await this.cacheManager.set(
        this.credsKey(userDid),
        creds,
        CREDS_CACHE_TTL_MS,
      );
    }
    return creds;
  }

  /**
   * Presence check for the subscription middleware's credit-floor bypass.
   * Deliberately NOT cached beyond `getCredentials`' own 60s window, so a
   * disconnect (from any surface, including a portal-side secret deletion)
   * closes the bypass within a minute. Only floor-failing requests reach
   * this, so the common path pays nothing.
   */
  async hasCredentials(
    userDid: string,
    homeServerName?: string,
  ): Promise<boolean> {
    if (!this.isEnabled()) return false;
    const creds = await this.getCredentials(userDid, homeServerName);
    return Object.keys(creds).length > 0;
  }

  /**
   * Per-turn resolution, called from `AgentBuilder`.
   *
   * - A `byo:` model on the request activates that provider (credential
   *   required — otherwise the turn falls back to the platform default).
   * - A platform model on the request keeps the turn platform-paid.
   * - No model on the request (Matrix/Slack ingress) prefers the connected
   *   subscription, then the first connected API key, so a connected user's
   *   room chats run on their own account too.
   *
   * Returns `null` for "platform turn" — the caller changes nothing.
   */
  async resolveForTurn(params: {
    userDid: string;
    homeServerName: string;
    requestedModel?: string;
  }): Promise<ByoTurnState | null> {
    if (!this.isEnabled()) return null;
    const { userDid, homeServerName, requestedModel } = params;

    let requested: { provider: ByoProvider; modelId: string } | null = null;
    if (requestedModel !== undefined) {
      if (!isByoModelId(requestedModel)) return null;
      requested = parseByoModelId(requestedModel);
      if (!requested) {
        this.logger.warn(
          `Ignoring unknown BYO model "${requestedModel}" — falling back to the platform default.`,
        );
        return null;
      }
    }

    const creds = await this.getCredentials(userDid, homeServerName);

    if (requested) {
      const credential = creds[requested.provider];
      if (!credential) {
        this.logger.warn(
          `BYO model "${requestedModel}" requested but no ${requested.provider} credential is connected — falling back to the platform default.`,
        );
        return null;
      }
      return this.finalizeTurn(
        userDid,
        homeServerName,
        credential,
        requested.modelId,
      );
    }

    for (const provider of BYO_PROVIDERS) {
      const credential = creds[provider];
      if (credential) {
        return this.finalizeTurn(
          userDid,
          homeServerName,
          credential,
          BYO_DEFAULT_MODEL[provider],
        );
      }
    }
    return null;
  }

  private async finalizeTurn(
    userDid: string,
    homeServerName: string,
    credential: ByoCredential,
    mainModelId: string,
  ): Promise<ByoTurnState | null> {
    let effective = credential;
    if (credential.provider === 'chatgpt') {
      const fresh = await this.ensureFreshChatGptTokens(
        userDid,
        homeServerName,
        credential.oauth,
      );
      if (!fresh) {
        this.logger.warn(
          `ChatGPT token refresh failed for ${userDid} — turn falls back to the platform default (user must reconnect).`,
        );
        return null;
      }
      effective = { provider: 'chatgpt', oauth: fresh };
    }
    return {
      provider: effective.provider,
      credential: effective,
      mainModelId,
      byoModelId: toByoModelId(effective.provider, mainModelId),
    };
  }

  /**
   * Return tokens valid for at least {@link TOKEN_REFRESH_SKEW_MS} more ms,
   * refreshing (single-flight per user) and writing back when needed.
   */
  private async ensureFreshChatGptTokens(
    userDid: string,
    homeServerName: string | undefined,
    oauth: ChatGptOAuthTokens,
  ): Promise<ChatGptOAuthTokens | null> {
    if (oauth.expiresAt - TOKEN_REFRESH_SKEW_MS > Date.now()) {
      // Fresh enough — but if these tokens are an unpersisted shadow copy,
      // retry the write-back in the background so a process restart can't
      // strand the only valid copy of the rotated refresh token.
      if (this.pendingChatGptTokens.get(userDid)) {
        void this.retryPendingPersist(userDid, homeServerName);
      }
      return oauth;
    }

    // A recent refresh failure short-circuits the retry so a dead credential
    // costs one cache read per turn, not a token-endpoint round-trip.
    const coolingDown = await this.cacheManager.get<boolean>(
      this.refreshCooldownKey(userDid),
    );
    if (coolingDown) return null;

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
          `ChatGPT token refresh failed for ${userDid}${reconnect ? ' (refresh token expired/rotated — reconnect required)' : ''}: ${error instanceof Error ? error.message : String(error)}`,
        );
        await this.cacheManager.set(
          this.refreshCooldownKey(userDid),
          true,
          reconnect
            ? REFRESH_COOLDOWN_RECONNECT_MS
            : REFRESH_COOLDOWN_TRANSIENT_MS,
        );
        this.refreshInFlight.delete(userDid);
        return null;
      }

      try {
        if (this.epochOf(userDid) !== epochAtStart) {
          // A disconnect (or another write) superseded this refresh while it
          // was in flight — do not resurrect the credential.
          this.logger.log(
            `Discarding refreshed ChatGPT tokens for ${userDid} — credential changed mid-refresh`,
          );
          return null;
        }
        await this.storeChatGptTokens(userDid, tokens, homeServerName);
        return tokens;
      } catch (error) {
        // The refresh SUCCEEDED — only persisting it failed. The old refresh
        // token is already consumed upstream, so these tokens are the only
        // valid copy: hold them (no cooldown — nothing is wrong with the
        // credential) and let reads/retries pick them up.
        this.logger.error(
          `ChatGPT tokens refreshed but write-back failed for ${userDid} — holding in memory and retrying: ${error instanceof Error ? error.message : String(error)}`,
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
   * them in memory, drop the (stale) cached credential map so the next read
   * substitutes them, and clear any cooldown — the credential itself is fine.
   */
  async holdUnpersistedChatGptTokens(
    userDid: string,
    tokens: ChatGptOAuthTokens,
  ): Promise<void> {
    this.bumpEpoch(userDid);
    this.pendingChatGptTokens.set(userDid, tokens);
    await this.cacheManager.del(this.credsKey(userDid));
    await this.cacheManager.del(this.refreshCooldownKey(userDid));
  }

  /** Background retry of a pending token write-back, deduped per user. */
  private async retryPendingPersist(
    userDid: string,
    homeServerName?: string,
  ): Promise<void> {
    if (this.pendingPersistInFlight.has(userDid)) return;
    this.pendingPersistInFlight.add(userDid);
    try {
      const pending = this.pendingChatGptTokens.get(userDid);
      if (!pending) return;
      await this.storeChatGptTokens(userDid, pending, homeServerName);
      this.logger.log(
        `Persisted previously-held ChatGPT tokens for ${userDid}`,
      );
    } catch (error) {
      this.logger.warn(
        `Retry of ChatGPT token write-back failed for ${userDid}: ${error instanceof Error ? error.message : String(error)}`,
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
    homeServerName?: string,
  ): Promise<void> {
    const roomId = await this.resolveRoomId(userDid, homeServerName);
    if (!roomId) {
      throw new Error(
        `Cannot store ChatGPT tokens — no oracle room for ${userDid}`,
      );
    }
    // Bump on both sides of the Matrix write so a credential read overlapping
    // ANY part of it (started before, or started mid-write against the old
    // room state) fails the epoch check and refuses to cache a stale result.
    this.bumpEpoch(userDid);
    await SecretsService.getInstance().putSecret(
      roomId,
      BYO_SECRET_NAMES.chatgpt,
      JSON.stringify(tokens),
    );
    this.bumpEpoch(userDid);
    // Durably persisted — any shadow copy from an earlier failed write-back
    // is superseded (unless it is strictly fresher than what was just written).
    const pending = this.pendingChatGptTokens.get(userDid);
    if (pending && pending.expiresAt <= tokens.expiresAt) {
      this.pendingChatGptTokens.delete(userDid);
    }

    const cached = await this.cacheManager.get<ByoCredentialMap>(
      this.credsKey(userDid),
    );
    const next: ByoCredentialMap = {
      ...(cached ?? {}),
      chatgpt: { provider: 'chatgpt', oauth: tokens },
    };
    await this.cacheManager.set(
      this.credsKey(userDid),
      next,
      CREDS_CACHE_TTL_MS,
    );
    await this.cacheManager.del(this.refreshCooldownKey(userDid));
  }

  /**
   * Store a provider API key server-side, same as the OAuth path: encrypted
   * by the oracle to its own key and written into the canonical room. The
   * portal used to write these client-side through the agent-secrets flow,
   * but that depends on cross-device Matrix key sharing (browser device →
   * oracle device, often across federated homeservers) — when the room-key
   * to-device message goes missing the oracle stores ciphertext it can never
   * read. Server-side writes are always readable by construction, and the
   * oracle decrypts the key on every BYO turn anyway, so the exposure is
   * identical.
   */
  async storeApiKey(
    userDid: string,
    provider: Exclude<ByoProvider, 'chatgpt'>,
    apiKey: string,
    homeServerName?: string,
  ): Promise<void> {
    const roomId = await this.resolveRoomId(userDid, homeServerName);
    if (!roomId) {
      throw new Error(`Cannot store API key — no oracle room for ${userDid}`);
    }
    // Same both-sides epoch bump as the token store: an overlapping
    // credential read must refuse to cache around this write.
    this.bumpEpoch(userDid);
    await SecretsService.getInstance().putSecret(
      roomId,
      BYO_SECRET_NAMES[provider],
      apiKey,
    );
    this.bumpEpoch(userDid);

    const cached = await this.cacheManager.get<ByoCredentialMap>(
      this.credsKey(userDid),
    );
    const next: ByoCredentialMap = {
      ...(cached ?? {}),
      [provider]: { provider, apiKey },
    };
    await this.cacheManager.set(
      this.credsKey(userDid),
      next,
      CREDS_CACHE_TTL_MS,
    );
  }

  /** Remove a stored credential (index cleared, value redacted, caches dropped). */
  async deleteCredential(
    userDid: string,
    provider: ByoProvider,
    homeServerName?: string,
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

    const roomId = await this.resolveRoomId(userDid, homeServerName);
    if (!roomId) {
      throw new Error(
        `Cannot delete credential — no oracle room for ${userDid}`,
      );
    }
    await SecretsService.getInstance().deleteSecret(
      roomId,
      BYO_SECRET_NAMES[provider],
    );
    this.bumpEpoch(userDid);
    if (provider === 'chatgpt') {
      this.pendingChatGptTokens.delete(userDid);
    }
    await this.cacheManager.del(this.credsKey(userDid));
    await this.cacheManager.del(this.refreshCooldownKey(userDid));
  }

  /** Per-provider connection status + picker entries for the connect UI. */
  async status(
    userDid: string,
    homeServerName?: string,
    opts?: { refresh?: boolean },
  ): Promise<{ enabled: boolean; providers: ByoProviderStatus[] }> {
    if (!this.isEnabled()) {
      return { enabled: false, providers: [] };
    }
    const creds = await this.getCredentials(userDid, homeServerName, opts);
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
    homeServerName?: string,
  ): Promise<{ valid: boolean; error?: string }> {
    const creds = await this.getCredentials(userDid, homeServerName, {
      refresh: true,
    });
    const credential = creds[provider];
    if (!credential) {
      return { valid: false, error: 'Not connected' };
    }

    if (credential.provider === 'chatgpt') {
      // A user-initiated check is an explicit retry — lift any cooldown so
      // the refresh really runs instead of reporting the cached failure.
      await this.cacheManager.del(this.refreshCooldownKey(userDid));
      const fresh = await this.ensureFreshChatGptTokens(
        userDid,
        homeServerName,
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

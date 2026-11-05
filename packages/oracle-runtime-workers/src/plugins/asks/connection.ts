/**
 * One person's asks.world connection: the pending sign-in, the token pair
 * and the upload addresses submit_work handed out, all sealed under
 * ASKS_TOKEN_KEY. `AsksConnectionDO` wraps one of these per person; this
 * class holds the logic so tests can run it with a plain storage fake.
 *
 * Only this object refreshes. asks rotates the refresh token on every use and
 * ends the connection when one refresh token is used twice, so every read or
 * change of the tokens runs one at a time here (`serial`), a refresh reads
 * the pair only after the previous change was stored, and the new pair is
 * stored before anyone uses it.
 *
 * A sign-in is kept only for the asks account of the person who started it:
 * the start link can be forwarded, and whoever opens it would otherwise link
 * their own asks account to the starter's chat.
 */
import type { AsksConnectionDO } from './connection-do';
import {
  accountOf,
  addressOfDid,
  authorizeUrl,
  deriveKeys,
  endpointsOf,
  objectNameOf,
  pkceChallenge,
  postToken,
  randomToken,
  revokeToken,
  seal,
  unseal,
  type AsksEndpoints,
  type AsksKeys,
  type Sealed,
  type Tokens,
} from './oauth';

export const PENDING_TTL_MS = 15 * 60_000;
export const REFRESH_EARLY_MS = 2 * 60_000;

/** Where the sign-in started: the callback page offers the way back. */
export type Surface = 'whatsapp' | 'chat';

/** The Worker env this plugin reads: vars, the secret and the binding. */
export interface AsksWorkerEnv {
  /** The runtime's network: picks the asks connector (`ASKS_MCP_URLS`). */
  NETWORK?: string;
  /** Shown by asks beside the oracle's host when a person signs in. */
  ORACLE_NAME?: string;
  ASKS_TOKEN_KEY?: string;
  ASKS_WHATSAPP_RETURN_URL?: string;
  ORACLE_PUBLIC_URL?: string;
  CHANNEL_SERVICE_DID?: string;
  ASKS_CONNECTIONS?: DurableObjectNamespace<AsksConnectionDO>;
}

/** What the plugin calls on a person's connection object (its RPC methods). */
export type ConnectionApi = Pick<
  AsksConnection,
  | 'begin'
  | 'authorizeUrl'
  | 'complete'
  | 'status'
  | 'token'
  | 'refused'
  | 'disconnect'
  | 'keepUpload'
  | 'uploadOf'
>;

export interface ConnectionStorage {
  get<T>(key: string): Promise<T | undefined>;
  put(key: string, value: unknown): Promise<void>;
  delete(key: string): Promise<unknown>;
}

export interface ConnectionConfig {
  mcpUrl: string;
  publicUrl: string;
  tokenKey: string;
}

export interface ConnectionDeps {
  storage: ConnectionStorage;
  config: ConnectionConfig;
  fetch: typeof fetch;
  now: () => number;
}

interface Pending {
  state: string;
  verifier: string;
  surface: Surface;
  /** The oracle user who started it: only their own asks account may finish it. */
  did: string;
  expiresAt: number;
}

/** The pair, and the asks account it acts for. */
type Stored = Tokens & { account?: string };

type Uploads = Record<string, { address: string; expiresAt: number }>;

export type TokenRead =
  | { ok: true; access: string }
  | { ok: false; reason: 'not-connected' | 'ended' | 'unreachable' };

export type Completed =
  | { ok: true; surface: Surface }
  | {
      ok: false;
      /**
       * `other-account`: the sign-in was for another asks account than the
       * chat's person. `unconfirmed`: asks could not say whose it was.
       * Either way it was revoked and nothing kept.
       */
      reason:
        | 'unknown'
        | 'expired'
        | 'refused'
        | 'other-account'
        | 'unconfirmed';
    };

/** What a 401 on a token meant (`refused`). */
export type Refusal = 'replaced' | 'ended' | 'kept';

export class AsksConnection {
  private keys: Promise<AsksKeys> | null = null;

  private queue: Promise<unknown> = Promise.resolve();

  readonly endpoints: AsksEndpoints;

  constructor(private readonly deps: ConnectionDeps) {
    this.endpoints = endpointsOf(deps.config.mcpUrl, deps.config.publicUrl);
  }

  private async key(): Promise<CryptoKey> {
    return (await this.keyPair()).seal;
  }

  private keyPair(): Promise<AsksKeys> {
    this.keys ??= deriveKeys(this.deps.config.tokenKey);
    return this.keys;
  }

  /** One at a time, in order: every read or change of the tokens. */
  private serial<T>(work: () => Promise<T>): Promise<T> {
    const run = this.queue.then(work);
    this.queue = run.catch(() => undefined);
    return run;
  }

  private async read<T>(kind: string): Promise<T | null> {
    return unseal<T>(
      await this.key(),
      kind,
      await this.deps.storage.get<Sealed>(kind),
    );
  }

  private async write(kind: string, value: unknown): Promise<void> {
    await this.deps.storage.put(
      kind,
      await seal(await this.key(), kind, value),
    );
  }

  /** A new sign-in for this person (replaces an unfinished one): the short start link. */
  async begin(
    did: string,
    surface: Surface,
  ): Promise<{ link: string; expiresAt: number }> {
    const objectName = await objectNameOf(await this.keyPair(), did);
    const pending: Pending = {
      state: `${objectName}.${randomToken(24)}`,
      verifier: randomToken(32),
      surface,
      did,
      expiresAt: this.deps.now() + PENDING_TTL_MS,
    };
    await this.write('pending', pending);
    const base = this.deps.config.publicUrl.replace(/\/+$/, '');
    return {
      link: `${base}/asks/oauth/start/${pending.state}`,
      expiresAt: pending.expiresAt,
    };
  }

  private async pendingFor(
    state: string,
  ): Promise<Pending | 'unknown' | 'expired'> {
    const pending = await this.read<Pending>('pending');
    if (!pending || pending.state !== state) return 'unknown';
    return pending.expiresAt > this.deps.now() ? pending : 'expired';
  }

  /** Where the start link sends the browser, or why not. */
  async authorizeUrl(
    state: string,
  ): Promise<{ url: string } | { reason: 'unknown' | 'expired' }> {
    const pending = await this.pendingFor(state);
    if (typeof pending === 'string') return { reason: pending };
    return {
      url: authorizeUrl(
        this.endpoints,
        state,
        await pkceChallenge(pending.verifier),
      ),
    };
  }

  /**
   * The callback: trade the code for tokens, check they are the person's own
   * asks account, and keep them. The state is single use.
   */
  complete(state: string, code: string): Promise<Completed> {
    return this.serial(() => this.completeNow(state, code));
  }

  private async completeNow(state: string, code: string): Promise<Completed> {
    const pending = await this.pendingFor(state);
    if (typeof pending === 'string') return { ok: false, reason: pending };
    await this.deps.storage.delete('pending');
    const answer = await postToken(
      this.deps.fetch,
      this.endpoints,
      {
        grant_type: 'authorization_code',
        code,
        code_verifier: pending.verifier,
        redirect_uri: this.endpoints.redirectUri,
      },
      this.deps.now(),
    );
    if (!answer.ok) return { ok: false, reason: 'refused' };
    const account = await accountOf(
      this.deps.fetch,
      this.endpoints,
      answer.tokens.access,
    );
    if (
      account.kind !== 'ok' ||
      account.address !== addressOfDid(pending.did)
    ) {
      // Fail closed: a sign-in nobody can vouch for is ended, not kept.
      await revokeToken(this.deps.fetch, this.endpoints, answer.tokens.refresh);
      return {
        ok: false,
        reason: account.kind === 'ok' ? 'other-account' : 'unconfirmed',
      };
    }
    const stored: Stored = { ...answer.tokens, account: account.address };
    await this.write('tokens', stored);
    return { ok: true, surface: pending.surface };
  }

  async status(): Promise<{
    connected: boolean;
    pending: boolean;
    /** The asks account it acts for (ixo1…), when connected. */
    account?: string;
  }> {
    const [tokens, pending] = await Promise.all([
      this.read<Stored>('tokens'),
      this.read<Pending>('pending'),
    ]);
    return {
      connected: tokens !== null,
      pending: pending !== null && pending.expiresAt > this.deps.now(),
      ...(tokens?.account ? { account: tokens.account } : {}),
    };
  }

  /** A working access token, refreshed here (once, for every caller) 2 minutes before it ends. */
  token(): Promise<TokenRead> {
    return this.serial(async () => {
      // Read inside the queue: a refresh before this one has stored its pair.
      const tokens = await this.read<Stored>('tokens');
      if (!tokens) return { ok: false, reason: 'not-connected' };
      if (tokens.expiresAt - this.deps.now() > REFRESH_EARLY_MS)
        return { ok: true, access: tokens.access };
      return this.refresh(tokens);
    });
  }

  private async refresh(tokens: Stored): Promise<TokenRead> {
    const post = () =>
      postToken(
        this.deps.fetch,
        this.endpoints,
        { grant_type: 'refresh_token', refresh_token: tokens.refresh },
        this.deps.now(),
      );
    let answer = await post();
    // A lost answer may still have rotated the pair at asks: retry at once,
    // inside asks' 60-second grace for the replaced refresh token.
    if (!answer.ok && !answer.ended) answer = await post();
    if (answer.ok) {
      // Stored before use: a lost write would leave only the spent refresh token.
      await this.write('tokens', { ...answer.tokens, account: tokens.account });
      return { ok: true, access: answer.tokens.access };
    }
    if (answer.ended) {
      await this.drop();
      return { ok: false, reason: 'ended' };
    }
    // asks did not answer: the old token still works until it ends.
    return tokens.expiresAt > this.deps.now()
      ? { ok: true, access: tokens.access }
      : { ok: false, reason: 'unreachable' };
  }

  /**
   * A call with `access` got a 401 (or something that looked like one).
   * `replaced`: a newer pair is stored, try again with `token()`. `ended`:
   * asks itself refuses the token, so it was revoked and forgotten. `kept`:
   * asks still takes it, so the error was something else.
   */
  refused(access: string): Promise<Refusal> {
    return this.serial(async () => {
      const tokens = await this.read<Stored>('tokens');
      if (!tokens) return 'ended';
      if (tokens.access !== access) return 'replaced';
      const check = await accountOf(this.deps.fetch, this.endpoints, access);
      if (check.kind !== 'refused') return 'kept';
      await revokeToken(this.deps.fetch, this.endpoints, tokens.refresh);
      await this.drop();
      return 'ended';
    });
  }

  private async drop(): Promise<void> {
    await Promise.all([
      this.deps.storage.delete('tokens'),
      this.deps.storage.delete('uploads'),
    ]);
  }

  /** Revoke at asks, then forget. */
  disconnect(): Promise<void> {
    return this.serial(async () => {
      const tokens = await this.read<Stored>('tokens');
      if (tokens)
        await revokeToken(this.deps.fetch, this.endpoints, tokens.refresh);
      await this.drop();
    });
  }

  /** Keep the upload address submit_work gave for a draft (the model never sees it). */
  async keepUpload(
    draft: string,
    address: string,
    expiresAt: number,
  ): Promise<void> {
    const now = this.deps.now();
    const kept = (await this.read<Uploads>('uploads')) ?? {};
    const live = Object.fromEntries(
      Object.entries(kept).filter(([, one]) => one.expiresAt > now),
    );
    await this.write('uploads', { ...live, [draft]: { address, expiresAt } });
  }

  async uploadOf(draft: string): Promise<string | null> {
    const one = (await this.read<Uploads>('uploads'))?.[draft];
    return one && one.expiresAt > this.deps.now() ? one.address : null;
  }
}

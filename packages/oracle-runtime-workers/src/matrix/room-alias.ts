/**
 * The user↔oracle alias a room really carries.
 *
 * A room's `m.room.canonical_alias` is ordinary room state: any member with
 * the power to set it can write any alias there, and a homeserver does not
 * check aliases that live on another server. A room created on a server of
 * an attacker's own can therefore claim `#<victim>_<oracle>:<victim's
 * server>`. What cannot be forged is the alias directory of the alias's own
 * server, so an alias counts only when that server resolves it to the very
 * same room. Anything else — no alias, an alias that resolves elsewhere or
 * nowhere — is "no alias".
 *
 * Verdicts are memoised per room for a TTL and dropped when the room's alias
 * state changes. A lookup that fails (homeserver error, rate limit) is not a
 * verdict: it throws, nothing is memoised, and the caller retries later.
 */

export interface VerifiedRoomAliasDeps {
  /**
   * The room's canonical alias when it is one that matters (a user↔oracle
   * alias of this oracle), null otherwise. Throws when the state cannot be read.
   */
  readCanonicalAlias(roomId: string): Promise<string | null>;
  /** The room an alias points at in its server's directory; null when it points nowhere. Throws on any other failure. */
  resolveAlias(alias: string): Promise<string | null>;
  /** How long a verdict is served without asking again. */
  ttlMs: number;
  /** Upper bound on the rooms remembered at once (oldest dropped first). */
  maxRooms?: number;
  now?: () => number;
}

interface Verdict {
  alias: string | null;
  at: number;
}

const DEFAULT_MAX_ROOMS = 5_000;

export class VerifiedRoomAliases {
  private readonly verdicts = new Map<string, Verdict>();
  /** Bumped by `invalidate`, so a lookup that started before a change is not memoised after it. */
  private readonly generations = new Map<string, number>();
  private readonly now: () => number;

  constructor(private readonly deps: VerifiedRoomAliasDeps) {
    this.now = deps.now ?? Date.now;
  }

  /** The memoised verified alias of a room; null when there is none or no fresh verdict. */
  known(roomId: string): string | null {
    return this.fresh(roomId)?.alias ?? null;
  }

  /** The room's verified alias (null = none). Throws when the homeserver could not be asked. */
  async verify(roomId: string): Promise<string | null> {
    const memo = this.fresh(roomId);
    if (memo) return memo.alias;
    const generation = this.generations.get(roomId) ?? 0;
    const claimed = await this.deps.readCanonicalAlias(roomId);
    const alias =
      claimed !== null && (await this.deps.resolveAlias(claimed)) === roomId
        ? claimed
        : null;
    if ((this.generations.get(roomId) ?? 0) === generation)
      this.remember(roomId, alias);
    return alias;
  }

  /** Forget the room's verdict (its alias state changed). */
  invalidate(roomId: string): void {
    this.verdicts.delete(roomId);
    this.generations.set(roomId, (this.generations.get(roomId) ?? 0) + 1);
  }

  private fresh(roomId: string): Verdict | undefined {
    const verdict = this.verdicts.get(roomId);
    if (!verdict) return undefined;
    if (this.now() - verdict.at >= this.deps.ttlMs) {
      this.verdicts.delete(roomId);
      return undefined;
    }
    return verdict;
  }

  private remember(roomId: string, alias: string | null): void {
    this.verdicts.delete(roomId);
    const max = this.deps.maxRooms ?? DEFAULT_MAX_ROOMS;
    while (this.verdicts.size >= max) {
      const oldest = this.verdicts.keys().next().value;
      if (oldest === undefined) break;
      this.verdicts.delete(oldest);
    }
    this.verdicts.set(roomId, { alias, at: this.now() });
  }
}

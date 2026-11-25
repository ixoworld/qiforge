/**
 * Which users' turns are traced: the one rule LangSmith and IXO Traces share,
 * so the two can never select different users by accident.
 *
 * A DID list is a comma-separated string. Each entry is trimmed, empty
 * entries are dropped, and a user matches an entry only when the entry is
 * exactly their DID (case-sensitive, no other normalisation): the DID the
 * runtime traced under is the UCAN-authenticated one, spelled as it was
 * proved. An entry `*` selects everyone.
 *
 * - LangSmith (`langsmithTracedUsers`): `LANGSMITH_TRACING=true` selects
 *   everyone (the list is then ignored); otherwise `LANGSMITH_TRACED_DIDS`
 *   selects its DIDs, and with no list LangSmith selects no one (it is off).
 *   An API key is needed on top of this for anything to be sent.
 * - IXO Traces (`turnTracesUsers`): `TRACES_TRACED_DIDS` unset follows
 *   LangSmith's selection, except that where LangSmith selects no one
 *   because neither of its variables is set there is no list to follow and
 *   every user is traced. `TRACES_TRACED_DIDS=*` traces everyone; a list
 *   traces only those DIDs, matched exactly as LangSmith matches.
 */

export type TracedUsers =
  | { readonly kind: 'everyone' }
  | { readonly kind: 'listed'; readonly dids: ReadonlySet<string> }
  | { readonly kind: 'none' };

const EVERYONE: TracedUsers = { kind: 'everyone' };
const NONE: TracedUsers = { kind: 'none' };

/** Parsed lists by their raw value (env values are deploy-stable: a handful per isolate). */
const parsedLists = new Map<string, TracedUsers>();
const PARSED_LISTS_MAX = 16;

/**
 * A raw DID list as a selection: `everyone` when an entry is `*`, `listed`
 * with its DIDs, or undefined when it holds no entry (unset, empty, only
 * commas or blanks).
 */
export function parseTracedDidList(
  raw: string | undefined,
): TracedUsers | undefined {
  if (raw === undefined) return undefined;
  let users = parsedLists.get(raw);
  if (!users) {
    const dids = new Set(
      raw
        .split(',')
        .map((entry) => entry.trim())
        .filter((entry) => entry.length > 0),
    );
    users = dids.has('*')
      ? EVERYONE
      : dids.size > 0
        ? { kind: 'listed', dids }
        : NONE;
    if (parsedLists.size >= PARSED_LISTS_MAX) parsedLists.clear();
    parsedLists.set(raw, users);
  }
  return users.kind === 'none' ? undefined : users;
}

/** Whether `userDid` is one of `users`. */
export function isTracedUser(users: TracedUsers, userDid: string): boolean {
  switch (users.kind) {
    case 'everyone':
      return true;
    case 'listed':
      return users.dids.has(userDid);
    case 'none':
      return false;
  }
}

/** The LangSmith variables that choose users (`LangsmithTracingEnv`'s slice). */
export interface LangsmithUserSelectionEnv {
  /** Raw `LANGSMITH_TRACING`; `'true'` (trimmed) selects everyone. */
  tracing?: string;
  /** Raw `LANGSMITH_TRACED_DIDS`. */
  tracedDids?: string;
}

/** The users LangSmith traces (given an API key). */
export function langsmithTracedUsers(
  env: LangsmithUserSelectionEnv,
): TracedUsers {
  if (env.tracing?.trim() === 'true') return EVERYONE;
  return parseTracedDidList(env.tracedDids) ?? NONE;
}

/** How IXO Traces chooses users, for the one log line per isolate. */
export type TurnTracesUsersSource =
  /** `TRACES_TRACED_DIDS` is set. */
  | 'override'
  /** Following LangSmith's selection. */
  | 'langsmith'
  /** Neither `TRACES_TRACED_DIDS` nor a LangSmith selection: everyone. */
  | 'default';

export interface TurnTracesUsers {
  users: TracedUsers;
  source: TurnTracesUsersSource;
}

/** The users IXO Traces traces (given a traces key and destination). */
export function turnTracesUsers(
  langsmith: LangsmithUserSelectionEnv,
  override: string | undefined,
): TurnTracesUsers {
  const own = parseTracedDidList(override);
  if (own) return { users: own, source: 'override' };
  const followed = langsmithTracedUsers(langsmith);
  return followed.kind === 'none'
    ? { users: EVERYONE, source: 'default' }
    : { users: followed, source: 'langsmith' };
}

/** `TurnTracesUsers` in words, without any DID: the mode and the list size. */
export function describeTurnTracesUsers({
  users,
  source,
}: TurnTracesUsers): string {
  const who =
    users.kind === 'listed'
      ? `${users.dids.size} listed DID${users.dids.size === 1 ? '' : 's'}`
      : 'everyone';
  const from =
    source === 'override'
      ? 'TRACES_TRACED_DIDS'
      : source === 'langsmith'
        ? 'the LangSmith selection'
        : 'no list set';
  return `${who} (${from})`;
}

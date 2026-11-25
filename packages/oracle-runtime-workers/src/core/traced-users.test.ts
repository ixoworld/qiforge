import { describe, expect, it, vi } from 'vitest';
import { resolveLangsmithTracing, type LangsmithTracingEnv } from './llm';
import {
  describeTurnTracesUsers,
  isTracedUser,
  langsmithTracedUsers,
  parseTracedDidList,
  turnTracesUsers,
} from './traced-users';
import { turnTracesUsersFromEnv } from '../traces/config';

const ALICE = 'did:ixo:ixo1alice';
const BOB = 'did:ixo:ixo1bob';
const CAROL = 'did:ixo:ixo1carol';
const USERS = [ALICE, BOB, CAROL];

/** Whether LangSmith attaches its tracer to `userDid`'s turn. */
function langsmithTraces(env: LangsmithTracingEnv, userDid: string): boolean {
  return (
    resolveLangsmithTracing({ userDid, client: 'portal', env }).callbacks !==
    undefined
  );
}

/** Whether IXO Traces traces `userDid`'s turn. */
function oursTraces(
  env: LangsmithTracingEnv,
  override: string | undefined,
  userDid: string,
): boolean {
  return isTracedUser(turnTracesUsers(env, override).users, userDid);
}

describe('which users LangSmith and IXO Traces trace', () => {
  it('with no LangSmith list and LANGSMITH_TRACING=true, both trace everyone', () => {
    const env = { apiKey: 'ls-key', tracing: 'true' };
    for (const did of USERS) {
      expect(langsmithTraces(env, did)).toBe(true);
      expect(oursTraces(env, undefined, did)).toBe(true);
    }
  });

  it('with no LangSmith list and no switch, LangSmith is off and IXO Traces traces everyone', () => {
    // LangSmith with a key but neither variable traces no one (today's rule).
    const env: LangsmithTracingEnv = { apiKey: 'ls-key' };
    expect(langsmithTracedUsers(env)).toEqual({ kind: 'none' });
    for (const did of USERS) {
      expect(langsmithTraces(env, did)).toBe(false);
      expect(oursTraces(env, undefined, did)).toBe(true);
    }
    expect(turnTracesUsers(env, undefined).source).toBe('default');
    // A list of only blanks and commas is no list.
    expect(turnTracesUsers({ tracedDids: ' , ,' }, undefined)).toEqual({
      users: { kind: 'everyone' },
      source: 'default',
    });
    expect(
      langsmithTraces({ apiKey: 'ls-key', tracedDids: ' , ,' }, ALICE),
    ).toBe(false);
  });

  it('with a LangSmith list, both trace exactly the listed users', () => {
    const env = { apiKey: 'ls-key', tracedDids: `${ALICE}, ${BOB}` };
    for (const did of USERS)
      expect(oursTraces(env, undefined, did)).toBe(langsmithTraces(env, did));
    expect(oursTraces(env, undefined, ALICE)).toBe(true);
    expect(oursTraces(env, undefined, BOB)).toBe(true);
    expect(oursTraces(env, undefined, CAROL)).toBe(false);
    expect(turnTracesUsers(env, undefined).source).toBe('langsmith');
  });

  it('a LangSmith list of `*` is everyone for both', () => {
    const env = { apiKey: 'ls-key', tracedDids: `${ALICE},*` };
    for (const did of USERS) {
      expect(langsmithTraces(env, did)).toBe(true);
      expect(oursTraces(env, undefined, did)).toBe(true);
    }
  });

  it('LANGSMITH_TRACING=true wins over a LangSmith list, for both', () => {
    const env = { apiKey: 'ls-key', tracing: ' true ', tracedDids: ALICE };
    for (const did of USERS) {
      expect(langsmithTraces(env, did)).toBe(true);
      expect(oursTraces(env, undefined, did)).toBe(true);
    }
  });

  it('TRACES_TRACED_DIDS=* traces everyone while LangSmith keeps its list', () => {
    const env = { apiKey: 'ls-key', tracedDids: ALICE };
    for (const did of USERS) expect(oursTraces(env, '*', did)).toBe(true);
    expect(langsmithTraces(env, ALICE)).toBe(true);
    expect(langsmithTraces(env, BOB)).toBe(false);
    expect(turnTracesUsers(env, '*').source).toBe('override');
  });

  it('a TRACES_TRACED_DIDS list traces only its users, whatever LangSmith traces', () => {
    const everyone = { apiKey: 'ls-key', tracing: 'true' };
    expect(oursTraces(everyone, ` ${CAROL} `, CAROL)).toBe(true);
    expect(oursTraces(everyone, ` ${CAROL} `, ALICE)).toBe(false);
    expect(langsmithTraces(everyone, ALICE)).toBe(true);
    const listed = { apiKey: 'ls-key', tracedDids: ALICE };
    expect(oursTraces(listed, BOB, BOB)).toBe(true);
    expect(oursTraces(listed, BOB, ALICE)).toBe(false);
    // An override of only blanks is unset: LangSmith's list again.
    expect(oursTraces(listed, ' , ', ALICE)).toBe(true);
    expect(oursTraces(listed, ' , ', BOB)).toBe(false);
  });

  it('matches DIDs exactly as LangSmith does: entries trimmed, case and spelling kept', () => {
    const list = ' did:ixo:ixo1MixedCase ,did:ixo:ixo1plain ';
    const env = { apiKey: 'ls-key', tracedDids: list };
    const candidates = [
      'did:ixo:ixo1MixedCase',
      'did:ixo:ixo1mixedcase',
      'DID:IXO:IXO1PLAIN',
      'did:ixo:ixo1plain',
      ' did:ixo:ixo1plain',
      'did:ixo:ixo1plain/',
      'did:ixo:ixo1pla',
    ];
    const langsmith = candidates.map((did) => langsmithTraces(env, did));
    expect(langsmith).toEqual([true, false, false, true, false, false, false]);
    expect(candidates.map((did) => oursTraces(env, undefined, did))).toEqual(
      langsmith,
    );
    // The same list as TRACES_TRACED_DIDS matches the same users.
    expect(candidates.map((did) => oursTraces({}, list, did))).toEqual(
      langsmith,
    );
  });

  it('describes the mode with the list size and never a DID', () => {
    const text = describeTurnTracesUsers(
      turnTracesUsers({ tracedDids: `${ALICE},${BOB}` }, undefined),
    );
    expect(text).toBe('2 listed DIDs (the LangSmith selection)');
    expect(describeTurnTracesUsers(turnTracesUsers({}, '*'))).toBe(
      'everyone (TRACES_TRACED_DIDS)',
    );
    expect(describeTurnTracesUsers(turnTracesUsers({}, CAROL))).toBe(
      '1 listed DID (TRACES_TRACED_DIDS)',
    );
    expect(describeTurnTracesUsers(turnTracesUsers({}, undefined))).toBe(
      'everyone (no list set)',
    );
  });

  it('logs the mode once per isolate, not per turn, and without DIDs', () => {
    const logger = {
      log: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    };
    const env = { TRACES_TRACED_DIDS: `${ALICE},${BOB},${CAROL}` };
    const langsmith = { tracedDids: 'did:ixo:ixo1loggedonce' };
    for (let i = 0; i < 5; i += 1)
      expect(
        isTracedUser(turnTracesUsersFromEnv(env, langsmith, logger), BOB),
      ).toBe(true);
    expect(logger.log).toHaveBeenCalledTimes(1);
    const line = String(logger.log.mock.calls[0]![0]);
    expect(line).toBe(
      '[traces] turn traces: 3 listed DIDs (TRACES_TRACED_DIDS)',
    );
    for (const did of [...USERS, langsmith.tracedDids])
      expect(line).not.toContain(did);
  });

  it('parses a list once and hands back the same selection', () => {
    const raw = `${ALICE},${BOB}`;
    expect(parseTracedDidList(raw)).toBe(parseTracedDidList(raw));
    expect(parseTracedDidList(undefined)).toBeUndefined();
    expect(parseTracedDidList('')).toBeUndefined();
  });
});

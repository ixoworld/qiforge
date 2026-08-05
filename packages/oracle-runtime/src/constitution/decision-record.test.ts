/**
 * @fileoverview Tests for the decision ledger's pure layer.
 *
 * The property under test throughout is tamper-evidence: a record that has
 * been altered must not verify, and the alteration must be reported at the
 * record where it happened. Everything else here — the canonical form, the
 * request digest — exists to make that property hold across two machines
 * rather than only within one.
 */
import { describe, expect, it } from 'vitest';
import type {
  AuthorizationDecision,
  AuthorizationRequest,
} from './authorize.js';
import {
  canonicalize,
  DecisionChain,
  digestRequest,
  verifyChain,
  type DecisionRecord,
} from './decision-record.js';

const RUB = { authority: 'did:ixo:entity:dv-114', id: 'bafy123@1.2.0' };

function request(
  overrides: Partial<AuthorizationRequest> = {},
): AuthorizationRequest {
  return {
    principal: { did: 'did:ixo:entity:dv-114', sessionId: 'sess-1' },
    action: 'pay',
    operation: 'settle_invoice',
    object: 'ixo:treasury',
    value: { amount: '100', denom: 'uixo' },
    ...overrides,
  };
}

function decision(
  overrides: Partial<AuthorizationDecision> = {},
): AuthorizationDecision {
  return {
    outcome: 'permit',
    reasonCodes: [],
    ruleRefs: ['right:dv114:pay'],
    obligations: [],
    time: {
      instant: '2026-08-03T00:00:00.000Z',
      epochMs: Date.parse('2026-08-03T00:00:00.000Z'),
      source: 'system_clock',
      trusted: true,
    },
    ...overrides,
  };
}

/** Ids from a counter, so a chain in a test is a chain you can predict. */
function chain(): DecisionChain {
  let n = 0;
  return new DecisionChain({
    newId: () => {
      n += 1;
      return `jti-${n}`;
    },
  });
}

function append(
  ledger: DecisionChain,
  overrides: Partial<AuthorizationRequest> = {},
  verdict: Partial<AuthorizationDecision> = {},
): DecisionRecord {
  return ledger.append({
    toolName: 'settle_invoice',
    request: request(overrides),
    decision: decision(verdict),
    effectAssumed: false,
    rub: RUB,
    aud: 'sess-1',
  });
}

describe('canonicalize', () => {
  it('orders object keys, whatever order they were written in', () => {
    expect(canonicalize({ b: 1, a: 2 })).toBe('{"a":2,"b":1}');
    expect(canonicalize({ a: 2, b: 1 })).toBe('{"a":2,"b":1}');
  });

  // The whole reason a canonical form is needed: two runtimes building the
  // same record from differently-ordered literals must hash it identically.
  it('gives the same bytes for the same content, nested', () => {
    const one = { z: { y: [1, { b: 'x', a: 'w' }] }, m: null };
    const two = { m: null, z: { y: [1, { a: 'w', b: 'x' }] } };
    expect(canonicalize(one)).toBe(canonicalize(two));
  });

  it('sorts by UTF-16 code unit, not by locale', () => {
    // A locale-aware sort orders these the other way round.
    expect(canonicalize({ a: 1, B: 2 })).toBe('{"B":2,"a":1}');
  });

  it('preserves array order, which is content rather than presentation', () => {
    expect(canonicalize([3, 1, 2])).toBe('[3,1,2]');
  });

  it('omits undefined members but keeps null ones', () => {
    expect(canonicalize({ a: undefined, b: null })).toBe('{"b":null}');
  });

  it('normalises negative zero', () => {
    expect(canonicalize(-0)).toBe('0');
  });

  it('escapes strings the way JSON does, lone surrogates included', () => {
    expect(canonicalize('a"b\\c\nd')).toBe('"a\\"b\\\\c\\nd"');
    expect(canonicalize('\u{1F600}')).toBe('"\u{1F600}"');
  });

  // Silently dropping one of these would hash over less than was supplied,
  // and a chain verifying over less than it covers still reads as evidence.
  it.each([
    ['a Date', new Date()],
    ['a Map', new Map()],
    ['a bigint', 10n],
    ['a function', () => undefined],
    ['NaN', Number.NaN],
    ['Infinity', Number.POSITIVE_INFINITY],
  ])('refuses to canonicalize %s', (_label, value) => {
    expect(() => canonicalize(value)).toThrow(TypeError);
  });
});

describe('DecisionChain', () => {
  it('starts at seq 0 with no predecessor', () => {
    const record = append(chain());
    expect(record.seq).toBe(0);
    expect(record.prev_hash).toBeNull();
    expect(record.hash).toMatch(/^[0-9a-f]{64}$/);
  });

  it('binds each record to the one before it', () => {
    const ledger = chain();
    const first = append(ledger);
    const second = append(ledger);
    const third = append(ledger);

    expect(second.prev_hash).toBe(first.hash);
    expect(third.prev_hash).toBe(second.hash);
    expect([first.seq, second.seq, third.seq]).toEqual([0, 1, 2]);
    expect(ledger.length).toBe(3);
    expect(ledger.tip).toBe(third);
  });

  // A ledger of only refusals cannot show that anything was checked.
  it('records permits as readily as refusals', () => {
    const ledger = chain();
    const permitted = append(ledger);
    const denied = append(
      ledger,
      {},
      { outcome: 'deny', reasonCodes: ['no_matching_grant'], ruleRefs: [] },
    );
    expect(permitted.verdict.outcome).toBe('permit');
    expect(denied.verdict.outcome).toBe('deny');
    expect(denied.verdict.reason_codes).toEqual(['no_matching_grant']);
    expect(verifyChain([permitted, denied])).toBeNull();
  });

  it('names the exact rules the decision was made under', () => {
    const record = append(chain());
    expect(record.rub).toEqual({
      authority: 'did:ixo:entity:dv-114',
      id: 'bafy123@1.2.0',
    });
  });

  it('says whether the action class was declared or assumed', () => {
    const ledger = chain();
    const assumed = ledger.append({
      toolName: 'mystery_tool',
      request: request(),
      decision: decision(),
      effectAssumed: true,
      rub: RUB,
      aud: null,
    });
    expect(assumed.request.effect).toBe('assumed');
    expect(append(ledger).request.effect).toBe('declared');
  });

  // A decisions room readable by anyone auditing the entity must not double
  // as a place to harvest bearer credentials.
  it('records a capability digest and never the token', () => {
    const ledger = chain();
    const record = ledger.append({
      toolName: 'settle_invoice',
      request: request({ capabilityProof: 'eyJhbGciOi.SECRET-UCAN.sig' }),
      decision: decision({
        capability: { proofDigest: 'sha256:abc', revoked: false },
      }),
      effectAssumed: false,
      rub: RUB,
      aud: null,
    });
    expect(record.cap).toEqual({ cid: 'sha256:abc' });
    expect(JSON.stringify(record)).not.toContain('SECRET-UCAN');
  });

  // Model-supplied arguments can carry anything a user typed.
  it('records the decision-relevant facts and not the arguments', () => {
    const record = append(chain());
    expect(record.request.object).toBe('ixo:treasury');
    expect(record.request.value).toEqual({ amount: '100', denom: 'uixo' });
    expect(record.request).not.toHaveProperty('args');
  });

  it('carries the clock forward, source and trust included', () => {
    const record = append(
      chain(),
      {},
      {
        time: {
          instant: '2026-08-03T00:00:00.000Z',
          epochMs: 0,
          source: 'system_clock',
          trusted: false,
        },
      },
    );
    expect(record.time).toEqual({
      source: 'system_clock',
      instant: '2026-08-03T00:00:00.000Z',
      trusted: false,
    });
  });

  it('freezes each record once it is written', () => {
    expect(Object.isFrozen(append(chain()))).toBe(true);
  });
});

describe('verifyChain', () => {
  // The middle record is a refusal, so the tampering test below can attempt
  // the change someone would actually want: turning a deny into a permit.
  const built = () => {
    const ledger = chain();
    return [
      append(ledger),
      append(
        ledger,
        {},
        { outcome: 'deny', reasonCodes: ['no_matching_grant'], ruleRefs: [] },
      ),
      append(ledger),
    ];
  };

  it('accepts a chain it built', () => {
    expect(verifyChain(built())).toBeNull();
  });

  it('accepts an empty chain', () => {
    expect(verifyChain([])).toBeNull();
  });

  // The point of the whole exercise: a verdict cannot be quietly rewritten
  // after the fact.
  it('catches a refusal rewritten into a permit', () => {
    const records = built();
    expect(records[1].verdict.outcome).toBe('deny');
    const tampered = {
      ...records[1],
      verdict: {
        ...records[1].verdict,
        outcome: 'permit',
        reason_codes: [] as string[],
      },
    };
    const found = verifyChain([records[0], tampered, records[2]]);
    expect(found?.reason).toBe('hash-mismatch');
    expect(found?.seq).toBe(1);
  });

  it('catches a rewritten object', () => {
    const records = built();
    const tampered = {
      ...records[0],
      request: { ...records[0].request, object: 'ixo:someone-elses-treasury' },
    };
    expect(verifyChain([tampered, records[1], records[2]])?.reason).toBe(
      'hash-mismatch',
    );
  });

  // Removing a record is the cheapest way to hide one, so it has to be the
  // most obvious thing the chain catches.
  it('catches a removed record', () => {
    const records = built();
    const found = verifyChain([records[0], records[2]]);
    expect(found?.reason).toBe('sequence-gap');
    expect(found?.seq).toBe(2);
  });

  it('catches a reordered chain', () => {
    const records = built();
    expect(verifyChain([records[0], records[2], records[1]])).not.toBeNull();
  });

  it('catches a record spliced in from another chain', () => {
    const records = built();
    const other = append(chain(), { object: 'ixo:elsewhere' });
    const spliced = { ...other, seq: 1 };
    expect(verifyChain([records[0], spliced])?.reason).toBe('broken-link');
  });
});

describe('digestRequest', () => {
  it('is stable for the same action on the same object for the same value', () => {
    expect(digestRequest(request())).toBe(digestRequest(request()));
  });

  it.each([
    ['the object', { object: 'ixo:other-treasury' }],
    ['the operation', { operation: 'refund' }],
    ['the action class', { action: 'transfer' as const }],
    ['the value', { value: { amount: '101', denom: 'uixo' } }],
    ['the denomination', { value: { amount: '100', denom: 'uusd' } }],
  ])('changes when %s changes', (_label, overrides) => {
    expect(digestRequest(request(overrides))).not.toBe(
      digestRequest(request()),
    );
  });

  // An approval is about what may be done. Binding it to the session would
  // make the operator re-approve the same action in every new conversation,
  // which trains them to approve without reading.
  it('is the same across sessions', () => {
    const other = request();
    other.principal = { did: other.principal.did, sessionId: 'sess-2' };
    expect(digestRequest(other)).toBe(digestRequest(request()));
  });
});

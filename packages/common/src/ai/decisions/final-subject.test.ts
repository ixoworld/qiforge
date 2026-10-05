import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  assertFinalDecisionSubjectUnchanged,
  canonicalizeFinalDecisionSubject,
  canonicalizeIxoJson,
  createDecisionAuthorityReceipt,
  createDecisionExecutionReceipt,
  digestFinalDecisionSubject,
  StaleDecisionSubjectError,
  type FinalDecisionSubject,
  type FinalDecisionSubjectBinding,
  type FinalDecisionSubjectValue,
} from './final-subject.js';

const subject = (): FinalDecisionSubject => ({
  kind: 'payment',
  action: {
    amount: '125.00',
    currency: 'USD',
    payee: 'did:ixo:recipient',
  },
  evidenceRefs: ['claim:123', 'evidence:abc'],
  policyRef: 'rubric:pay-v3',
  context: {
    network: 'impact-hub',
  },
});

describe('Final Decision Subject canonicalization (ixo-json-v1)', () => {
  it('sorts object keys at every depth and emits compact JSON', () => {
    const a: FinalDecisionSubject = {
      kind: 'payment',
      action: { z: 1, a: { y: true, b: null } },
    };
    const b: FinalDecisionSubject = {
      action: { a: { b: null, y: true }, z: 1 },
      kind: 'payment',
    };

    expect(canonicalizeFinalDecisionSubject(a)).toBe(
      '{"action":{"a":{"b":null,"y":true},"z":1},"kind":"payment"}',
    );
    expect(canonicalizeFinalDecisionSubject(b)).toBe(
      canonicalizeFinalDecisionSubject(a),
    );
  });

  it('normalises negative zero and keeps array order material', () => {
    expect(
      canonicalizeFinalDecisionSubject({ kind: 'n', action: { v: -0 } }),
    ).toBe('{"action":{"v":0},"kind":"n"}');
    expect(
      canonicalizeFinalDecisionSubject({
        kind: 'allocation',
        action: { priority: ['alpha', 'beta'] },
      }),
    ).not.toBe(
      canonicalizeFinalDecisionSubject({
        kind: 'allocation',
        action: { priority: ['beta', 'alpha'] },
      }),
    );
  });

  it('rejects non-finite numbers', () => {
    expect(() =>
      canonicalizeFinalDecisionSubject({
        kind: 'tool-call',
        action: { amount: Number.NaN },
      }),
    ).toThrow(/finite JSON numbers/);
    expect(() =>
      canonicalizeFinalDecisionSubject({
        kind: 'tool-call',
        action: { amount: Number.POSITIVE_INFINITY },
      }),
    ).toThrow(/finite JSON numbers/);
  });

  it('rejects an explicitly undefined field instead of dropping it', () => {
    expect(() =>
      canonicalizeFinalDecisionSubject({ ...subject(), policyRef: undefined }),
    ).toThrow(/"policyRef" is not JSON-safe/);
  });

  it('rejects class instances, which do not round-trip through JSON', () => {
    class Amount {
      [key: string]: FinalDecisionSubjectValue;
      value = '125.00';
    }

    expect(() =>
      canonicalizeFinalDecisionSubject({
        kind: 'payment',
        action: { amount: new Amount() },
      }),
    ).toThrow(/plain JSON objects/);
  });

  it('rejects sparse arrays', () => {
    const sparse = new Array<string>(2);

    expect(() =>
      canonicalizeFinalDecisionSubject({
        kind: 'allocation',
        action: { priority: sparse },
      }),
    ).toThrow(/sparse holes/);
  });

  it('rejects sparse arrays even when extra enumerable keys hide the key-count mismatch', () => {
    const sparse = new Array<string>(2);
    sparse[1] = 'x';
    const disguised = Object.assign(sparse, { extra: true });

    expect(() =>
      canonicalizeFinalDecisionSubject({
        kind: 'allocation',
        action: { priority: disguised },
      }),
    ).toThrow(/sparse holes/);
  });

  it('rejects an empty kind', () => {
    expect(() =>
      canonicalizeFinalDecisionSubject({ kind: '  ', action: null }),
    ).toThrow(/kind must be non-empty/);
  });

  it('reads kind once, so a getter cannot pass the check with one value and hash another', () => {
    let reads = 0;
    const passesThenEmpty = {
      action: null,
      get kind() {
        reads += 1;
        return reads === 1 ? 'payment' : '';
      },
    };
    const emptyThenPasses = {
      action: null,
      get kind() {
        reads += 1;
        return reads === 1 ? '' : 'payment';
      },
    };

    expect(canonicalizeFinalDecisionSubject(passesThenEmpty)).toBe(
      '{"action":null,"kind":"payment"}',
    );
    expect(reads).toBe(1);

    reads = 0;
    expect(() => canonicalizeFinalDecisionSubject(emptyThenPasses)).toThrow(
      /kind must be non-empty/,
    );
    expect(reads).toBe(1);
  });

  it('reads an array length and each element once', () => {
    let lengthReads = 0;
    let elementReads = 0;
    const items = ['alpha', 'beta'];
    const counted = new Proxy(items, {
      get(target, property, receiver) {
        if (property === 'length') lengthReads += 1;
        if (property === '0' || property === '1') elementReads += 1;
        return Reflect.get(target, property, receiver);
      },
    });

    expect(
      canonicalizeFinalDecisionSubject({
        kind: 'allocation',
        action: { priority: counted },
      }),
    ).toBe('{"action":{"priority":["alpha","beta"]},"kind":"allocation"}');
    expect(lengthReads).toBe(1);
    expect(elementReads).toBe(2);
  });

  it('requires an action and string evidence references', () => {
    // As decoded from an untyped source such as a request body.
    const noAction: FinalDecisionSubject = JSON.parse('{"kind":"payment"}');
    const numericRefs: FinalDecisionSubject = JSON.parse(
      '{"kind":"payment","action":null,"evidenceRefs":[1]}',
    );

    expect(() => canonicalizeFinalDecisionSubject(noAction)).toThrow(
      /action is required/,
    );
    expect(() => canonicalizeFinalDecisionSubject(numericRefs)).toThrow(
      /evidenceRefs must be an array of strings/,
    );
  });
});

describe('ixo-json-v1 canonical form', () => {
  it('rejects values JSON would silently change or drop', () => {
    const cases: [string, unknown, RegExp][] = [
      ['Date', new Date(0), /plain JSON objects/],
      ['BigInt', BigInt(1), /non-JSON bigint/],
      ['Map', new Map([['a', 1]]), /plain JSON objects/],
      ['Uint8Array', new Uint8Array([1, 2]), /plain JSON objects/],
      ['symbol', Symbol('s'), /non-JSON symbol/],
      ['function', () => 1, /non-JSON function/],
      // A field holding undefined and an array slot holding it word it apart.
      ['undefined', undefined, /not JSON-safe|non-JSON undefined/],
    ];
    for (const [, value, error] of cases) {
      expect(() => canonicalizeIxoJson({ value })).toThrow(error);
      expect(() => canonicalizeIxoJson([value])).toThrow(error);
    }
  });

  it('fails closed on a cyclic object and a cyclic array', () => {
    const object: Record<string, unknown> = { a: 1 };
    object.self = object;
    const array: unknown[] = [1];
    array.push(array);

    expect(() => canonicalizeIxoJson(object)).toThrow(/cycles \(at \$\.self\)/);
    expect(() => canonicalizeIxoJson({ nested: array })).toThrow(/cycles/);
  });

  it('accepts a value shared by two branches, which is not a cycle', () => {
    const shared = { id: 1 };

    expect(canonicalizeIxoJson({ a: shared, b: shared })).toBe(
      '{"a":{"id":1},"b":{"id":1}}',
    );
  });

  it('writes numbers and strings exactly as fixed outputs', () => {
    expect(canonicalizeIxoJson(1e21)).toBe('1e+21');
    expect(canonicalizeIxoJson(1e-7)).toBe('1e-7');
    expect(canonicalizeIxoJson(0.1)).toBe('0.1');
    expect(canonicalizeIxoJson(-0)).toBe('0');
    expect(canonicalizeIxoJson('\ud800')).toBe('"\\ud800"');
    expect(canonicalizeIxoJson('é\n"')).toBe('"é\\n\\""');
    expect(canonicalizeIxoJson({ b: 1, B: 2, a: 3 })).toBe(
      '{"B":2,"a":3,"b":1}',
    );
  });
});

describe('Final Decision Subject digest', () => {
  it('is the SHA-256 hex digest of the canonical UTF-8 bytes', async () => {
    const value = subject();
    const expected = createHash('sha256')
      .update(canonicalizeFinalDecisionSubject(value), 'utf8')
      .digest('hex');

    await expect(digestFinalDecisionSubject(value)).resolves.toEqual({
      algorithm: 'sha256',
      canonicalization: 'ixo-json-v1',
      subjectDigest: expected,
    });
  });

  it('is independent of key order and sensitive to array order', async () => {
    const reordered: FinalDecisionSubject = {
      context: { network: 'impact-hub' },
      policyRef: 'rubric:pay-v3',
      evidenceRefs: ['claim:123', 'evidence:abc'],
      action: { payee: 'did:ixo:recipient', currency: 'USD', amount: '125.00' },
      kind: 'payment',
    };
    const evidenceSwapped: FinalDecisionSubject = {
      ...subject(),
      evidenceRefs: ['evidence:abc', 'claim:123'],
    };

    const base = await digestFinalDecisionSubject(subject());
    expect(await digestFinalDecisionSubject(reordered)).toEqual(base);
    expect(
      (await digestFinalDecisionSubject(evidenceSwapped)).subjectDigest,
    ).not.toBe(base.subjectDigest);
  });
});

describe('Decision authority and execution receipts', () => {
  it('allows execution when the authorized subject is unchanged', async () => {
    const authority = await createDecisionAuthorityReceipt({
      subject: subject(),
      mechanism: 'ucan',
      reference: 'ucan:abc',
      authorizedAt: '2026-09-22T05:00:00.000Z',
    });

    await expect(
      assertFinalDecisionSubjectUnchanged(authority.subject, subject()),
    ).resolves.toBeUndefined();

    const execution = await createDecisionExecutionReceipt({
      authority,
      currentSubject: subject(),
      executedAt: new Date('2026-09-22T05:00:01.000Z'),
      reference: 'tx:123',
    });

    expect(authority).toMatchObject({
      mechanism: 'ucan',
      reference: 'ucan:abc',
      authorizedAt: '2026-09-22T05:00:00.000Z',
    });
    expect(execution).toEqual({
      receipt: {
        subject: authority.subject,
        actionDigest: authority.subject.subjectDigest,
        executedAt: '2026-09-22T05:00:01.000Z',
        reference: 'tx:123',
      },
      subject: subject(),
    });
  });

  it('returns the subject as hashed, unaffected by later changes to the original', async () => {
    const original = subject();
    const authority = await createDecisionAuthorityReceipt({
      subject: original,
      mechanism: 'ucan',
    });

    const { subject: executable } = await createDecisionExecutionReceipt({
      authority,
      currentSubject: original,
    });
    original.kind = 'refund';
    original.action = { amount: '9999.00', currency: 'USD', payee: 'did:x' };
    original.evidenceRefs = [];

    expect(executable).toEqual(subject());
    expect(executable).not.toBe(original);
    expect(Object.isFrozen(executable)).toBe(true);
    expect(Object.isFrozen(executable.action)).toBe(true);
    expect(Object.isFrozen(executable.evidenceRefs)).toBe(true);
    expect(Object.isFrozen(executable.context)).toBe(true);
    await expect(digestFinalDecisionSubject(executable)).resolves.toEqual(
      authority.subject,
    );
  });

  it('blocks approve(A) → mutate(A→B) → execute(B)', async () => {
    const approved = subject();
    const authority = await createDecisionAuthorityReceipt({
      subject: approved,
      mechanism: 'contract-gate',
    });
    const mutated: FinalDecisionSubject = {
      ...approved,
      action: {
        amount: '1250.00',
        currency: 'USD',
        payee: 'did:ixo:recipient',
      },
    };

    const rejection = createDecisionExecutionReceipt({
      authority,
      currentSubject: mutated,
    });

    await expect(rejection).rejects.toBeInstanceOf(StaleDecisionSubjectError);
    await expect(rejection).rejects.toMatchObject({
      expectedDigest: authority.subject.subjectDigest,
      actualDigest: (await digestFinalDecisionSubject(mutated)).subjectDigest,
    });
  });

  it('treats evidence, policy or context changes as stale too', async () => {
    const approved = subject();
    const authority = await createDecisionAuthorityReceipt({
      subject: approved,
      mechanism: 'human-approval',
    });

    for (const changed of [
      { ...approved, policyRef: 'rubric:pay-v4' },
      {
        ...approved,
        evidenceRefs: [...(approved.evidenceRefs ?? []), 'evidence:new'],
      },
      { ...approved, context: { network: 'testnet' } },
    ]) {
      await expect(
        assertFinalDecisionSubjectUnchanged(authority.subject, changed),
      ).rejects.toBeInstanceOf(StaleDecisionSubjectError);
    }
  });

  it('refuses a binding declared with another algorithm or canonicalization', async () => {
    const binding = await digestFinalDecisionSubject(subject());
    // As read back from a stored receipt written by another implementation.
    const foreign: FinalDecisionSubjectBinding = JSON.parse(
      JSON.stringify({ ...binding, canonicalization: 'jcs' }),
    );

    await expect(
      assertFinalDecisionSubjectUnchanged(foreign, subject()),
    ).rejects.toBeInstanceOf(StaleDecisionSubjectError);
    await expect(
      assertFinalDecisionSubjectUnchanged(
        { ...binding, subjectDigest: binding.subjectDigest.toUpperCase() },
        subject(),
      ),
    ).rejects.toBeInstanceOf(StaleDecisionSubjectError);
  });

  it('digests the execution subject only once before producing the receipt', async () => {
    const approved = subject();
    const authority = await createDecisionAuthorityReceipt({
      subject: approved,
      mechanism: 'ucan',
    });

    let reads = 0;
    const action = {
      currency: 'USD',
      payee: 'did:ixo:recipient',
      get amount() {
        reads += 1;
        return reads === 1 ? '125.00' : '1250.00';
      },
    };

    const execution = await createDecisionExecutionReceipt({
      authority,
      currentSubject: { ...approved, action },
    });

    expect(reads).toBe(1);
    expect(execution.receipt.actionDigest).toBe(
      authority.subject.subjectDigest,
    );
    // The executable subject carries the value that was hashed, not the
    // getter's later answer.
    expect(execution.subject.action).toEqual({
      amount: '125.00',
      currency: 'USD',
      payee: 'did:ixo:recipient',
    });
    expect(reads).toBe(1);
  });

  it('rejects an empty mechanism and invalid timestamps', async () => {
    await expect(
      createDecisionAuthorityReceipt({ subject: subject(), mechanism: ' ' }),
    ).rejects.toThrow(/mechanism must be non-empty/);
    await expect(
      createDecisionAuthorityReceipt({
        subject: subject(),
        mechanism: 'ucan',
        authorizedAt: 'not a date',
      }),
    ).rejects.toThrow(/valid date/);
  });
});

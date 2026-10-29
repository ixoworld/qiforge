import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { CORE_KINDS, claimsPage } from './core';
import { indexKinds, KINDS, kindByName, kindNames } from './registry';
import { contextOf } from './indexed/fixtures/context';
import { defineKind } from './types';

const stub = (name: string) =>
  defineKind({
    name,
    summary: 'A stub.',
    explain: 'A stub.',
    source: 'chain',
    list: false,
    args: z.strictObject({}),
    example: {},
    plan: () => ({
      source: 'chain',
      run: async () => ({ ok: true, data: null }),
    }),
  });

describe('kind registry', () => {
  it('refuses a name registered twice', () => {
    expect(() => indexKinds([stub('a'), stub('b'), stub('a')])).toThrow(
      'ixo-chain: kind "a" is registered twice',
    );
    expect(indexKinds([stub('a'), stub('b')]).get('b')?.name).toBe('b');
  });

  it('lists the core kinds first, in their order, and names every kind once', () => {
    expect(KINDS.slice(0, CORE_KINDS.length).map((kind) => kind.name)).toEqual([
      'claims',
      'claim',
      'claim_collection',
      'claim_collections',
      'entities',
      'entity',
      'did_document',
      'token_balances',
      'transactions',
      'transaction',
    ]);
    expect(kindNames).toEqual(KINDS.map((kind) => kind.name));
    expect(new Set(kindNames).size).toBe(kindNames.length);
    expect(kindByName('claims')).toBe(CORE_KINDS[0]);
    expect(kindByName('balances')).toBeUndefined();
  });

  it('gives every kind a one-line summary, an explanation, a JSON schema and a valid example', () => {
    for (const kind of KINDS) {
      expect(kind.name).toMatch(/^[a-z][a-z0-9_]*$/);
      expect(kind.summary.length).toBeGreaterThan(0);
      expect(kind.summary).not.toContain('\n');
      expect(kind.explain.length).toBeGreaterThan(0);
      expect(z.toJSONSchema(kind.args, { io: 'input' })).toMatchObject({
        type: 'object',
      });
      expect(kind.args.safeParse(kind.example).success).toBe(true);
    }
  });

  it('reads the claims page without a total count, and stays out of the catalogue', () => {
    const counted = CORE_KINDS[0]?.plan({ collectionId: '8250' }, contextOf());
    const page = claimsPage.plan({ collectionId: '8250' }, contextOf());
    if (
      !counted ||
      'invalid' in counted ||
      counted.source !== 'blocksync' ||
      'invalid' in page ||
      page.source !== 'blocksync'
    )
      throw new Error('expected two Blocksync plans');
    expect(counted.field('r0')).toContain(' { totalCount pageInfo { ');
    expect(page.field('r0')).toBe(
      counted
        .field('r0')
        .replace(' { totalCount pageInfo { ', ' { pageInfo { '),
    );
    expect(page.field('r0')).not.toContain('totalCount');
    expect(claimsPage.plan({ agent: 'nope' }, contextOf())).toEqual({
      invalid: 'agent must be an ixo1… address or a did:ixo:ixo1… DID.',
    });
    expect(KINDS).not.toContain(claimsPage);
  });
});

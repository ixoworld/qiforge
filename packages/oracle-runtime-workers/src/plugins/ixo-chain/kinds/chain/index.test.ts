import { describe, expect, it } from 'vitest';
import { chainFetch, contextOf, refusal } from './fixtures/context';
import { CHAIN_KINDS } from './index';

describe('CHAIN_KINDS', () => {
  it('lists the chain REST kinds in catalogue order', () => {
    expect(CHAIN_KINDS.map((kind) => kind.name)).toEqual([
      'fee_grants',
      'authz_grants',
      'smart_account',
      'account',
      'staking',
      'validators',
      'spendable',
      'liquid_staking',
      'network_economics',
      'gov_proposals',
      'claim_intents',
      'collection_membership',
    ]);
  });

  it('are chain kinds whose example is valid, each with a one-line summary and an explanation', () => {
    const ctx = contextOf(chainFetch({}));
    for (const kind of CHAIN_KINDS) {
      expect(kind.source).toBe('chain');
      expect(refusal(kind, kind.example, ctx)).toBeNull();
      expect(kind.summary.length).toBeLessThanOrEqual(100);
      expect(kind.summary).not.toContain('\n');
      expect(kind.explain.length).toBeGreaterThan(kind.summary.length);
    }
  });

  it('mark the kinds that return a list of `first` rows', () => {
    expect(
      CHAIN_KINDS.filter((kind) => kind.list).map((kind) => kind.name),
    ).toEqual([
      'fee_grants',
      'authz_grants',
      'validators',
      'gov_proposals',
      'claim_intents',
    ]);
  });
});

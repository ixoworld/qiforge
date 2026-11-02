import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { contextOf, planOf } from './fixtures/context';
import { INDEXED_KINDS } from './index';

describe('INDEXED_KINDS', () => {
  it('lists the Blocksync kinds in catalogue order', () => {
    expect(INDEXED_KINDS.map((kind) => kind.name)).toEqual([
      'token_history',
      'evaluations',
      'member_budgets',
      'agent_deposits',
      'disputes',
      'daos',
      'dao_proposals',
      'liquid_stake_history',
    ]);
  });

  it.each(INDEXED_KINDS.map((kind) => [kind.name, kind] as const))(
    '%s is a Blocksync list kind whose example plans and whose args describe as JSON schema',
    (_name, kind) => {
      expect(kind.source).toBe('blocksync');
      expect(kind.list).toBe(true);
      expect(kind.summary.length).toBeGreaterThan(20);
      expect(kind.summary.length).toBeLessThanOrEqual(160);
      expect(kind.explain.length).toBeGreaterThan(kind.summary.length);
      expect(() => planOf(kind, kind.example, contextOf())).not.toThrow();
      const schema = z.toJSONSchema(kind.args);
      expect(schema).toMatchObject({
        type: 'object',
        additionalProperties: false,
      });
    },
  );
});

import { describe, expect, it } from 'vitest';
import { baseEnvSchema, validateDomainEnforcement } from './base-env-schema.js';

describe('validateDomainEnforcement', () => {
  it('refuses strict enforcement with nowhere to record decisions', () => {
    const errors = validateDomainEnforcement({ DOMAIN_ENFORCEMENT: 'strict' });
    expect(errors).toHaveLength(1);
    expect(errors[0]?.field).toBe('MATRIX_DECISIONS_ROOM_ID');
    expect(errors[0]?.message).toMatch(/without an audit trail|audit/i);
  });

  // Unset is strict — the default has to fail the same way, or the check
  // would only bite deployments that already opted in explicitly.
  it('treats an unset posture as strict', () => {
    expect(validateDomainEnforcement({})).toHaveLength(1);
  });

  it('accepts strict enforcement with a decisions room', () => {
    expect(
      validateDomainEnforcement({
        DOMAIN_ENFORCEMENT: 'strict',
        MATRIX_DECISIONS_ROOM_ID: '!decisions:ixo.world',
      }),
    ).toEqual([]);
  });

  it('does not accept whitespace as a room', () => {
    expect(
      validateDomainEnforcement({
        DOMAIN_ENFORCEMENT: 'strict',
        MATRIX_DECISIONS_ROOM_ID: '   ',
      }),
    ).toHaveLength(1);
  });

  it('lets a permissive development run omit the room', () => {
    expect(
      validateDomainEnforcement({ DOMAIN_ENFORCEMENT: 'permissive' }),
    ).toEqual([]);
  });
});

/**
 * The constitution is not optional and has no default.
 *
 * A runtime that booted without one would have to either refuse everything or
 * permit everything, and both are worse than refusing to start: the first is
 * an oracle that looks broken, the second is one that looks fine.
 */
describe('DOMAIN_MD_PATH', () => {
  it('is required, and the failure names the variable', () => {
    const result = baseEnvSchema.safeParse({});
    expect(result.success).toBe(false);
    if (result.success) throw new Error('unreachable: failure asserted above');
    const paths = result.error.issues.map((issue) => issue.path.join('.'));
    expect(paths).toContain('DOMAIN_MD_PATH');
  });

  it('accepts a path without checking it exists — that is boot’s job', () => {
    // Deliberately split: the schema says a path was supplied, the loader says
    // whether it holds a constitution. Merging them would mean an unreadable
    // file reported as an env-validation error, which sends the reader to the
    // wrong place.
    const result = baseEnvSchema.shape.DOMAIN_MD_PATH.safeParse(
      './does-not-exist.md',
    );
    expect(result.success).toBe(true);
  });
});

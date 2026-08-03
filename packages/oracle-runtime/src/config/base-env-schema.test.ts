import { describe, expect, it } from 'vitest';
import { validateDomainEnforcement } from './base-env-schema.js';

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

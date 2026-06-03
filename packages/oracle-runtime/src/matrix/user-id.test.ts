import { describe, expect, it } from 'vitest';
import { didToMatrixUserId } from './user-id.js';

describe('didToMatrixUserId', () => {
  it('converts a canonical IXO DID to its Matrix user id', () => {
    expect(didToMatrixUserId('did:ixo:abc', 'devmx.ixo.earth')).toBe(
      '@did-ixo-abc:devmx.ixo.earth',
    );
  });

  it('does NOT double the `did-` prefix (regression guard)', () => {
    // The DID already begins with `did`; a stray literal `@did-` prefix used to
    // produce `@did-did-ixo-...`, which never matches a real Matrix member and
    // silently disabled the editor + broke page invites.
    const result = didToMatrixUserId('did:ixo:user-1', 'home.server');
    expect(result).toBe('@did-ixo-user-1:home.server');
    expect(result).not.toContain('did-did-');
  });

  it('round-trips with the @did-…:host → did:… parse used elsewhere', () => {
    // Mirror of the listener-bridge parse: '@did-ixo-abc:host' → 'did:ixo:abc'.
    const matrixId = didToMatrixUserId('did:ixo:abc', 'host');
    const [localpart] = matrixId.slice(1).split(':');
    const parsed = localpart.replace(/-/g, ':');
    expect(parsed).toBe('did:ixo:abc');
  });
});

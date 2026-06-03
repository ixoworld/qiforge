/**
 * Convert a canonical IXO DID (`did:ixo:abc`) to its Matrix user id
 * (`@did-ixo-abc:homeserver`).
 *
 * Matrix localparts disallow `:`, so the DID's colons become hyphens and the
 * whole thing is prefixed with `@`. The DID already starts with `did`, so the
 * result naturally reads `@did-ixo-…` — do NOT add an extra `did-` prefix.
 * This is the inverse of the `@did-…` → `did:…` parse used by the Matrix
 * listener bridge and `normalizeDid` in the editor's page-functions.
 *
 * @example
 * didToMatrixUserId('did:ixo:abc', 'devmx.ixo.earth')
 * // => '@did-ixo-abc:devmx.ixo.earth'
 */
export function didToMatrixUserId(did: string, homeServer: string): string {
  return `@${did.replace(/:/g, '-')}:${homeServer}`;
}

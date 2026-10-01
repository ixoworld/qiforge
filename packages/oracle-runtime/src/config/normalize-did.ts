/**
 * Convert a hyphen-delimited Matrix username (`@did-ixo-ixo1...:host`) back to
 * a colon DID (`did:ixo:ixo1...`). Matrix localparts cannot contain `:`, so the
 * DID is encoded with `-` and reconstructed here.
 *
 * Throws on any input that is not a `@did-...` username — callers that observe
 * arbitrary senders (e.g. custom timeline-event listeners) should wrap the call
 * and treat a throw as "not a user DID, ignore".
 */
export function normalizeDid(input: string): string {
  const username = input.split(':')[0] ?? '';
  const parts = username.split('-');
  if (parts.length < 3 || parts[0] !== '@did') {
    throw new Error(`Invalid DID format: ${input}`);
  }
  const namespace = parts[1];
  const identifier = parts.slice(2).join('-');
  return `did:${namespace}:${identifier}`;
}

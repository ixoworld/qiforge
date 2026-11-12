import { afterEach, describe, expect, it, vi } from 'vitest';
import { VerifierContext } from './verifier';

/**
 * workerd throws "Illegal invocation" when the global `fetch` is called as a
 * method of another object (`this.fetchImpl(...)`); the kit then reported a
 * resolver as down and credentials_check answered verification_unavailable.
 */
function strictFetch(seen: string[]): typeof fetch {
  return function (this: unknown, input: RequestInfo | URL) {
    if (this !== undefined && this !== globalThis)
      throw new TypeError('Illegal invocation');
    seen.push(String(input));
    return Promise.resolve(new Response('not found', { status: 404 }));
  };
}

describe('VerifierContext fetch', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('calls the global fetch as a plain function when none is given', async () => {
    const seen: string[] = [];
    vi.stubGlobal('fetch', strictFetch(seen));
    const context = new VerifierContext(
      'https://blocksync.test/graphql',
      false,
    );
    await context.resolver('did:web:example.com').catch(() => undefined);
    await context.fetch('https://status.test/list/1');
    expect(seen).toHaveLength(2);
    expect(seen[0]).toMatch(/^https:\/\/example\.com\//);
    expect(seen[1]).toBe('https://status.test/list/1');
  });

  it('calls a host fetch that is the global itself as a plain function', async () => {
    const seen: string[] = [];
    const context = new VerifierContext(
      'https://blocksync.test/graphql',
      false,
      strictFetch(seen),
    );
    await context.resolver('did:web:example.com').catch(() => undefined);
    await context.fetch('https://status.test/list/1');
    expect(seen).toHaveLength(2);
  });
});

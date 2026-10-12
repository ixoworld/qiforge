/**
 * The domain-context transport on workerd's real `fetch`. The unit suite
 * stubs the global, which hides what workerd does with the request options:
 * `redirect: 'error'` is refused with a TypeError before any network call,
 * which turned every anchor resolution into `resolution-failed` on
 * Cloudflare. These tests go through the `LOOPBACK` service binding (this
 * worker bound to itself, see `test/worker.ts`), so the options reach
 * workerd's request validation.
 */
import { env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { createDomainTransport } from '../core/domain-context/transport';
import { makeRuntimeContext } from '../core/test-fixtures';

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace -- augmenting the ambient `Cloudflare.Env` needs namespace syntax
  namespace Cloudflare {
    interface Env {
      LOOPBACK: Fetcher;
    }
  }
}

const STUB = 'https://domain-stub.test';
const did = 'did:ixo:entity:loopback-no-dom';
const loopbackFetch: typeof fetch = (input, init) =>
  env.LOOPBACK.fetch(input, init);

function transportFor(graphqlPath: string) {
  return createDomainTransport(
    { mode: 'observe', allowedOrigins: [STUB] },
    makeRuntimeContext({
      config: { BLOCKSYNC_GRAPHQL_URL: `${STUB}${graphqlPath}` },
    }),
    { fetch: loopbackFetch },
  );
}

describe('domain-context transport on workerd fetch', () => {
  it("workerd refuses redirect: 'error' before any request is made", async () => {
    await expect(
      Promise.resolve().then(() =>
        env.LOOPBACK.fetch(`${STUB}/domain-context-stub/doc.md`, {
          redirect: 'error',
        }),
      ),
    ).rejects.toThrow(/redirect/i);
  });

  it('resolves an IID without a #dom resource to a missing anchor', async () => {
    const transport = transportFor('/domain-context-stub/graphql');
    await expect(transport.resolve(did)).resolves.toBeNull();
  });

  it('refuses a redirected Blocksync answer', async () => {
    const transport = transportFor('/domain-context-stub/graphql-redirect');
    await expect(transport.resolve(did)).rejects.toThrow('iid-unavailable');
  });

  it('reads an allowlisted document', async () => {
    const transport = transportFor('/domain-context-stub/graphql');
    const bytes = await transport.read({
      did,
      uri: `${STUB}/domain-context-stub/doc.md`,
      cid: 'unused',
      private: false,
      maxBytes: 1024,
    });
    expect(new TextDecoder().decode(bytes)).toBe('hello from loopback');
  });

  it('refuses a redirected document instead of following it', async () => {
    const transport = transportFor('/domain-context-stub/graphql');
    await expect(
      transport.read({
        did,
        uri: `${STUB}/domain-context-stub/redirect`,
        cid: 'unused',
        private: false,
        maxBytes: 1024,
      }),
    ).rejects.toThrow('document-redirect-refused');
  });
});

import { describe, expect, it, vi } from 'vitest';
import { makeRuntimeContext } from '../core/test-fixtures';
import { CurrentDelegationMap } from '../do/ixo-tools';
import { readIxoToolsConfig } from './config';
import { createTurnIxoTools, type VerifiedIxoDelegation } from './turn-host';

const context = {
  userDid: 'did:ixo:ixo1owner',
  oracleDid: 'did:ixo:oracle',
  network: 'devnet',
  sessionId: 'session',
  roomId: '!room:test',
  timezone: 'UTC',
  visibility: 'private',
} as const;
const native = {
  can: 'agent-tools/ixo_account_get',
  with: 'ixo:agent-tools',
};
const source = { can: 'subscriptions/read', with: 'ixo:subscriptions' };
const config = readIxoToolsConfig({
  IXO_TOOLS_SUBSCRIPTIONS_ORIGIN: 'https://subscriptions.test',
  IXO_TOOLS_MEMORY_ORIGIN: 'https://memory.test',
  IXO_TOOLS_VFS_ORIGIN: 'https://vfs.test',
  IXO_TOOLS_YELLOWCARD_ORIGIN: 'https://yellowcard.test',
  IXO_TOOLS_UCAN_STORE_ORIGIN: 'https://store.test',
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

describe.each(['response', 'body', 'delivery'] as const)(
  'delegation continuity at %s',
  (phase) => {
    it.each([
      'unchanged',
      'removed',
      'source right removed',
      'native right removed',
      'replaced with equivalent rights',
      'deleted and restored',
    ])('%s', async (change) => {
      const original = {
        raw: 'verified-original',
        capabilities: [native, source],
        expiration: Math.floor(Date.now() / 1000) + 300,
      };
      const delegations = new CurrentDelegationMap<typeof original>();
      delegations.set(context.userDid, original);
      const started = deferred<void>();
      const release = deferred<void>();
      let sourceReturned = false;
      let resultChecks = 0;
      const mint = vi.fn(async () => ({ invocation: 'scoped-invocation' }));
      const read = vi.fn(async (): Promise<VerifiedIxoDelegation | null> => {
        const entry = delegations.get(context.userDid);
        return entry ? { ...entry, revision: delegations.generation } : null;
      });
      const bound = createTurnIxoTools({
        context,
        config,
        currentVerifiedDelegation: read,
        currentAudience: async () => {
          // The host checks once after retrieval and again before delivery.
          if (phase === 'delivery' && sourceReturned && ++resultChecks === 2) {
            started.resolve();
            await release.promise;
          }
          return 'private';
        },
        ucan: {
          ...makeRuntimeContext().ucan,
          hasSigningKey: () => true,
          createInvocationFromDelegation: mint,
        },
        attachments: {
          inventory: async () => ({
            receipts: [],
            complete: true,
            reference: 'inventory',
            revision: 'r1',
            observedAt: new Date().toISOString(),
          }),
          current: async () => false,
        },
        fetch: async (input, init) => {
          const request = new Request(input, init);
          if (new URL(request.url).pathname === '/.well-known/did.json')
            return Response.json({ id: 'did:web:subscriptions.test' });
          expect(request.headers.get('authorization')).toBe(
            'Bearer scoped-invocation',
          );
          const payload = JSON.stringify({
            representation: 1,
            scope: {
              userDid: context.userDid,
              userAddress: 'ixo1owner',
              network: context.network,
            },
            address: 'ixo1owner',
            addressType: 'ixo_account',
            binding: 'verified_root_did',
            observedAt: new Date().toISOString(),
          });
          sourceReturned = true;
          if (phase === 'delivery') return new Response(payload);
          if (phase === 'response') {
            started.resolve();
            await release.promise;
            return new Response(payload);
          }
          return new Response(
            new ReadableStream<Uint8Array>({
              async pull(controller) {
                started.resolve();
                await release.promise;
                controller.enqueue(new TextEncoder().encode(payload));
                controller.close();
              },
            }),
          );
        },
      });

      const pending = bound.tools.invoke('ixo_account_get', {});
      await started.promise;
      expect(mint).toHaveBeenCalledTimes(1);
      if (change === 'removed') delegations.delete(context.userDid);
      else if (change === 'deleted and restored') {
        delegations.delete(context.userDid);
        delegations.set(context.userDid, original);
      } else if (change !== 'unchanged') {
        delegations.set(context.userDid, {
          ...original,
          raw: 'verified-replacement',
          capabilities:
            change === 'source right removed'
              ? [native]
              : change === 'native right removed'
                ? [source]
                : [native, source],
        });
      }
      release.resolve();
      const result = await pending;
      const availableAccount = expect.objectContaining({
        status: 'available',
        value: expect.objectContaining({
          address: 'ixo1owner',
          binding: 'verified_root_did',
        }),
      });
      expect(result).toEqual(
        change === 'unchanged'
          ? availableAccount
          : { status: 'unauthorized', reason: 'grant_missing' },
      );

      // A replacement invalidates this invocation, not future invocations.
      expect(await bound.tools.discover()).toEqual({
        status: 'available',
        tools:
          change === 'removed' || change === 'native right removed'
            ? []
            : ['ixo_account_get'],
      });
      expect((await bound.tools.invoke('ixo_account_get', {})).status).toBe(
        change === 'unchanged' ||
          change === 'replaced with equivalent rights' ||
          change === 'deleted and restored'
          ? 'available'
          : 'unauthorized',
      );
    });
  },
);

import {
  createDelegation,
  generateKeypair,
  serializeDelegation,
  type Signer,
} from '@ixo/ucan';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  CurrentDelegationMap,
  createCurrentIxoDelegationReader,
  isPrivateIxoAudience,
} from '../do/ixo-tools';
import { validateDelegation } from '../shell/auth';
import { catalog } from '@ixo/agent-tools';
import { createTurnIxoTools } from './turn-host';
import { readIxoToolsConfig } from './config';
import { makeRuntimeContext } from '../core/test-fixtures';

const oracle = await generateKeypair();
const user = await generateKeypair();
const auth = {
  oracleDid: oracle.did,
  blocksyncUri: 'https://blocksync.invalid/graphql',
};
const native = {
  can: 'agent-tools/ixo_account_get',
  with: 'ixo:agent-tools',
} satisfies Parameters<typeof createDelegation>[0]['capabilities'][number];
const seconds = () => Math.floor(Date.now() / 1000);
async function signed(
  options: {
    issuer?: Signer;
    audience?: string;
    expiration?: number;
    capabilities?: Parameters<typeof createDelegation>[0]['capabilities'];
    proofs?: Parameters<typeof createDelegation>[0]['proofs'];
  } = {},
) {
  return serializeDelegation(
    await createDelegation({
      issuer: options.issuer ?? user.signer,
      audience: options.audience ?? oracle.did,
      expiration: options.expiration ?? seconds() + 300,
      capabilities: options.capabilities ?? [native],
      proofs: options.proofs,
    }),
  );
}
function reader(raw: string, userDid = user.did) {
  const delegations = new CurrentDelegationMap<{ raw: string }>();
  delegations.set(userDid, { raw });
  return {
    delegations,
    read: createCurrentIxoDelegationReader({ userDid, auth, delegations }),
  };
}
const config = readIxoToolsConfig({
  IXO_TOOLS_SUBSCRIPTIONS_ORIGIN: 'https://subscriptions.test',
  IXO_TOOLS_MEMORY_ORIGIN: 'https://memory.test',
  IXO_TOOLS_VFS_ORIGIN: 'https://vfs.test',
  IXO_TOOLS_YELLOWCARD_ORIGIN: 'https://yellowcard.test',
  IXO_TOOLS_UCAN_STORE_ORIGIN: 'https://store.test',
});
function binding(
  read: ReturnType<typeof reader>['read'],
  currentAudience: () => Promise<'private' | 'shared'> = async () => 'private',
) {
  return createTurnIxoTools({
    context: {
      userDid: user.did,
      oracleDid: oracle.did,
      network: 'devnet',
      sessionId: 'session',
      roomId: '!room:test',
      timezone: 'UTC',
      visibility: 'private',
    },
    config,
    ucan: makeRuntimeContext().ucan,
    currentVerifiedDelegation: read,
    currentAudience,
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
  });
}

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});
describe('current native authority', () => {
  it('verifies a signed current CAR and binds exact native names', async () => {
    const fixture = reader(
      await signed({
        capabilities: catalog.map(({ name }) => ({
          with: 'ixo:agent-tools',
          can: `agent-tools/${name}`,
        })),
      }),
    );
    expect((await fixture.read())?.capabilities).toHaveLength(10);
    expect(await binding(fixture.read).tools.discover()).toEqual({
      status: 'available',
      tools: catalog.map(({ name }) => name),
    });
    fixture.delegations.clear();
    expect(await fixture.read()).toBeNull();
    expect(await binding(fixture.read).tools.discover()).toEqual({
      status: 'available',
      tools: [],
    });
  });
  it('does not treat source rights or wildcard native rights as native consent', async () => {
    for (const capabilities of [
      [{ with: 'ixo:agent-tools', can: '*' }],
      [{ with: 'ixo:agent-tools', can: 'agent-tools/*' }],
      [{ with: 'ixo:subscriptions', can: 'subscriptions/read' }],
    ] satisfies Parameters<typeof createDelegation>[0]['capabilities'][]) {
      expect(
        await binding(
          reader(await signed({ capabilities })).read,
        ).tools.discover(),
      ).toEqual({ status: 'available', tools: [] });
    }
  });
  it('rejects malformed CARs, forged signatures, wrong owner and wrong audience', async () => {
    await expect(reader('not-a-car').read()).rejects.toThrow('verification');
    const attacker = await generateKeypair();
    await expect(
      reader(
        await signed({ issuer: attacker.signer.withDID(user.signer.did()) }),
      ).read(),
    ).rejects.toThrow('verification');
    expect(await reader(await signed(), attacker.did).read()).toBeNull();
    await expect(
      reader(await signed({ audience: attacker.did })).read(),
    ).rejects.toThrow('verification');
  });
  it('scopes warmed verification cache to oracle audience and resolver', async () => {
    const raw = await signed();
    expect((await validateDelegation(raw, auth)).ok).toBe(true);
    expect(
      (
        await validateDelegation(raw, {
          ...auth,
          oracleDid: (await generateKeypair()).did,
        })
      ).ok,
    ).toBe(false);
    expect(
      (
        await validateDelegation(raw, {
          ...auth,
          blocksyncUri: 'https://other.invalid/graphql',
        })
      ).ok,
    ).toBe(true);
  });
  it('does not reuse a did:ixo verdict under another resolver authority', async () => {
    const owner = 'did:ixo:cache-owner';
    const other = await generateKeypair();
    const read = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input instanceof Request ? input.url : input);
      const key = url.includes('trusted') ? user.did : other.did;
      return Response.json({
        data: {
          iids: {
            nodes: [
              {
                id: owner,
                verificationMethod: [
                  {
                    id: `${owner}#key-1`,
                    type: 'Ed25519VerificationKey2018',
                    controller: owner,
                    publicKeyMultibase: key.slice('did:key:'.length),
                  },
                ],
              },
            ],
          },
        },
      });
    });
    vi.stubGlobal('fetch', read);
    const raw = await signed({ issuer: user.signer.withDID(owner) });
    expect(
      (
        await validateDelegation(raw, {
          ...auth,
          blocksyncUri: 'https://trusted-cache.test/graphql',
        })
      ).ok,
    ).toBe(true);
    expect(
      (
        await validateDelegation(raw, {
          ...auth,
          blocksyncUri: 'https://different-cache.test/graphql',
        })
      ).ok,
    ).toBe(false);
    expect(read).toHaveBeenCalledTimes(2);
  });

  it('refuses absent finite expiry, expired authority and unsupported caveats', async () => {
    await expect(
      reader(await signed({ expiration: Infinity })).read(),
    ).rejects.toThrow('verification');
    expect(
      await reader(await signed({ expiration: seconds() - 60 })).read(),
    ).toBeNull();
    expect(
      await reader(
        await signed({ capabilities: [{ ...native, nb: { limit: 1 } }] }),
      ).read(),
    ).toBeNull();
  });
  it('rejects caveats in an embedded proof even when the leaf omits them', async () => {
    const root = await generateKeypair();
    const proof = await createDelegation({
      issuer: root.signer,
      audience: user.did,
      capabilities: [{ ...native, nb: { limit: 1 } }],
      expiration: seconds() + 300,
    });
    expect(await reader(await signed({ proofs: [proof] })).read()).toBeNull();
  });
  it('uses the earliest verified proof expiration', async () => {
    const root = await generateKeypair();
    const expiration = seconds() + 20;
    const proof = await createDelegation({
      issuer: root.signer,
      audience: user.did,
      capabilities: [native],
      expiration,
    });
    expect(
      (await reader(await signed({ proofs: [proof] })).read())?.expiration,
    ).toBe(expiration);
  });
  it('does not revive a deleted and restored entry during verification', async () => {
    const fixture = reader(await signed());
    const entry = fixture.delegations.get(user.did)!;
    const pending = fixture.read();
    fixture.delegations.delete(user.did);
    fixture.delegations.set(user.did, entry);
    expect(await pending).toBeNull();
  });
  it('rechecks map revision and expiry after audience lookup', async () => {
    const fixture = reader(await signed());
    const entry = fixture.delegations.get(user.did)!;
    const surface = binding(fixture.read, async () => {
      fixture.delegations.delete(user.did);
      fixture.delegations.set(user.did, entry);
      return 'private';
    });
    expect(await surface.tools.discover()).toEqual({
      status: 'available',
      tools: [],
    });
    const expiration = seconds() + 5;
    const expiring = reader(await signed({ expiration }));
    const expired = binding(expiring.read, async () => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date((expiration + 1) * 1000));
      return 'private';
    });
    expect(await expired.tools.discover()).toEqual({
      status: 'available',
      tools: [],
    });
  });
  it('does not mint or send an authenticated read after native consent is removed during service discovery', async () => {
    const source = {
      can: 'subscriptions/read',
      with: 'ixo:subscriptions',
    } satisfies Parameters<typeof createDelegation>[0]['capabilities'][number];
    const fixture = reader(await signed({ capabilities: [native, source] }));
    const replacement = await signed({ capabilities: [source] });
    const minted = vi.fn(async () => ({ invocation: 'must-not-mint' }));
    const requests: Request[] = [];
    const bound = createTurnIxoTools({
      context: {
        userDid: user.did,
        oracleDid: oracle.did,
        network: 'devnet',
        sessionId: 'session',
        roomId: '!room:test',
        timezone: 'UTC',
        visibility: 'private',
      },
      config,
      ucan: {
        ...makeRuntimeContext().ucan,
        hasSigningKey: () => true,
        createInvocationFromDelegation: minted,
      },
      currentVerifiedDelegation: fixture.read,
      currentAudience: async () => 'private',
      attachments: {
        inventory: async () => ({
          receipts: [],
          complete: true,
          reference: 'r',
          revision: 'r',
          observedAt: new Date().toISOString(),
        }),
        current: async () => false,
      },
      fetch: async (input, init) => {
        requests.push(new Request(input, init));
        fixture.delegations.set(user.did, { raw: replacement });
        return Response.json({ id: 'did:web:subscriptions.test' });
      },
    });
    expect((await bound.tools.invoke('ixo_account_get', {})).status).toBe(
      'unauthorized',
    );
    expect(minted).not.toHaveBeenCalled();
    expect(requests).toHaveLength(1);
    expect(requests[0]?.headers.has('authorization')).toBe(false);
  });

  it('withholds private tools as soon as the audience changes', async () => {
    const fixture = reader(await signed());
    expect(
      await binding(fixture.read, async () => 'shared').tools.discover(),
    ).toEqual({ status: 'available', tools: [] });
  });
});
describe('positive Matrix audience', () => {
  it('requires exactly the authenticated owner and bot', () => {
    const ids = { ownerMatrixId: '@owner:test', oracleMatrixId: '@bot:test' };
    expect(
      isPrivateIxoAudience({ ...ids, joined: ['@owner:test', '@bot:test'] }),
    ).toBe(true);
    for (const joined of [
      [],
      ['@owner:test'],
      ['@bot:test'],
      ['@owner:test', '@bot:test', '@other:test'],
    ])
      expect(isPrivateIxoAudience({ ...ids, joined })).toBe(false);
    expect(
      isPrivateIxoAudience({
        ...ids,
        ownerMatrixId: undefined,
        joined: ['@owner:test', '@bot:test'],
      }),
    ).toBe(false);
  });
});

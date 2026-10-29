import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  createDelegation,
  createInvocation,
  createLocalDIDResolver,
  generateKeypair,
  serializeInvocation,
  type Capability,
} from '@ixo/ucan';
import {
  authenticateChannel,
  assertActiveChannelBinding,
  assertChannelAttemptAllowed,
  channelAuthConfig,
  ChannelInvoke,
  parseChannelServiceDids,
} from './auth';
import { RunAttemptDeferred } from '../do/run-coordinator';
import {
  ChannelError,
  ChannelOrigin,
  channelRequestHash,
  ChannelTurnBody,
  readChannelBody,
  type ChannelTurnInput,
} from './contract';

const input: ChannelTurnInput = {
  provider: 'whatsapp',
  bindingId: 'chb_person',
  bindingRevision: 3,
  requestId: 'wa:turn1',
  remoteMessageRef: `hmac:${'a'.repeat(64)}`,
  message: 'Hello Qi',
  context: { kind: 'companion' },
};

async function fixture() {
  const user = await generateKeypair();
  const service = await generateKeypair();
  const oracle = await generateKeypair();
  const userDid = 'did:ixo:ixo1user';
  const channelDid = 'did:web:channels.example.test';
  const signer = user.signer.withDID(userDid);
  const caller = service.signer.withDID(channelDid);
  const resolver = createLocalDIDResolver();
  resolver.register(userDid, user.did.slice('did:key:'.length));
  resolver.register(channelDid, service.did.slice('did:key:'.length));
  const capability: Capability = {
    can: 'ixo:channel/invoke',
    with: `ixo:channel:${input.bindingId}`,
    nb: {
      provider: input.provider,
      bindingRevision: input.bindingRevision,
      oracleDid: oracle.did,
    },
  };
  const grant = await createDelegation({
    issuer: signer,
    audience: channelDid,
    capabilities: [capability],
    expiration: Math.floor(Date.now() / 1000) + 300,
  });
  const raw = JSON.stringify(input);
  return {
    raw,
    userDid,
    channelDid,
    caller,
    signer,
    oracle,
    grant,
    capability,
    config: {
      oracleDid: oracle.did,
      channelDids: [channelDid],
      didResolver: resolver,
    },
    resolver,
    service,
    sign: async (
      options: {
        capability?: Capability;
        proofs?: (typeof grant)[];
        expiration?: number;
        requestHash?: string;
        audience?: string;
      } = {},
    ) => {
      const token = await serializeInvocation(
        await createInvocation({
          issuer: caller,
          audience: options.audience ?? oracle.did,
          capability: options.capability ?? capability,
          proofs: options.proofs ?? [grant],
          expiration: options.expiration ?? Math.floor(Date.now() / 1000) + 60,
          facts: [
            {
              requestId: input.requestId,
              requestHash:
                options.requestHash ?? (await channelRequestHash(raw)),
            },
          ],
        }),
      );
      return new Headers({
        authorization: `Bearer ${token}`,
        'x-auth-type': 'ucan',
      });
    },
  };
}

describe('channel UCAN authorization', () => {
  it('recovers the user through the channel service and never forwards tool authority', async () => {
    const f = await fixture();
    const headers = await f.sign();
    const identity = await authenticateChannel(headers, f.raw, input, f.config);
    expect(identity).toEqual({
      userDid: f.userDid,
      channel: {
        callerDid: f.channelDid,
        provider: 'whatsapp',
        bindingId: input.bindingId,
        bindingRevision: 3,
      },
    });
    expect(await authenticateChannel(headers, f.raw, input, f.config)).toEqual(
      identity,
    );
  });

  it('rejects self-issued service invocations without the user grant', async () => {
    const f = await fixture();
    await expect(
      authenticateChannel(await f.sign({ proofs: [] }), f.raw, input, f.config),
    ).rejects.toThrow('Invalid user-rooted');
  });

  it('rejects a changed binding revision even when the service signs it', async () => {
    const f = await fixture();
    const changed = { ...input, bindingRevision: 4 };
    const raw = JSON.stringify(changed);
    const headers = await f.sign({
      capability: {
        ...f.capability,
        nb: {
          provider: input.provider,
          oracleDid: f.oracle.did,
          bindingRevision: 4,
        },
      },
      requestHash: await channelRequestHash(raw),
    });
    await expect(
      authenticateChannel(headers, raw, changed, f.config),
    ).rejects.toThrow('Invalid user-rooted');
  });

  it('rejects changed request text, request ID, binding ID and another oracle', async () => {
    const f = await fixture();
    const headers = await f.sign();
    await expect(
      authenticateChannel(
        headers,
        JSON.stringify({ ...input, message: 'Pay me' }),
        { ...input, message: 'Pay me' },
        f.config,
      ),
    ).rejects.toThrow('request body');
    await expect(
      authenticateChannel(
        headers,
        f.raw,
        { ...input, requestId: 'wa:other' },
        f.config,
      ),
    ).rejects.toThrow('request body');
    await expect(
      authenticateChannel(
        headers,
        f.raw,
        { ...input, bindingId: 'chb_other' },
        f.config,
      ),
    ).rejects.toThrow();
    const other = await generateKeypair();
    await expect(
      authenticateChannel(
        await f.sign({ audience: other.did }),
        f.raw,
        input,
        f.config,
      ),
    ).rejects.toThrow();
  });

  it('rejects expired, excessive lifetime and unapproved service tokens', async () => {
    const f = await fixture();
    await expect(
      authenticateChannel(
        await f.sign({ expiration: Math.floor(Date.now() / 1000) - 1 }),
        f.raw,
        input,
        f.config,
      ),
    ).rejects.toThrow();
    await expect(
      authenticateChannel(
        await f.sign({ expiration: Math.floor(Date.now() / 1000) + 120 }),
        f.raw,
        input,
        f.config,
      ),
    ).rejects.toThrow('60 seconds');
    await expect(
      authenticateChannel(await f.sign(), f.raw, input, {
        ...f.config,
        channelDids: ['did:web:unapproved.example.test'],
      }),
    ).rejects.toThrow();
  });

  it('does not let a root wildcard substitute for the explicit channel grant', async () => {
    const f = await fixture();
    const broad = await createDelegation({
      issuer: f.signer,
      audience: f.channelDid,
      capabilities: [{ can: '*', with: 'ixo:*' }],
      expiration: Math.floor(Date.now() / 1000) + 300,
    });
    await expect(
      authenticateChannel(
        await f.sign({ proofs: [broad] }),
        f.raw,
        input,
        f.config,
      ),
    ).rejects.toThrow();
    expect(ChannelInvoke.can).toBe('ixo:channel/invoke');
  });

  it('accepts any listed channel service as the proof audience and invoker', async () => {
    const f = await fixture();
    // A second channel service (another messaging provider) in the list.
    const secondDid = 'did:web:channels-two.example.test';
    const second = await generateKeypair();
    f.resolver.register(secondDid, second.did.slice('did:key:'.length));
    const config = {
      ...f.config,
      channelDids: [f.channelDid, secondDid],
    };
    const secondGrant = await createDelegation({
      issuer: f.signer,
      audience: secondDid,
      capabilities: [f.capability],
      expiration: Math.floor(Date.now() / 1000) + 300,
    });
    const invoke = async (proof: typeof secondGrant) =>
      new Headers({
        authorization: `Bearer ${await serializeInvocation(
          await createInvocation({
            issuer: second.signer.withDID(secondDid),
            audience: f.oracle.did,
            capability: f.capability,
            proofs: [proof],
            expiration: Math.floor(Date.now() / 1000) + 60,
            facts: [
              {
                requestId: input.requestId,
                requestHash: await channelRequestHash(f.raw),
              },
            ],
          }),
        )}`,
        'x-auth-type': 'ucan',
      });

    // The second service, with a grant addressed to it.
    expect(
      (
        await authenticateChannel(
          await invoke(secondGrant),
          f.raw,
          input,
          config,
        )
      ).channel?.callerDid,
    ).toBe(secondDid);
    // The first service still works under the same list.
    expect(
      (await authenticateChannel(await f.sign(), f.raw, input, config)).channel
        ?.callerDid,
    ).toBe(f.channelDid);
    // A grant addressed to the first service cannot be used by the second.
    await expect(
      authenticateChannel(await invoke(f.grant), f.raw, input, config),
    ).rejects.toThrow();
    // A service that is not listed stays refused.
    await expect(
      authenticateChannel(await invoke(secondGrant), f.raw, input, {
        ...config,
        channelDids: [f.channelDid],
      }),
    ).rejects.toThrow();
  });

  it('refuses a grant addressed to another listed service even when both resolve to the same key', async () => {
    const f = await fixture();
    // A second listed DID that publishes the first service's key (a
    // rotation overlap or a shared key). `@ixo/ucan` tolerates a proof
    // audience that resolves to the invoker's key, so the chain must not
    // be accepted on key equivalence: the grant's audience has to be the
    // exact DID that invokes (`authenticateChannel` checks this itself as
    // well, in case the validator ever relaxes).
    const twinDid = 'did:web:channels-twin.example.test';
    f.resolver.register(twinDid, f.service.did.slice('did:key:'.length));
    const config = { ...f.config, channelDids: [f.channelDid, twinDid] };
    const headers = new Headers({
      authorization: `Bearer ${await serializeInvocation(
        await createInvocation({
          issuer: f.service.signer.withDID(twinDid),
          audience: f.oracle.did,
          capability: f.capability,
          proofs: [f.grant],
          expiration: Math.floor(Date.now() / 1000) + 60,
          facts: [
            {
              requestId: input.requestId,
              requestHash: await channelRequestHash(f.raw),
            },
          ],
        }),
      )}`,
      'x-auth-type': 'ucan',
    });
    await expect(
      authenticateChannel(headers, f.raw, input, config),
    ).rejects.toMatchObject({ status: 401, code: 'unauthorized' });
  });
});

describe('channel service DID list', () => {
  it('trims, drops empty entries and removes duplicates, keeping order', () => {
    expect(parseChannelServiceDids(undefined)).toEqual([]);
    expect(parseChannelServiceDids('')).toEqual([]);
    expect(parseChannelServiceDids(' , ,')).toEqual([]);
    expect(parseChannelServiceDids('did:web:a.test')).toEqual([
      'did:web:a.test',
    ]);
    expect(
      parseChannelServiceDids(
        ' did:web:a.test, did:web:b.test ,,did:web:a.test',
      ),
    ).toEqual(['did:web:a.test', 'did:web:b.test']);
  });

  it('exposes every listed DID and allowlists each of them', async () => {
    const env = {
      ORACLE_DID: 'did:ixo:ixo1oracle',
      BLOCKSYNC_GRAPHQL_URL: 'https://blocksync-list.invalid/graphql',
      CHANNEL_SERVICE_DID: 'did:web:one.example.test, did:web:two.example.test',
    };
    const config = channelAuthConfig(env);
    expect(config.channelDids).toEqual([
      'did:web:one.example.test',
      'did:web:two.example.test',
    ]);
    // Unlisted identities are refused without any lookup.
    expect(await config.didResolver('did:web:three.example.test')).toEqual({
      error: expect.objectContaining({
        message: 'Unapproved channel identity',
      }),
    });
  });

  it('answers 503 not_configured when the list is empty', () => {
    for (const CHANNEL_SERVICE_DID of [undefined, '', ' , ']) {
      const env = {
        ORACLE_DID: 'did:ixo:ixo1oracle',
        BLOCKSYNC_GRAPHQL_URL: 'https://blocksync-list.invalid/graphql',
        CHANNEL_SERVICE_DID,
      };
      let thrown: unknown;
      try {
        channelAuthConfig(env);
      } catch (error) {
        thrown = error;
      }
      expect(thrown).toBeInstanceOf(ChannelError);
      expect(thrown).toMatchObject({ status: 503, code: 'not_configured' });
    }
  });
});

describe('channel request boundary', () => {
  it('accepts only oracle text with no injected identity or topic authority', () => {
    expect(ChannelTurnBody.safeParse(input).success).toBe(true);
    expect(
      ChannelTurnBody.safeParse({ ...input, userDid: 'did:ixo:attacker' })
        .success,
    ).toBe(false);
    expect(
      ChannelTurnBody.safeParse({
        ...input,
        context: { kind: 'topic', topicId: 'other' },
      }).success,
    ).toBe(false);
  });

  it('accepts files the gateway serves and refuses malformed ones', () => {
    const photo = {
      url: 'https://channels.example/media/chb_one/1f0e?exp=1893456000&sig=abc_-',
      filename: 'photo.jpg',
      mimetype: 'image/jpeg',
      size: 120_000,
      sha256: 'a'.repeat(64),
      kind: 'image',
    };
    expect(
      ChannelTurnBody.safeParse({ ...input, attachments: [photo] }).success,
    ).toBe(true);
    for (const attachments of [
      [],
      [{ ...photo, url: 'http://channels.example/media/x' }],
      [{ ...photo, url: 'not a url' }],
      [{ ...photo, sha256: 'A'.repeat(64) }],
      [{ ...photo, sha256: 'a'.repeat(63) }],
      [{ ...photo, size: -1 }],
      [{ ...photo, size: 1.5 }],
      [{ ...photo, kind: 'sticker' }],
      [{ ...photo, filename: '' }],
      [{ ...photo, bytes: 'inline' }],
      Array.from({ length: 11 }, () => photo),
    ])
      expect(ChannelTurnBody.safeParse({ ...input, attachments }).success).toBe(
        false,
      );
  });

  it('accepts both oracle context kinds and refuses any other', () => {
    for (const kind of ['oracle', 'companion'])
      expect(
        ChannelTurnBody.safeParse({ ...input, context: { kind } }).success,
      ).toBe(true);
    for (const context of [
      { kind: 'agent' },
      { kind: 'oracle', extra: true },
      {},
    ])
      expect(ChannelTurnBody.safeParse({ ...input, context }).success).toBe(
        false,
      );
  });

  it('accepts any well-formed provider id and refuses a malformed one', () => {
    for (const provider of [
      'whatsapp',
      'telegram',
      'sms-2',
      'a_b',
      'a'.repeat(32),
    ]) {
      expect(ChannelTurnBody.safeParse({ ...input, provider }).success).toBe(
        true,
      );
      expect(
        ChannelOrigin.safeParse({
          v: 1,
          transport: provider,
          binding_id: input.bindingId,
          remote_ref: input.remoteMessageRef,
        }).success,
      ).toBe(true);
    }
    for (const provider of [
      '',
      'WhatsApp',
      '1sms',
      '-x',
      'a b',
      'a'.repeat(33),
    ])
      expect(ChannelTurnBody.safeParse({ ...input, provider }).success).toBe(
        false,
      );
  });

  it('rejects an oversized stream before buffering it', async () => {
    const request = new Request('https://channels.test', {
      method: 'POST',
      body: 'a'.repeat(64_001),
    });
    await expect(readChannelBody(request)).rejects.toThrow('too large');
  });
});

describe('active channel binding', () => {
  const identity = {
    userDid: 'did:ixo:ixo1user',
    channel: {
      callerDid: 'did:web:channels.test',
      provider: 'whatsapp' as const,
      bindingId: 'chb_person',
      bindingRevision: 3,
    },
  };
  const config = {
    ORACLE_DID: 'did:ixo:oracle',
    AUTH_HUB_URL: 'https://auth.test',
    AUTH_HUB_CHANNEL_SERVICE_KEY: 'test-dedicated-key',
  };

  it('checks the current revision again on every call and refuses revocation', async () => {
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce(Response.json({ active: true }))
      .mockResolvedValueOnce(Response.json({ active: false }));
    vi.stubGlobal('fetch', fetcher);
    try {
      await assertActiveChannelBinding(identity, config);
      await expect(
        assertActiveChannelBinding(identity, config),
      ).rejects.toThrow('inactive');
      const request = fetcher.mock.calls[0]?.[0];
      expect(request.url).toBe(
        'https://auth.test/api/internal/channels/validate-binding',
      );
      expect(request.headers.get('x-channels-service-key')).toBe(
        'test-dedicated-key',
      );
      expect(await request.json()).toEqual({
        userDid: identity.userDid,
        bindingId: 'chb_person',
        bindingRevision: 3,
        provider: 'whatsapp',
        oracleDid: config.ORACLE_DID,
      });
      expect(fetcher).toHaveBeenCalledTimes(2);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('fails closed when Auth Hub is unavailable', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('offline')));
    try {
      await expect(
        assertActiveChannelBinding(identity, config),
      ).rejects.toMatchObject({
        status: 503,
        code: 'binding_check_unavailable',
        message: 'Channel binding validation is unavailable',
      });
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('defers an attempt while Auth Hub is unavailable and ends it once the binding is revoked', async () => {
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValueOnce(new Response('busy', { status: 503 }))
        .mockRejectedValueOnce(new Error('offline'))
        .mockResolvedValueOnce(Response.json({ active: false }))
        .mockResolvedValueOnce(Response.json({ active: true })),
    );
    try {
      // A 503 response, then a network failure.
      for (let transient = 0; transient < 2; transient += 1)
        await expect(
          assertChannelAttemptAllowed(identity, config),
        ).rejects.toBeInstanceOf(RunAttemptDeferred);
      const revoked = await assertChannelAttemptAllowed(identity, config).catch(
        (error: unknown) => error,
      );
      expect(revoked).toBeInstanceOf(ChannelError);
      expect(revoked).not.toBeInstanceOf(RunAttemptDeferred);
      expect(revoked).toMatchObject({ status: 403, code: 'binding_inactive' });
      await expect(
        assertChannelAttemptAllowed(identity, config),
      ).resolves.toBeUndefined();
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

describe('channel service identity resolution', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('fetches a did:web channel service document once across requests and caches no failure', async () => {
    const service = await generateKeypair();
    // A DID no other test resolves: the resolver is shared per isolate.
    const channelDid = 'did:web:channels-cache.example.test';
    const requests: string[] = [];
    let available = false;
    vi.stubGlobal('fetch', async (input: RequestInfo | URL) => {
      requests.push(String(input instanceof Request ? input.url : input));
      if (!available) return new Response('unavailable', { status: 503 });
      return Response.json({
        verificationMethod: [
          {
            id: `${channelDid}#key-1`,
            type: 'Ed25519VerificationKey2020',
            publicKeyMultibase: service.did.slice('did:key:'.length),
          },
        ],
      });
    });
    const env = {
      ORACLE_DID: 'did:ixo:ixo1oracle',
      BLOCKSYNC_GRAPHQL_URL: 'https://blocksync-channels.invalid/graphql',
      CHANNEL_SERVICE_DID: channelDid,
    };

    expect(
      'error' in (await channelAuthConfig(env).didResolver(channelDid)),
    ).toBe(true);
    available = true;
    for (let i = 0; i < 3; i++) {
      expect(await channelAuthConfig(env).didResolver(channelDid)).toEqual({
        ok: [service.did],
      });
    }
    expect(requests).toEqual([
      'https://channels-cache.example.test/.well-known/did.json',
      'https://channels-cache.example.test/.well-known/did.json',
    ]);
  });
});

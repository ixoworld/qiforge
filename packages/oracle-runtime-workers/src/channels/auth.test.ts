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
import {
  CHANNEL_KEY_FRESH_MS,
  CHANNEL_KEY_STALE_MAX_MS,
  clearChannelKeyCache,
  shortDid,
} from './key-lookup';
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
      // Above the gateway's own 50 MiB bound.
      [{ ...photo, size: 52_428_801 }],
      [{ ...photo, kind: 'sticker' }],
      [{ ...photo, bytes: 'inline' }],
      Array.from({ length: 11 }, () => photo),
    ])
      expect(ChannelTurnBody.safeParse({ ...input, attachments }).success).toBe(
        false,
      );
  });

  it('never refuses a turn for a filename: a long one is cut to 200 code points, an empty one named by its kind', () => {
    const photo = {
      url: 'https://channels.example/media/chb_one/1f0e?exp=1893456000&sig=abc_-',
      filename: 'photo.jpg',
      mimetype: 'image/jpeg',
      size: 120_000,
      sha256: 'a'.repeat(64),
      kind: 'image',
    };
    const parse = (filename: string, kind = 'image') => {
      const parsed = ChannelTurnBody.safeParse({
        ...input,
        attachments: [{ ...photo, filename, kind }],
      });
      if (!parsed.success) throw new Error('refused');
      return parsed.data.attachments?.[0]?.filename;
    };
    // 150 emoji are 300 UTF-16 units: kept whole.
    const emoji = `${'\u{1f4f7}'.repeat(150)}.pdf`;
    expect(parse(emoji, 'document')).toBe(emoji);
    const long = '\u{1f4f7}'.repeat(250);
    expect(parse(long)).toBe('\u{1f4f7}'.repeat(200));
    expect(parse('x'.repeat(5000), 'document')).toBe('x'.repeat(200));
    expect(parse('')).toBe('photo');
    expect(parse('', 'document')).toBe('document');
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
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
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
    // The first, cold lookup is asked twice (a 503 can be transient), the
    // failure is not kept, and the next success is reused.
    expect(requests).toEqual([
      'https://channels-cache.example.test/.well-known/did.json',
      'https://channels-cache.example.test/.well-known/did.json',
      'https://channels-cache.example.test/.well-known/did.json',
    ]);
  });
});

describe('channel key lookups', () => {
  type Step = 'ok' | 'hang' | 'down' | 'missing';
  let fixtureCount = 0;

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    clearChannelKeyCache();
  });

  /**
   * A deployment whose three DIDs resolve over a stubbed network: the
   * oracle's and the person's did:ixo through Blocksync, the gateway's
   * did:web from its host. `plan` queues what the next lookups of a DID
   * meet (default `ok`); `published` is the key each DID document lists.
   */
  async function networkFixture() {
    const tag = `${Date.now().toString(36)}${fixtureCount++}`;
    const user = await generateKeypair();
    const service = await generateKeypair();
    const oracle = await generateKeypair();
    const userDid: `did:ixo:${string}` = `did:ixo:ixo1user${tag}`;
    const oracleDid: `did:ixo:${string}` = `did:ixo:ixo1oracle${tag}`;
    const channelDid: `did:web:${string}` = `did:web:channels-${tag}.example.test`;
    const env = {
      ORACLE_DID: oracleDid,
      BLOCKSYNC_GRAPHQL_URL: `https://blocksync-${tag}.invalid/graphql`,
      CHANNEL_SERVICE_DID: channelDid,
    };
    const published = new Map<string, string>([
      [userDid, user.did],
      [oracleDid, oracle.did],
      [channelDid, service.did],
    ]);
    const plan = new Map<string, Step[]>();
    const lookups: string[] = [];
    vi.stubGlobal(
      'fetch',
      async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input instanceof Request ? input.url : input);
        const did =
          url === env.BLOCKSYNC_GRAPHQL_URL
            ? (JSON.parse(String(init?.body)) as { variables: { id: string } })
                .variables.id
            : channelDid;
        lookups.push(did);
        const step = plan.get(did)?.shift() ?? 'ok';
        if (step === 'hang')
          return new Promise<Response>((_resolve, reject) =>
            init?.signal?.addEventListener('abort', () =>
              reject(init.signal?.reason),
            ),
          );
        if (step === 'down')
          return new Response('unavailable', { status: 503 });
        const method = {
          id: `${did}#key-1`,
          type: 'Ed25519VerificationKey2020',
          controller: did,
          publicKeyMultibase: published.get(did)!.slice('did:key:'.length),
        };
        if (did === channelDid)
          return Response.json({ verificationMethod: [method] });
        return Response.json({
          data: {
            iids: {
              nodes:
                step === 'missing'
                  ? []
                  : [{ id: did, verificationMethod: [method] }],
            },
          },
        });
      },
    );
    const warnings: string[] = [];
    vi.spyOn(console, 'warn').mockImplementation((line: unknown) => {
      warnings.push(String(line));
    });
    const capability: Capability = {
      can: 'ixo:channel/invoke',
      with: `ixo:channel:${input.bindingId}`,
      nb: {
        provider: input.provider,
        bindingRevision: input.bindingRevision,
        oracleDid,
      },
    };
    const raw = JSON.stringify(input);
    const turn = async (userKey = user) => {
      const grant = await createDelegation({
        issuer: userKey.signer.withDID(userDid),
        audience: channelDid,
        capabilities: [capability],
        expiration: Math.floor(Date.now() / 1000) + 300,
      });
      const token = await serializeInvocation(
        await createInvocation({
          issuer: service.signer.withDID(channelDid),
          audience: oracleDid,
          capability,
          proofs: [grant],
          expiration: Math.floor(Date.now() / 1000) + 60,
          facts: [
            {
              requestId: input.requestId,
              requestHash: await channelRequestHash(raw),
            },
          ],
        }),
      );
      return authenticateChannel(
        new Headers({
          authorization: `Bearer ${token}`,
          'x-auth-type': 'ucan',
        }),
        raw,
        input,
        channelAuthConfig(env),
      );
    };
    const lookupLines = () =>
      warnings
        .filter((line) => line.startsWith('[channels] key lookup failed '))
        .map(
          (line) =>
            JSON.parse(
              line.slice('[channels] key lookup failed '.length),
            ) as Record<string, unknown>,
        );
    const refusalLines = () =>
      warnings.filter((line) =>
        line.startsWith('[channels] invocation refused '),
      );
    return {
      userDid,
      oracleDid,
      channelDid,
      published,
      plan,
      lookups,
      turn,
      lookupLines,
      refusalLines,
    };
  }

  /** Moves the clock (Date only; timeouts stay real). */
  function advance(ms: number) {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(Date.now() + ms);
  }

  it('retries a cold oracle lookup that timed out once and accepts the turn', async () => {
    const f = await networkFixture();
    f.plan.set(f.oracleDid, ['hang']);
    await expect(f.turn()).resolves.toMatchObject({ userDid: f.userDid });
    expect(f.lookups.filter((did) => did === f.oracleDid)).toHaveLength(2);
    expect(f.lookupLines()).toEqual([
      expect.objectContaining({
        role: 'oracle',
        did: shortDid(f.oracleDid),
        source: 'blocksync',
        failure: 'timeout',
        attempts: 2,
        recoveredOnRetry: true,
        staleKeysUsed: false,
        turnRefused: false,
      }),
    ]);
    expect(f.refusalLines()).toEqual([]);
  }, 20_000);

  it('uses the last good keys within the bound when a refresh fails, and refreshes the oracle in the background', async () => {
    const f = await networkFixture();
    await f.turn();
    advance(2 * 60_000);
    f.plan.set(f.userDid, ['down']);
    f.plan.set(f.oracleDid, ['hang']);
    await expect(f.turn()).resolves.toMatchObject({ userDid: f.userDid });
    // Kept keys stand in: no retry. The oracle's refresh still hangs in
    // the background (nothing logged for it yet): the turn did not wait.
    expect(f.lookups.filter((did) => did === f.userDid)).toHaveLength(2);
    expect(f.lookupLines()).toEqual([
      expect.objectContaining({
        role: 'person',
        did: shortDid(f.userDid),
        failure: 'http_503',
        attempts: 1,
        staleKeysUsed: true,
        turnRefused: false,
      }),
    ]);
    const staleAgeMs = Number(f.lookupLines()[0]?.['staleAgeMs']);
    expect(staleAgeMs).toBeGreaterThanOrEqual(2 * 60_000);
    expect(staleAgeMs).toBeLessThan(CHANNEL_KEY_STALE_MAX_MS);
    await vi.waitFor(
      () =>
        expect(f.lookupLines()).toContainEqual(
          expect.objectContaining({
            role: 'oracle',
            failure: 'timeout',
            staleKeysUsed: true,
            turnRefused: false,
          }),
        ),
      { timeout: 6_000, interval: 100 },
    );
  }, 20_000);

  it('refuses with 401 once the last good keys are past the bound', async () => {
    const f = await networkFixture();
    await f.turn();
    advance(CHANNEL_KEY_STALE_MAX_MS + 1_000);
    f.plan.set(f.userDid, ['down', 'down']);
    await expect(f.turn()).rejects.toMatchObject({
      status: 401,
      code: 'unauthorized',
    });
    expect(f.lookupLines()).toEqual([
      expect.objectContaining({
        role: 'person',
        failure: 'http_503',
        attempts: 2,
        staleKeysUsed: false,
        turnRefused: true,
      }),
    ]);
    // A lookup refusal is not reported as a bad signature.
    expect(f.refusalLines()).toEqual([]);
  });

  it('refuses a DID that never resolved in this isolate', async () => {
    const f = await networkFixture();
    f.plan.set(f.userDid, ['down', 'down']);
    await expect(f.turn()).rejects.toMatchObject({ status: 401 });
    expect(f.lookupLines()).toEqual([
      expect.objectContaining({
        role: 'person',
        failure: 'http_503',
        attempts: 2,
        staleKeysUsed: false,
        turnRefused: true,
      }),
    ]);
    // A definitive answer is not asked again.
    f.plan.set(f.userDid, ['missing']);
    const before = f.lookups.length;
    await expect(f.turn()).rejects.toMatchObject({ status: 401 });
    expect(f.lookups.slice(before)).toEqual([f.userDid]);
    expect(f.lookupLines().at(-1)).toMatchObject({
      role: 'person',
      failure: 'not_found',
      attempts: 1,
      turnRefused: true,
    });
  });

  it('logs a forged signature as a verification failure, not a lookup failure', async () => {
    const f = await networkFixture();
    // The person's grant is signed with a key their DID document does not
    // list; every lookup answers.
    const forger = await generateKeypair();
    await expect(f.turn(forger)).rejects.toMatchObject({
      status: 401,
      code: 'unauthorized',
      message: 'Invalid user-rooted channel invocation',
    });
    expect(f.lookupLines()).toEqual([]);
    expect(f.refusalLines()).toEqual([
      `[channels] invocation refused ${JSON.stringify({
        reason: 'verification_failed',
        code: 'UNAUTHORIZED',
      })}`,
    ]);
  });

  it('shares one lookup per DID between concurrent turns on a cold isolate', async () => {
    const f = await networkFixture();
    const identities = await Promise.all(
      Array.from({ length: 5 }, () => f.turn()),
    );
    expect(identities.map((identity) => identity.userDid)).toEqual(
      Array(5).fill(f.userDid),
    );
    expect(f.lookups.filter((did) => did === f.oracleDid)).toHaveLength(1);
    expect(f.lookups.filter((did) => did === f.channelDid)).toHaveLength(1);
    expect(f.lookups.filter((did) => did === f.userDid)).toHaveLength(1);
  });

  it('picks up a rotated key at the next successful refresh', async () => {
    const f = await networkFixture();
    await f.turn();
    const rotated = await generateKeypair();
    f.published.set(f.userDid, rotated.did);
    // Inside the fresh window the kept (old) key is still used, as before.
    await expect(f.turn(rotated)).rejects.toMatchObject({ status: 401 });
    advance(CHANNEL_KEY_FRESH_MS + 1_000);
    await expect(f.turn(rotated)).resolves.toMatchObject({
      userDid: f.userDid,
    });
    await expect(f.turn()).rejects.toMatchObject({ status: 401 });
    expect(f.lookupLines()).toEqual([]);
  });
});

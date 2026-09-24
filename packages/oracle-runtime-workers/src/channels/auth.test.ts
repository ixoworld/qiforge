import { describe, expect, it, vi } from 'vitest';
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
  ChannelInvoke,
} from './auth';
import {
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
    config: { oracleDid: oracle.did, channelDid, didResolver: resolver },
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
        channelDid: 'did:web:unapproved.example.test',
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
});

describe('channel request boundary', () => {
  it('accepts only Companion text with no injected identity or topic authority', () => {
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
      ).rejects.toThrow('unavailable');
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

import { afterEach, describe, expect, it } from 'vitest';
import { signOutcomeRequest } from '@ixo/action-protocol';
import {
  HUB_DID_REFRESH_MIN_MS,
  resetHubDidCache,
  verifyHubOutcomeCallback,
} from './outcome-signature';

/**
 * The Hub DID read behind signed outcome callbacks: what a stream of forged
 * or junk callbacks can cost the Hub, and that a real one still verifies.
 */
const HUB_URL = 'https://hub.test';
const HUB_DID = 'did:web:hub.test';
const KEY_ID = `${HUB_DID}#key-0`;
const AUDIENCE = 'https://oracle.test';
const RAW_BODY = '{"eventId":"event-one"}';
const T0 = 1_800_000_000_000;

const BASE58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
function multibase(raw: Uint8Array): string {
  let value = 0n;
  for (const byte of [0xed, 0x01, ...raw]) value = value * 256n + BigInt(byte);
  let text = '';
  while (value > 0n) {
    text = BASE58[Number(value % 58n)] + text;
    value /= 58n;
  }
  return `z${text}`;
}

async function hubKey() {
  const pair = await crypto.subtle.generateKey({ name: 'Ed25519' }, true, [
    'sign',
    'verify',
  ]);
  if (!('privateKey' in pair)) throw new Error('Ed25519 key pair expected');
  const exported = await crypto.subtle.exportKey('raw', pair.publicKey);
  if (!(exported instanceof ArrayBuffer)) throw new Error('raw key expected');
  return {
    privateKey: pair.privateKey,
    document: (did = HUB_DID) => ({
      id: did,
      verificationMethod: [
        {
          id: `${did}#key-0`,
          type: 'Multikey',
          controller: did,
          publicKeyMultibase: multibase(new Uint8Array(exported)),
        },
      ],
    }),
  };
}

function hub(respond: () => Response | Promise<Response>) {
  const state = { calls: 0 };
  return {
    state,
    fetcher: {
      fetch: async () => {
        state.calls++;
        return respond();
      },
    },
  };
}

const signed = async (
  privateKey: CryptoKey,
  nowMs: number,
  timestamp = Math.floor(nowMs / 1000),
) =>
  new Headers(
    await signOutcomeRequest({
      privateKey,
      keyId: KEY_ID,
      audience: AUDIENCE,
      rawBody: RAW_BODY,
      timestamp,
    }),
  );

const verify = (
  headers: Headers,
  fetcher: { fetch(request: Request): Promise<Response> },
  now: number,
) =>
  verifyHubOutcomeCallback({
    hubUrl: HUB_URL,
    rawBody: RAW_BODY,
    headers,
    audience: AUDIENCE,
    fetcher,
    now,
  });

afterEach(() => resetHubDidCache());

describe('Hub outcome callback verification', () => {
  it('reads nothing for junk headers: missing, stale, future, or a short signature', async () => {
    const key = await hubKey();
    const { state, fetcher } = hub(() => Response.json(key.document()));
    const seconds = Math.floor(T0 / 1000);
    const good = await signed(key.privateKey, T0);
    const variants: Headers[] = [
      new Headers(),
      new Headers({
        'x-auth-hub-key-id': KEY_ID,
        'x-auth-hub-timestamp': '1',
        'x-auth-hub-signature': 'AA',
      }),
      // Another key id.
      new Headers({
        ...Object.fromEntries(good),
        'x-auth-hub-key-id': 'did:web:evil.test#key-0',
      }),
      // A signature that does not decode to 64 bytes.
      new Headers({
        ...Object.fromEntries(good),
        'x-auth-hub-signature': 'A'.repeat(85),
      }),
      // 301 s in the past and 301 s in the future.
      await signed(key.privateKey, T0, seconds - 301),
      await signed(key.privateKey, T0, seconds + 301),
    ];
    for (const headers of variants)
      expect(await verify(headers, fetcher, T0)).toBe(false);
    expect(state.calls).toBe(0);
    // The ±300 s edges still verify.
    expect(
      await verify(
        await signed(key.privateKey, T0, seconds + 300),
        fetcher,
        T0,
      ),
    ).toBe(true);
    expect(
      await verify(
        await signed(key.privateKey, T0, seconds - 300),
        fetcher,
        T0,
      ),
    ).toBe(true);
    expect(state.calls).toBe(1);
  });

  it.each([
    ['a Hub 503', () => new Response('down', { status: 503 })],
    [
      'a network error',
      () => {
        throw new TypeError('Network connection lost');
      },
    ],
    [
      'a document for another DID',
      () => Response.json({ id: 'did:web:evil.test', verificationMethod: [] }),
    ],
  ] as const)(
    'reads the DID document at most once a minute under %s',
    async (_label, respond) => {
      const forger = await hubKey();
      const { state, fetcher } = hub(respond);
      for (let i = 0; i < 10; i++)
        expect(
          await verify(
            await signed(forger.privateKey, T0 + i * 1000),
            fetcher,
            T0 + i * 1000,
          ),
        ).toBe(false);
      expect(state.calls).toBe(1);
      const later = T0 + HUB_DID_REFRESH_MIN_MS;
      for (let i = 0; i < 10; i++)
        expect(
          await verify(await signed(forger.privateKey, later), fetcher, later),
        ).toBe(false);
      expect(state.calls).toBe(2);
    },
  );

  it('caches only a document that passes the id and key checks', async () => {
    const key = await hubKey();
    let document: unknown = key.document('did:web:evil.test');
    const { state, fetcher } = hub(() => Response.json(document));
    expect(await verify(await signed(key.privateKey, T0), fetcher, T0)).toBe(
      false,
    );
    document = key.document();
    // The wrong-DID read is not cached as a key, and the next read waits.
    expect(await verify(await signed(key.privateKey, T0), fetcher, T0)).toBe(
      false,
    );
    const later = T0 + HUB_DID_REFRESH_MIN_MS;
    expect(
      await verify(await signed(key.privateKey, later), fetcher, later),
    ).toBe(true);
    expect(
      await verify(await signed(key.privateKey, later + 1), fetcher, later + 1),
    ).toBe(true);
    expect(state.calls).toBe(2);
  });

  it('shares one read between concurrent callbacks', async () => {
    const key = await hubKey();
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const { state, fetcher } = hub(async () => {
      await gate;
      return Response.json(key.document());
    });
    const headers = await signed(key.privateKey, T0);
    const pending = Array.from({ length: 5 }, () =>
      verify(headers, fetcher, T0),
    );
    release();
    expect(await Promise.all(pending)).toEqual([true, true, true, true, true]);
    expect(state.calls).toBe(1);
  });

  it('a forged signature against a cached key reads nothing within the minute', async () => {
    const key = await hubKey();
    const forger = await hubKey();
    const { state, fetcher } = hub(() => Response.json(key.document()));
    expect(await verify(await signed(key.privateKey, T0), fetcher, T0)).toBe(
      true,
    );
    for (let i = 1; i <= 10; i++)
      expect(
        await verify(await signed(forger.privateKey, T0 + i), fetcher, T0 + i),
      ).toBe(false);
    expect(state.calls).toBe(1);
  });
});

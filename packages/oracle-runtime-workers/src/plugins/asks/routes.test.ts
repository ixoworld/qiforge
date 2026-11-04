import { describe, expect, it } from 'vitest';
import type { AsksConnection, AsksWorkerEnv } from './connection';
import { handleCallback, handleClientDocument, handleStart } from './routes';
import { deriveKeys, objectNameOf } from './oauth';
import {
  accountAnswer,
  connectionWith,
  json,
  OTHER_ADDRESS,
  PERSON_ADDRESS,
  PERSON_DID,
  PUBLIC_URL,
  recordingFetch,
  TOKEN_KEY,
  tokenAnswer,
} from './testing';

const NAME = await objectNameOf(await deriveKeys(TOKEN_KEY), PERSON_DID);

function setup(account = () => accountAnswer()) {
  const net = recordingFetch((call) =>
    call.url.endsWith('/oauth/revoke') ? json({}) : tokenAnswer(1),
  );
  const { connection } = connectionWith(
    net.fetcher,
    { now: 0 },
    undefined,
    account,
  );
  const objects = new Map<string, AsksConnection>([[NAME, connection]]);
  const env: AsksWorkerEnv = {
    NETWORK: 'devnet',
    ORACLE_NAME: 'Personal Agent (Devnet)',
    ORACLE_PUBLIC_URL: PUBLIC_URL,
    ASKS_WHATSAPP_RETURN_URL:
      'https://wa.me/12019082266?text=I%27m%20connected',
    ASKS_CONNECTIONS: {
      idFromName: (name: string) => name,
      get: (id: string) => objects.get(id),
    } as unknown as NonNullable<AsksWorkerEnv['ASKS_CONNECTIONS']>,
  };
  return { env, connection, net };
}

const callback = (query: Record<string, string>) =>
  new Request(
    `${PUBLIC_URL}/asks/oauth/callback?${new URLSearchParams(query).toString()}`,
  );

describe('routes', () => {
  it('serves the Client ID Metadata Document as application/json', async () => {
    const response = await handleClientDocument(setup().env);
    expect(response.headers.get('content-type')).toBe('application/json');
    const text = await response.text();
    expect(text.length).toBeLessThan(5_000);
    expect(JSON.parse(text)).toEqual({
      client_id: `${PUBLIC_URL}/asks/oauth/client.json`,
      client_name: 'Personal Agent (Devnet)',
      redirect_uris: [`${PUBLIC_URL}/asks/oauth/callback`],
      token_endpoint_auth_method: 'none',
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
    });
  });

  it('names the client by ORACLE_NAME, and serves nothing without a known NETWORK', async () => {
    const { env } = setup();
    const unnamed = await handleClientDocument({ ...env, ORACLE_NAME: ' ' });
    expect(await unnamed.json()).toMatchObject({
      client_name: 'IXO assistant',
    });
    for (const NETWORK of [undefined, 'localnet']) {
      const off = await handleClientDocument({ ...env, NETWORK });
      expect(off.status).toBe(404);
    }
  });

  it('start sends the browser to asks, and refuses a state it did not make', async () => {
    const { env, connection } = setup();
    const { link } = await connection.begin(PERSON_DID, 'whatsapp');
    const start = await handleStart(new Request(link), env);
    expect(start.status).toBe(302);
    expect(start.headers.get('location')).toMatch(
      /^https:\/\/dev\.asks\.world\/oauth\/authorize\?/,
    );

    const forged = await handleStart(
      new Request(
        `${PUBLIC_URL}/asks/oauth/start/${'c'.repeat(64)}.${'x'.repeat(32)}`,
      ),
      env,
    );
    expect(forged.status).toBe(200);
    expect(await forged.text()).toContain('asks is not connected');
  });

  it('callback refuses an answer from another issuer (RFC 9207) without trading the code', async () => {
    const { env, connection, net } = setup();
    const state = (await connection.begin(PERSON_DID, 'whatsapp')).link
      .split('/')
      .pop()!;
    for (const iss of ['https://evil.example', '']) {
      const page = await handleCallback(
        callback({ code: 'c', state, ...(iss ? { iss } : {}) }),
        env,
      );
      expect(await page.text()).toContain('come from asks.world');
    }
    expect(net.calls).toHaveLength(0);
    expect(await connection.status()).toEqual({
      connected: false,
      pending: true,
    });
  });

  it('callback connects and offers the way back to WhatsApp, or to the chat', async () => {
    const { env, connection } = setup();
    const state = (await connection.begin(PERSON_DID, 'whatsapp')).link
      .split('/')
      .pop()!;
    const page = await handleCallback(
      callback({ code: 'c', state, iss: 'https://dev.asks.world' }),
      env,
    );
    const html = await page.text();
    expect(page.headers.get('content-type')).toContain('text/html');
    expect(html).toContain('asks is connected');
    expect(html).toContain('Back to WhatsApp');
    expect(html).toContain(
      'href="https://wa.me/12019082266?text=I%27m%20connected"',
    );
    expect(await connection.status()).toEqual({
      connected: true,
      pending: false,
      account: PERSON_ADDRESS,
    });

    const portalState = (await connection.begin(PERSON_DID, 'chat')).link
      .split('/')
      .pop()!;
    const portal = await (
      await handleCallback(
        callback({
          code: 'c',
          state: portalState,
          iss: 'https://dev.asks.world',
        }),
        env,
      )
    ).text();
    expect(portal).toContain('Go back to your chat');
    expect(portal).not.toContain('Back to WhatsApp');
  });

  it('callback refuses a sign-in with another asks account, or one asks cannot confirm', async () => {
    for (const [account, words] of [
      [
        () => accountAnswer(OTHER_ADDRESS),
        'belongs to a different asks account than the one using this chat. Nothing was linked.',
      ],
      [
        () => json({}, 502),
        'We couldn&#39;t confirm your asks account just now. Nothing was linked. Try again from your chat.',
      ],
    ] as const) {
      const { env, connection } = setup(account);
      const state = (await connection.begin(PERSON_DID, 'whatsapp')).link
        .split('/')
        .pop()!;
      const html = await (
        await handleCallback(
          callback({ code: 'c', state, iss: 'https://dev.asks.world' }),
          env,
        )
      ).text();
      expect(html).toContain(words);
      expect(html).not.toContain('Back to WhatsApp');
      expect((await connection.status()).connected).toBe(false);
    }
  });

  it('start answers a malformed state with a page, not an error', async () => {
    const page = await handleStart(
      new Request(`${PUBLIC_URL}/asks/oauth/start/%E0%A4%A`),
      setup().env,
    );
    expect(page.status).toBe(200);
    expect(await page.text()).toContain('asks is not connected');
  });

  it('callback with an error says so and keeps nothing', async () => {
    const { env, connection } = setup();
    const state = (await connection.begin(PERSON_DID, 'chat')).link
      .split('/')
      .pop()!;
    const page = await handleCallback(
      callback({
        error: 'access_denied',
        state,
        iss: 'https://dev.asks.world',
      }),
      env,
    );
    expect(await page.text()).toContain('not finished');
    expect((await connection.status()).connected).toBe(false);
  });
});

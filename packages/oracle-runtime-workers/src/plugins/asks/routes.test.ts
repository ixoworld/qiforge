import { describe, expect, it } from 'vitest';
import type { AsksConnection, AsksWorkerEnv } from './connection';
import {
  CHECK,
  CROSS,
  handleCallback,
  handleClientDocument,
  handleStart,
} from './routes';
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
  const clock = { now: 0 };
  const { connection } = connectionWith(net.fetcher, clock, undefined, account);
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
  return { env, connection, net, clock };
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
    expect(await forged.text()).toContain('This link won’t work');
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
    expect(html).toContain('You’re connected');
    expect(html).toContain(
      'Personal Agent (Devnet) is now linked to your asks.world account.',
    );
    expect(html).toContain(
      '<a class="button" href="https://wa.me/12019082266?text=I%27m%20connected">Back to WhatsApp</a>',
    );
    expect(html).toContain(`<path d="${CHECK}"/>`);
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
    expect(portal).toContain(
      '<p class="next">Go back to your chat and carry on.</p>',
    );
    expect(portal).not.toContain('class="button"');
  });

  it('callback refuses a sign-in with another asks account, or one asks cannot confirm', async () => {
    for (const [account, words] of [
      [
        () => accountAnswer(OTHER_ADDRESS),
        'That’s a different account</h1>\n<p class="line">You signed in with a different asks.world account from the one Personal Agent (Devnet) uses. Nothing was linked.',
      ],
      [
        () => json({}, 502),
        'asks.world didn’t answer just now. Nothing was linked.</p>\n<p class="next">Try again from your chat.</p>',
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
      expect(html).not.toContain('class="button"');
      expect(html).toContain(`<path d="${CROSS}"/>`);
      expect((await connection.status()).connected).toBe(false);
    }
  });

  it('start answers a malformed state with a page, not an error', async () => {
    const page = await handleStart(
      new Request(`${PUBLIC_URL}/asks/oauth/start/%E0%A4%A`),
      setup().env,
    );
    expect(page.status).toBe(200);
    expect(await page.text()).toContain('This link won’t work');
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
    expect(await page.text()).toContain('Sign-in wasn’t finished');
    expect((await connection.status()).connected).toBe(false);
  });

  it('callback names an expired or used link, and a reply with no code', async () => {
    const { env, connection, clock } = setup();
    const begin = async () =>
      (await connection.begin(PERSON_DID, 'chat')).link.split('/').pop()!;
    const answer = async (state: string, code = 'c') =>
      (
        await handleCallback(
          callback({
            ...(code ? { code } : {}),
            state,
            iss: 'https://dev.asks.world',
          }),
          env,
        )
      ).text();

    const late = await begin();
    clock.now += 16 * 60_000;
    expect(await answer(late)).toContain(
      'This link has expired</h1>\n<p class="line">The sign-in took longer than 15 minutes.',
    );

    const once = await begin();
    await answer(once);
    expect(await answer(once)).toContain('This link was already used</h1>');

    const noCode = await answer(await begin(), '');
    expect(noCode).toContain(
      'Something went wrong</h1>\n<p class="line">asks.world sent no sign-in code.',
    );
    for (const html of [noCode, await answer(once)]) {
      expect(html).toContain(
        '<p class="next">Ask in your chat for a new sign-in link.</p>',
      );
      expect(html).toContain(`<path d="${CROSS}"/>`);
      expect(html).not.toContain('class="button"');
    }
  });

  it('start names an expired link', async () => {
    const { env, connection, clock } = setup();
    const { link } = await connection.begin(PERSON_DID, 'whatsapp');
    clock.now += 16 * 60_000;
    expect(await (await handleStart(new Request(link), env)).text()).toContain(
      'This link has expired</h1>\n<p class="line">Sign-in links last 15 minutes.',
    );
  });

  it('escapes the oracle name and the return link, and keeps the strict headers', async () => {
    const { env, connection } = setup();
    const state = (await connection.begin(PERSON_DID, 'whatsapp')).link
      .split('/')
      .pop()!;
    const response = await handleCallback(
      callback({ code: 'c', state, iss: 'https://dev.asks.world' }),
      {
        ...env,
        ORACLE_NAME: '<b>Bot</b>',
        ASKS_WHATSAPP_RETURN_URL: 'https://wa.me/1?text="><script>',
      },
    );
    const html = await response.text();
    expect(html).not.toContain('<b>');
    expect(html).not.toContain('<script>');
    expect(html).toContain(
      '<span class="who">&#60;b&#62;Bot&#60;/b&#62;</span>',
    );
    expect(html).toContain(
      'href="https://wa.me/1?text=&#34;&#62;&#60;script&#62;"',
    );
    expect(response.headers.get('content-security-policy')).toBe(
      "default-src 'none'; style-src 'unsafe-inline'",
    );
  });
});

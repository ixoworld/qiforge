/**
 * The sign-in routes, served by the shell Worker without UCAN auth:
 *
 *   GET /asks/oauth/client.json      the Client ID Metadata Document asks reads
 *   GET /asks/oauth/start/<state>    the short link sent in the chat → 302 to asks
 *   GET /asks/oauth/callback         asks sends the browser back here with a code
 *
 * The state names the person's connection object (`<object name>.<random>`),
 * and that object holds the PKCE verifier and checks the state.
 */
import type { PluginRoute } from '../../plugin-api';
import type { AsksWorkerEnv, ConnectionApi } from './connection';
import {
  asksMcpUrlOf,
  clientDocument,
  endpointsOf,
  objectNameOfState,
} from './oauth';

export function connectionOf(
  env: AsksWorkerEnv,
  objectName: string,
): ConnectionApi | null {
  const namespace = env.ASKS_CONNECTIONS;
  if (!namespace) return null;
  return namespace.get(namespace.idFromName(objectName));
}

const escape = (text: string): string =>
  text.replace(/[&<>"']/g, (char) => `&#${char.charCodeAt(0)};`);

const oracleNameOf = (env: AsksWorkerEnv): string =>
  env.ORACLE_NAME?.trim() || 'IXO assistant';

/** What one result page says. Every field is plain text and is escaped. */
export interface PageText {
  ok: boolean;
  title: string;
  line: string;
  /** The next step in words, when there is no link to give. */
  next?: string;
  button?: { label: string; href: string };
}

export const CHECK = 'M17.5 28.5l7 7 14-14';
export const CROSS = 'M21 21l14 14M35 21L21 35';
// The asks.world mark (the letter and its dot), on a 7×5 grid.
const ASKS_MARK = `<svg viewBox="0 0 7 5" aria-hidden="true"><path fill="currentColor" fill-rule="evenodd" d="M5 0V5H4V4.49609C3.58183 4.81083 3.06369 5 2.5 5C1.11929 5 0 3.88071 0 2.5C0 1.11929 1.11929 0 2.5 0H5ZM2.5 1C1.67157 1 1 1.67157 1 2.5C1 3.32843 1.67157 4 2.5 4C3.32843 4 4 3.32843 4 2.5V1H2.5Z"/><circle class="dot" cx="6.25" cy="4.25" r=".75"/></svg>`;

// Inline CSS only: the CSP below allows no fonts, scripts or images. Colours follow asks.world's own tokens.
const STYLE = `:root{color-scheme:light dark;--ground:#f4f5f6;--card:#fff;--edge:rgba(25,26,28,.09);--lift:0 1px 2px rgba(25,26,28,.04),0 8px 24px rgba(25,26,28,.06);--ink:#191a1c;--ink-2:rgba(25,26,28,.66);--ink-3:rgba(25,26,28,.4);--rule:rgba(25,26,28,.1);--on-ink:#fff;--ok:#0e7c43;--ok-soft:rgba(14,124,67,.1);--no:#c4281c;--no-soft:rgba(217,45,32,.09);--brand:#0d8261}
@media (prefers-color-scheme:dark){:root{--ground:#0b0c0d;--card:#151619;--edge:rgba(236,236,237,.08);--lift:none;--ink:#ececed;--ink-2:rgba(236,236,237,.66);--ink-3:rgba(236,236,237,.36);--rule:rgba(236,236,237,.1);--on-ink:#0e0f10;--ok:#34c07c;--ok-soft:rgba(52,192,124,.14);--no:#f0655c;--no-soft:rgba(240,101,92,.14);--brand:#2aeab3}}
*{box-sizing:border-box}
html{-webkit-text-size-adjust:100%;text-size-adjust:100%}
body{margin:0;min-height:100vh;min-height:100dvh;display:flex;align-items:center;justify-content:center;padding:24px 16px calc(32px + env(safe-area-inset-bottom));background:var(--ground);color:var(--ink);font:16px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,system-ui,sans-serif;-webkit-font-smoothing:antialiased}
main{width:100%;max-width:400px;margin-bottom:6vh}
.card{background:var(--card);border:1px solid var(--edge);box-shadow:var(--lift);border-radius:20px;padding:36px 24px 24px;text-align:center}
.mark{display:block;width:64px;height:64px;margin:0 auto 20px}
.mark circle{fill:var(--tone-soft);transform-origin:center;transform-box:fill-box;animation:pop .5s cubic-bezier(.16,1,.3,1) both}
.mark path{fill:none;stroke:var(--tone);stroke-width:3.5;stroke-linecap:round;stroke-linejoin:round;stroke-dasharray:44;animation:draw .6s cubic-bezier(.16,1,.3,1) .12s both}
.ok{--tone:var(--ok);--tone-soft:var(--ok-soft)}
.no{--tone:var(--no);--tone-soft:var(--no-soft)}
h1{margin:0 0 8px;font-size:1.625rem;line-height:1.2;font-weight:650;letter-spacing:-.02em;text-wrap:balance}
.line{margin:0;color:var(--ink-2);font-size:1.0625rem;overflow-wrap:anywhere;text-wrap:pretty}
.next{margin:24px 0 0;padding-top:20px;border-top:1px solid var(--rule);font-weight:600;text-wrap:balance}
.button{display:flex;align-items:center;justify-content:center;min-height:52px;margin-top:28px;padding:12px 20px;border-radius:12px;background:var(--ink);color:var(--on-ink);font-size:1.0625rem;font-weight:600;text-decoration:none;-webkit-tap-highlight-color:transparent;transition:transform .15s cubic-bezier(.16,1,.3,1),opacity .15s}
.button:hover{opacity:.88}
.button:active{transform:scale(.98)}
.button:focus-visible{outline:3px solid var(--brand);outline-offset:3px}
.pair{display:flex;align-items:center;justify-content:center;gap:12px;margin-top:20px;font-size:.875rem;color:var(--ink-2)}
.who{min-width:0;overflow-wrap:anywhere;text-align:right}
.link{flex:0 0 28px;height:2px;border-radius:1px;background:var(--ok)}
.no .link{background:repeating-linear-gradient(90deg,var(--ink-3) 0 4px,transparent 4px 8px)}
.asks{display:inline-flex;align-items:center;gap:6px;flex:none;color:var(--ink);font-weight:600}
.asks svg{width:21px;height:15px}
.asks .dot{fill:var(--brand)}
@media (min-width:640px){main{max-width:440px}.card{padding:44px 40px 32px}h1{font-size:1.875rem}}
@media (min-width:1200px) and (min-height:800px){body{font-size:18px}main{max-width:520px}.card{padding:56px 48px 40px;border-radius:24px}.mark{width:80px;height:80px;margin-bottom:24px}h1{font-size:2.25rem}.line{font-size:1.1875rem}.pair{font-size:1rem;margin-top:24px}.asks svg{width:25px;height:18px}}
@keyframes pop{from{transform:scale(.8)}}
@keyframes draw{from{stroke-dashoffset:44}}
@media (prefers-reduced-motion:reduce){.mark circle,.mark path{animation:none}}`;

/** A result page for the browser the sign-in ran in (often WhatsApp's own). */
export function page(oracle: string, text: PageText): Response {
  const action = text.button
    ? `<a class="button" href="${escape(text.button.href)}">${escape(text.button.label)}</a>`
    : text.next
      ? `<p class="next">${escape(text.next)}</p>`
      : '';
  const html = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<meta name="color-scheme" content="light dark"><meta name="robots" content="noindex">
<meta name="theme-color" content="#f4f5f6" media="(prefers-color-scheme: light)"><meta name="theme-color" content="#0b0c0d" media="(prefers-color-scheme: dark)">
<title>${escape(text.title)} · Asks</title>
<style>${STYLE}</style></head>
<body class="${text.ok ? 'ok' : 'no'}"><main><section class="card" aria-labelledby="title">
<svg class="mark" viewBox="0 0 56 56" aria-hidden="true"><circle cx="28" cy="28" r="28"/><path d="${text.ok ? CHECK : CROSS}"/></svg>
<h1 id="title">${escape(text.title)}</h1>
<p class="line">${escape(text.line)}</p>
${action}
</section>
<footer class="pair"><span class="who">${escape(oracle)}</span><span class="link" aria-hidden="true"></span><span class="asks">${ASKS_MARK}Asks</span></footer>
</main></body></html>`;
  return new Response(html, {
    status: 200,
    headers: {
      'content-type': 'text/html; charset=utf-8',
      'cache-control': 'no-store',
      'referrer-policy': 'no-referrer',
      'content-security-policy':
        "default-src 'none'; style-src 'unsafe-inline'",
    },
  });
}

/** A page for a sign-in that linked nothing. */
const failed = (
  env: AsksWorkerEnv,
  title: string,
  line: string,
  next = AGAIN,
) => page(oracleNameOf(env), { ok: false, title, line, next });
const AGAIN = 'Ask in your chat for a new sign-in link.';
const NOT_OURS = 'This link won’t work';
const EXPIRED = 'This link has expired';
const USED = 'This link was already used';
const SOMETHING_WRONG = 'Something went wrong';

function configured(env: AsksWorkerEnv) {
  const mcpUrl = asksMcpUrlOf(env.NETWORK);
  return mcpUrl && env.ORACLE_PUBLIC_URL
    ? endpointsOf(mcpUrl, env.ORACLE_PUBLIC_URL)
    : null;
}

export async function handleClientDocument(
  env: AsksWorkerEnv,
): Promise<Response> {
  const endpoints = configured(env);
  if (!endpoints) return new Response('Not found', { status: 404 });
  return new Response(
    JSON.stringify(clientDocument(endpoints, oracleNameOf(env))),
    {
      headers: {
        'content-type': 'application/json',
        'cache-control': 'public, max-age=3600',
      },
    },
  );
}

export async function handleStart(
  request: Request,
  env: AsksWorkerEnv,
): Promise<Response> {
  // A state is base64url and hex only: nothing to decode.
  const state = new URL(request.url).pathname.split('/').pop() ?? '';
  const name = objectNameOfState(state);
  const connection = name ? connectionOf(env, name) : null;
  if (!connection)
    return failed(env, NOT_OURS, 'It isn’t a sign-in link this chat made.');
  const step = await connection.authorizeUrl(state);
  if ('reason' in step) {
    return step.reason === 'expired'
      ? failed(env, EXPIRED, 'Sign-in links last 15 minutes.')
      : failed(env, USED, 'It was used, or a newer link replaced it.');
  }
  return new Response(null, {
    status: 302,
    headers: { location: step.url, 'cache-control': 'no-store' },
  });
}

export async function handleCallback(
  request: Request,
  env: AsksWorkerEnv,
): Promise<Response> {
  const endpoints = configured(env);
  const params = new URL(request.url).searchParams;
  const state = params.get('state') ?? '';
  const name = objectNameOfState(state);
  const connection = name ? connectionOf(env, name) : null;
  if (!endpoints || !connection)
    return failed(env, NOT_OURS, 'This sign-in isn’t one this chat started.');
  // RFC 9207: the answer must come from asks' own issuer.
  if (params.get('iss') !== endpoints.issuer)
    return failed(env, NOT_OURS, 'This sign-in didn’t come from asks.world.');
  if (params.get('error'))
    return failed(
      env,
      'Sign-in wasn’t finished',
      'Nothing was linked.',
      'You can start again from your chat.',
    );
  const code = params.get('code');
  if (!code) return failed(env, SOMETHING_WRONG, 'Asks sent no sign-in code.');
  const done = await connection.complete(state, code);
  const oracle = oracleNameOf(env);
  if (!done.ok) {
    if (done.reason === 'other-account')
      return failed(
        env,
        'That’s a different account',
        `You signed in with a different Asks account from the one ${oracle} uses. Nothing was linked.`,
        'Ask in your chat for a new link, and sign in with the same account.',
      );
    if (done.reason === 'unconfirmed')
      return failed(
        env,
        'We couldn’t check your account',
        'Asks didn’t answer just now. Nothing was linked.',
        'Try again from your chat.',
      );
    return done.reason === 'expired'
      ? failed(env, EXPIRED, 'The sign-in took longer than 15 minutes.')
      : done.reason === 'unknown'
        ? failed(env, USED, 'It was used, or a newer sign-in was started.')
        : failed(
            env,
            SOMETHING_WRONG,
            'Asks didn’t accept the sign-in. Nothing was linked.',
          );
  }
  const connected = {
    ok: true,
    title: 'You’re connected',
    line: `${oracle} is now linked to your Asks account.`,
  };
  const back = env.ASKS_WHATSAPP_RETURN_URL;
  return done.surface === 'whatsapp' && back
    ? page(oracle, {
        ...connected,
        line: `${connected.line} Your message is ready to send in WhatsApp.`,
        button: { label: 'Back to WhatsApp', href: back },
      })
    : page(oracle, {
        ...connected,
        next: 'Go back to your chat and carry on.',
      });
}

export const asksRoutes = (): PluginRoute[] => [
  {
    method: 'GET',
    path: '/asks/oauth/client.json',
    handler: (_request, env) => handleClientDocument(env),
  },
  {
    method: 'GET',
    path: '/asks/oauth/start/:state',
    handler: (request, env) => handleStart(request, env),
  },
  {
    method: 'GET',
    path: '/asks/oauth/callback',
    handler: (request, env) => handleCallback(request, env),
  },
];

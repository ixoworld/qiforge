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

/** A small page for the browser the sign-in ran in (often WhatsApp's own). */
export function page(
  title: string,
  line: string,
  button?: { label: string; href: string },
): Response {
  const html = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escape(title)}</title>
<style>
:root{color-scheme:light dark;--bg:#f7f7f5;--fg:#1a1a1a;--muted:#5c5c5c;--accent:#0d8261;--on-accent:#fff}
@media (prefers-color-scheme:dark){:root{--bg:#141414;--fg:#f2f2f2;--muted:#a8a8a8;--accent:#3fb68b;--on-accent:#06281c}}
body{margin:0;min-height:100vh;display:grid;place-items:center;background:var(--bg);color:var(--fg);font:17px/1.5 system-ui,-apple-system,"Segoe UI",sans-serif}
main{max-width:26rem;padding:2rem 1.25rem;text-align:center}
h1{font-size:1.5rem;margin:0 0 .5rem}
p{margin:0 0 1.5rem;color:var(--muted)}
a.button{display:inline-block;min-width:14rem;padding:.9rem 1.5rem;border-radius:.75rem;background:var(--accent);color:var(--on-accent);font-weight:600;text-decoration:none}
a.button:focus-visible{outline:3px solid var(--fg);outline-offset:3px}
</style></head>
<body><main><h1>${escape(title)}</h1><p>${escape(line)}</p>${
    button
      ? `<a class="button" href="${escape(button.href)}">${escape(button.label)}</a>`
      : ''
  }</main></body></html>`;
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

const notConnected = (line: string) => page('asks is not connected', line);
const AGAIN = 'Ask in your chat for a new sign-in link.';

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
  const name = env.ORACLE_NAME?.trim() || 'IXO assistant';
  return new Response(JSON.stringify(clientDocument(endpoints, name)), {
    headers: {
      'content-type': 'application/json',
      'cache-control': 'public, max-age=3600',
    },
  });
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
    return notConnected(`That sign-in link isn't one this chat made. ${AGAIN}`);
  const step = await connection.authorizeUrl(state);
  if ('reason' in step) {
    return notConnected(
      step.reason === 'expired'
        ? `That sign-in link has expired (they last 15 minutes). ${AGAIN}`
        : `That sign-in link was replaced by a newer one, or already used. ${AGAIN}`,
    );
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
    return notConnected(`This sign-in isn't one this chat started. ${AGAIN}`);
  // RFC 9207: the answer must come from asks' own issuer.
  if (params.get('iss') !== endpoints.issuer)
    return notConnected(`This sign-in didn't come from asks.world. ${AGAIN}`);
  if (params.get('error'))
    return notConnected(
      'The sign-in was not finished. You can start again from your chat.',
    );
  const code = params.get('code');
  if (!code) return notConnected(`asks.world sent no sign-in code. ${AGAIN}`);
  const done = await connection.complete(state, code);
  if (!done.ok) {
    if (done.reason === 'other-account')
      return notConnected(
        'This sign-in belongs to a different asks account than the one using this chat. Nothing was linked.',
      );
    if (done.reason === 'unconfirmed')
      return notConnected(
        "We couldn't confirm your asks account just now. Nothing was linked. Try again from your chat.",
      );
    return notConnected(
      done.reason === 'expired'
        ? `The sign-in took longer than 15 minutes. ${AGAIN}`
        : done.reason === 'unknown'
          ? `This sign-in was already used, or a newer one was started. ${AGAIN}`
          : `asks.world didn't accept the sign-in. ${AGAIN}`,
    );
  }
  const back = env.ASKS_WHATSAPP_RETURN_URL;
  return done.surface === 'whatsapp' && back
    ? page(
        'asks is connected',
        'Go back to WhatsApp and send the message that is ready there.',
        {
          label: 'Back to WhatsApp',
          href: back,
        },
      )
    : page('asks is connected', 'Go back to your chat and carry on.');
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

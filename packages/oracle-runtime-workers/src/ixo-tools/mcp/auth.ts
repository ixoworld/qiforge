import { z } from 'zod';
import {
  IXO_MCP_SCOPE,
  ixoMcpMetadataUrl,
  type IxoMcpClient,
  type IxoMcpConfig,
} from './config';

export const IXO_MCP_INTROSPECTION_TIMEOUT_MS = 5_000;
const principalSchema = z.strictObject({
  active: z.literal(true),
  iss: z.string().min(1),
  sub: z.string().regex(/^did:[a-z0-9]+:[^\s]+$/),
  aud: z.string().min(1),
  client_id: z.string().min(1).max(256),
  gid: z.string().min(1).max(256),
  gver: z.string().min(1).max(256),
  scope: z.string().max(4096),
  iat: z.number().int().nonnegative(),
  exp: z.number().int().positive(),
  jti: z.string().min(1).max(256),
  token_type: z.literal('Bearer'),
});
export type IxoMcpPrincipal = Readonly<z.infer<typeof principalSchema>>;
export type IxoMcpAuthorization = Readonly<{
  principal: IxoMcpPrincipal;
  client: IxoMcpClient;
  current(): Promise<boolean>;
}>;
export function ixoMcpAuthFailure(
  config: IxoMcpConfig,
  status = 401,
): Response {
  return Response.json(
    { error: status === 503 ? 'authorization_unavailable' : 'invalid_token' },
    {
      status,
      headers: {
        'cache-control': 'no-store',
        'www-authenticate': `Bearer resource_metadata="${ixoMcpMetadataUrl(config)}", scope="${IXO_MCP_SCOPE}"`,
      },
    },
  );
}
export async function readBoundedBody(
  response: Response | Request,
  limit: number,
  signal?: AbortSignal,
): Promise<string> {
  const size = response.headers.get('content-length');
  if (size !== null && (!/^\d+$/.test(size) || Number(size) > limit))
    throw new Error('body_limit');
  if (!response.body) return '';
  const reader = response.body.getReader();
  const decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });
  const abort = () => {
    void reader.cancel().catch(() => undefined);
  };
  signal?.addEventListener('abort', abort, { once: true });
  let bytes = 0;
  let text = '';
  try {
    if (signal?.aborted) throw new Error('body_aborted');
    while (true) {
      const part = await reader.read();
      if (signal?.aborted) throw new Error('body_aborted');
      if (part.done) break;
      bytes += part.value.byteLength;
      if (bytes > limit) throw new Error('body_limit');
      text += decoder.decode(part.value, { stream: true });
    }
    return text + decoder.decode();
  } finally {
    signal?.removeEventListener('abort', abort);
    void reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
}
async function introspect(
  token: string,
  config: IxoMcpConfig,
  secret: string,
): Promise<IxoMcpPrincipal | null> {
  const controller = new AbortController();
  let timeout: ReturnType<typeof setTimeout> | undefined;
  let received: Response | undefined;
  const timedOut = new Promise<never>((_, reject) => {
    timeout = setTimeout(() => {
      controller.abort();
      void received?.body?.cancel().catch(() => undefined);
      reject(new Error('authorization_timeout'));
    }, IXO_MCP_INTROSPECTION_TIMEOUT_MS);
  });
  try {
    const work = async () => {
      const credentials = `${encodeURIComponent(config.resourceClientId)}:${encodeURIComponent(secret)}`;
      received = await fetch(
        `${config.issuer.replace(/\/$/, '')}/oauth/introspect`,
        {
          method: 'POST',
          redirect: 'manual',
          signal: controller.signal,
          headers: {
            authorization: `Basic ${btoa(credentials)}`,
            'content-type': 'application/x-www-form-urlencoded',
            accept: 'application/json',
          },
          body: new URLSearchParams({
            token,
            token_type_hint: 'access_token',
          }).toString(),
        },
      );
      if (
        received.status !== 200 ||
        received.headers.get('content-type')?.split(';')[0]?.trim() !==
          'application/json'
      )
        return null;
      const parsed = principalSchema.safeParse(
        JSON.parse(await readBoundedBody(received, 16_384, controller.signal)),
      );
      if (!parsed.success) return null;
      const value = parsed.data;
      const now = Date.now() / 1000;
      if (
        value.iss !== config.issuer ||
        value.aud !== config.resource ||
        value.exp <= now ||
        value.iat > now + 30 ||
        value.iat >= value.exp ||
        !value.scope.split(' ').includes(IXO_MCP_SCOPE)
      )
        return null;
      return Object.freeze(value);
    };
    return await Promise.race([work(), timedOut]);
  } catch {
    return null;
  } finally {
    clearTimeout(timeout);
    void received?.body?.cancel().catch(() => undefined);
  }
}
export async function authenticateIxoMcp(
  request: Request,
  config: IxoMcpConfig,
  secret: string | undefined,
): Promise<
  | { ok: true; authorization: IxoMcpAuthorization }
  | { ok: false; response: Response }
> {
  if (!secret || secret.length > 4096)
    return { ok: false, response: ixoMcpAuthFailure(config, 503) };
  const header = request.headers.get('authorization');
  const token = header?.match(/^Bearer ([A-Za-z0-9._~+/-]+=*)$/i)?.[1];
  if (!token || token.length > 16_384)
    return { ok: false, response: ixoMcpAuthFailure(config) };
  const principal = await introspect(token, config, secret);
  const client = config.clients.find(
    (entry) => entry.clientId === principal?.client_id,
  );
  const origin = request.headers.get('origin');
  if (
    !principal ||
    !client ||
    (origin !== null && !client.origins.includes(origin))
  )
    return { ok: false, response: ixoMcpAuthFailure(config) };
  const binding = JSON.stringify({ principal, client });
  return {
    ok: true,
    authorization: Object.freeze({
      principal,
      client,
      current: async () => {
        const next = await introspect(token, config, secret);
        const currentClient = config.clients.find(
          (entry) => entry.clientId === next?.client_id,
        );
        return (
          !!next &&
          !!currentClient &&
          JSON.stringify({ principal: next, client: currentClient }) === binding
        );
      },
    }),
  };
}

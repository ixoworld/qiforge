import { z } from 'zod';
import type { WorkersUcanService } from '../do/ucan-service';
import { MEMORY_CAPABILITY } from '../plugins/delegated-capabilities';
import { ImportError, type ImportChunk, type ImportBody } from './contract';
import type { ChunkOutcome, ImportTransport } from './ledger';
import { boundedJson, noRedirectFetch, publicUrl } from './network';

const RpcResponse = z.object({
  jsonrpc: z.literal('2.0'),
  id: z.union([z.string(), z.number()]),
  result: z.unknown().optional(),
  error: z.object({ code: z.number(), message: z.string() }).optional(),
});
const CallResult = z.object({
  isError: z.boolean().optional(),
  structuredContent: z.unknown().optional(),
  content: z
    .array(z.object({ type: z.string(), text: z.string().optional() }))
    .optional(),
});
const Acknowledgement = z.discriminatedUnion('success', [
  z.object({
    success: z.literal(true),
    queue_position: z.number().int().nonnegative(),
  }),
  z.object({ success: z.literal(false) }),
]);
const ProtocolVersion = z.enum([
  '2024-11-05',
  '2025-03-26',
  '2025-06-18',
  '2025-11-25',
]);

export async function readRpcResponse(
  response: Response,
  id: number,
): Promise<z.infer<typeof RpcResponse>> {
  if (!response.headers.get('content-type')?.includes('text/event-stream')) {
    const parsed = RpcResponse.parse(await boundedJson(response));
    if (parsed.id !== id) throw new ImportError(503, 'invalid_mcp_response');
    return parsed;
  }
  if (!response.body) throw new ImportError(503, 'empty_mcp_response');
  const reader = response.body.getReader();
  const decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });
  let buffer = '';
  let size = 0;
  try {
    while (true) {
      const part = await reader.read();
      if (part.done) break;
      size += part.value.length;
      if (size > 262_144) throw new ImportError(503, 'response_too_large');
      buffer += decoder.decode(part.value, { stream: true });
      buffer = buffer.replace(/\r\n/g, '\n');
      let end: number;
      while ((end = buffer.indexOf('\n\n')) >= 0) {
        const event = buffer.slice(0, end);
        buffer = buffer.slice(end + 2);
        const data = event
          .split('\n')
          .filter((line) => line.startsWith('data:'))
          .map((line) => line.slice(5).trimStart())
          .join('\n');
        if (!data) continue;
        const parsed = RpcResponse.safeParse(JSON.parse(data));
        if (parsed.success && parsed.data.id === id) return parsed.data;
      }
    }
    throw new ImportError(503, 'invalid_mcp_response');
  } finally {
    await reader.cancel().catch(() => undefined);
  }
}

export async function createImportTransport(options: {
  url: string;
  userRoom: string;
  delegation: string;
  ucan: Pick<WorkersUcanService, 'createInvocationFromDelegation'>;
  fetcher?: typeof fetch;
}): Promise<ImportTransport> {
  const fetcher = options.fetcher ?? fetch;
  const url = publicUrl(options.url);
  if (!options.userRoom) throw new ImportError(503, 'user_room_unavailable');
  const didResponse = await noRedirectFetch(
    fetcher,
    `${url.origin}/.well-known/did.json`,
  );
  if (!didResponse.ok)
    throw new ImportError(503, 'memory_identity_unavailable');
  const memory = z
    .object({
      id: z
        .string()
        .regex(/^did:(?:web|ixo|key):[^\s]+$/)
        .max(512),
    })
    .parse(await boundedJson(didResponse));
  const headers = async () => {
    const minted = await options.ucan.createInvocationFromDelegation(
      options.delegation,
      memory.id,
      { can: MEMORY_CAPABILITY.action, with: MEMORY_CAPABILITY.resource },
      { maxTtlSeconds: 60 },
    );
    if (!('invocation' in minted))
      throw new ImportError(503, 'memory_invocation_unavailable');
    return {
      authorization: `Bearer ${minted.invocation}`,
      'x-auth-type': 'ucan',
      'x-room-id': options.userRoom,
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
    };
  };
  const initialized = await noRedirectFetch(fetcher, url, {
    method: 'POST',
    headers: await headers(),
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {
        protocolVersion: '2025-03-26',
        capabilities: {},
        clientInfo: { name: 'ixo-organisation-memory', version: '1' },
      },
    }),
  });
  if (!initialized.ok) throw new ImportError(503, 'memory_initialize_failed');
  const init = await readRpcResponse(initialized, 1);
  if (init.error) throw new ImportError(503, 'memory_initialize_failed');
  const protocol = z
    .object({ protocolVersion: ProtocolVersion })
    .parse(init.result).protocolVersion;
  const sessionId = initialized.headers.get('mcp-session-id');
  if (sessionId && sessionId.length > 256)
    throw new ImportError(503, 'invalid_memory_session');
  const sessionHeaders = async () => ({
    ...(await headers()),
    'mcp-protocol-version': protocol,
    ...(sessionId ? { 'mcp-session-id': sessionId } : {}),
  });
  const notified = await noRedirectFetch(fetcher, url, {
    method: 'POST',
    headers: await sessionHeaders(),
    body: JSON.stringify({
      jsonrpc: '2.0',
      method: 'notifications/initialized',
    }),
  });
  await notified.body?.cancel().catch(() => undefined);
  if (!notified.ok) throw new ImportError(503, 'memory_initialize_failed');
  let sequence = 1;
  return {
    async add(
      chunk: ImportChunk,
      visibility: ImportBody['visibility'],
    ): Promise<ChunkOutcome> {
      const id = ++sequence;
      let requestHeaders: Record<string, string>;
      try {
        requestHeaders = await sessionHeaders();
      } catch {
        // Minting failed (e.g. the request grant expired mid-batch): nothing
        // left the Worker, so this chunk was not sent.
        return {
          id: chunk.id,
          state: 'not_submitted',
          code: 'memory_invocation_unavailable',
        };
      }
      try {
        const response = await noRedirectFetch(fetcher, url, {
          method: 'POST',
          headers: requestHeaders,
          signal: AbortSignal.timeout(20_000),
          body: JSON.stringify({
            jsonrpc: '2.0',
            id,
            method: 'tools/call',
            params: {
              name: 'add_oracle_knowledge',
              arguments: {
                name: chunk.sourceName,
                content: chunk.content,
                source: 'text',
                source_description: `${chunk.locator}; source sha256:${chunk.sourceSha256}; content sha256:${chunk.contentSha256}`,
                knowledge_space_type: visibility,
                confirmed_insertion_from_user: true,
              },
            },
          }),
        });
        if (!response.ok) {
          await response.body?.cancel().catch(() => undefined);
          return [400, 401, 403, 404, 405, 413, 422, 429].includes(
            response.status,
          )
            ? {
                id: chunk.id,
                state: 'rejected',
                code: `upstream_http_${response.status}`,
              }
            : {
                id: chunk.id,
                state: 'unknown',
                code: 'upstream_http_uncertain',
              };
        }
        const rpc = await readRpcResponse(response, id);
        // A generic JSON-RPC error may follow an effect. It is not evidence of refusal.
        if (rpc.error)
          return { id: chunk.id, state: 'unknown', code: 'upstream_rpc_error' };
        const call = CallResult.parse(rpc.result);
        if (call.isError)
          return {
            id: chunk.id,
            state: 'unknown',
            code: 'upstream_tool_error',
          };
        const texts =
          call.content?.filter((item) => item.type === 'text') ?? [];
        const payload: unknown =
          call.structuredContent ??
          (texts.length === 1 && texts[0]?.text
            ? JSON.parse(texts[0].text)
            : undefined);
        const acknowledgement = Acknowledgement.safeParse(payload);
        if (!acknowledgement.success)
          return {
            id: chunk.id,
            state: 'unknown',
            code: 'invalid_acknowledgement',
          };
        return acknowledgement.data.success
          ? {
              id: chunk.id,
              state: 'queued',
              queuePosition: acknowledgement.data.queue_position,
            }
          : { id: chunk.id, state: 'rejected', code: 'upstream_refused' };
      } catch {
        return { id: chunk.id, state: 'unknown', code: 'upstream_uncertain' };
      }
    },
  };
}

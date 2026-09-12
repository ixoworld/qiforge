import { z } from 'zod';
import type { RuntimeContext } from '../../plugin-api/types';
import { vfsBearer } from '../../plugins/vfs/vfs-auth';
import type { DomainContextOptions, DomainTransport } from './types';

export async function boundedBytes(
  response: Response,
  max: number,
): Promise<Uint8Array> {
  if (!response.ok) {
    await response.body?.cancel();
    throw new Error('document-unavailable');
  }
  if (Number(response.headers.get('content-length')) > max) {
    await response.body?.cancel();
    throw new Error('document-too-large');
  }
  const reader = response.body?.getReader();
  if (!reader) return new Uint8Array();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.length;
      if (size > max) throw new Error('document-too-large');
      chunks.push(value);
    }
  } finally {
    await reader.cancel();
    reader.releaseLock();
  }
  const out = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.length;
  }
  return out;
}
const iidSchema = z.object({
  data: z.object({
    iids: z.object({
      nodes: z.array(z.object({ id: z.string(), linkedResource: z.unknown() })),
    }),
  }),
  errors: z.array(z.unknown()).optional(),
});
const resourcesSchema = z.array(
  z
    .object({
      id: z.string(),
      proof: z.string(),
      serviceEndpoint: z.string(),
      encrypted: z.union([z.boolean(), z.string()]).optional(),
    })
    .passthrough(),
);

export function createDomainTransport(
  options: DomainContextOptions,
  ctx: RuntimeContext,
): DomainTransport {
  const blocksync = String(ctx.config.BLOCKSYNC_GRAPHQL_URL ?? '');
  const vfs =
    typeof ctx.config.VFS_BASE_URL === 'string'
      ? new URL(ctx.config.VFS_BASE_URL)
      : undefined;
  const matrix =
    typeof ctx.config.MATRIX_BASE_URL === 'string'
      ? new URL(ctx.config.MATRIX_BASE_URL)
      : undefined;
  const allowed = new Set([
    ...(options.allowedOrigins ?? []),
    ...(vfs ? [vfs.origin] : []),
    ...(matrix ? [matrix.origin] : []),
    ...(options.ipfsGateway ? [new URL(options.ipfsGateway).origin] : []),
  ]);
  return {
    isPublic(request) {
      if (request.private) return false;
      try {
        return !vfs || new URL(request.uri).origin !== vfs.origin;
      } catch {
        return request.uri.startsWith('ipfs://');
      }
    },
    async resolve(did, signal) {
      const response = await fetch(blocksync, {
        method: 'POST',
        redirect: 'error',
        signal,
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          query:
            'query DomainAnchor($id: String!) { iids(filter: { id: { equalTo: $id } }) { nodes { id linkedResource } } }',
          variables: { id: did },
        }),
      });
      const parsed = iidSchema.parse(
        JSON.parse(
          new TextDecoder().decode(await boundedBytes(response, 1024 * 1024)),
        ),
      );
      if (parsed.errors?.length) throw new Error('iid-unavailable');
      if (
        parsed.data.iids.nodes.length !== 1 ||
        parsed.data.iids.nodes[0]?.id !== did
      )
        throw new Error('iid-unavailable');
      const linked = parsed.data.iids.nodes[0].linkedResource ?? [];
      if (!Array.isArray(linked)) throw new Error('invalid-anchor-resources');
      const candidates: unknown[] = linked;
      const all = resourcesSchema.safeParse(
        candidates.filter(
          (entry) =>
            entry &&
            typeof entry === 'object' &&
            'id' in entry &&
            (entry.id === `${did}#dom` || entry.id === '{id}#dom'),
        ),
      );
      if (!all.success) throw new Error('invalid-anchor-resources');
      const matches = all.data;
      if (!matches.length) return null;
      const resource = matches[0];
      if (matches.length !== 1 || !resource?.proof || !resource.serviceEndpoint)
        throw new Error('invalid-anchor-ambiguous');
      return {
        did,
        cid: resource.proof,
        uri: resource.serviceEndpoint,
        private: resource.encrypted === true || resource.encrypted === 'true',
        resolvedAt: Date.now(),
        source: blocksync,
      };
    },
    async read(request, callerSignal) {
      const signal = callerSignal
        ? AbortSignal.any([callerSignal, AbortSignal.timeout(10_000)])
        : AbortSignal.timeout(10_000);
      let uri = request.uri;
      if (uri.startsWith('ipfs://')) {
        if (!options.ipfsGateway) throw new Error('ipfs-gateway-unconfigured');
        const path = uri.slice(7);
        if (
          !path ||
          path.includes('..') ||
          path.includes('?') ||
          path.includes('#')
        )
          throw new Error('invalid-ipfs-uri');
        uri = `${options.ipfsGateway.replace(/\/$/, '')}/ipfs/${path}`;
      }
      let url: URL;
      try {
        url = new URL(uri);
      } catch {
        throw new Error('unsupported-document-uri');
      }
      const isVfs =
        !!vfs &&
        url.origin === vfs.origin &&
        /^\/api\/fs\/files\/[^/]+\/content$/.test(url.pathname);
      if (request.private && !isVfs) {
        if (!options.readPrivateDocument)
          throw new Error('private-reader-unavailable');
        const result = await options.readPrivateDocument(request, ctx, signal);
        if (result.length > request.maxBytes)
          throw new Error('document-too-large');
        return result;
      }
      if (
        url.protocol !== 'https:' ||
        url.username ||
        url.password ||
        !allowed.has(url.origin)
      )
        throw new Error('document-origin-denied');
      const headers: Record<string, string> = {};
      if (
        !request.private &&
        matrix &&
        url.origin === matrix.origin &&
        /^\/_matrix\/(media\/v[13]|client\/v1\/media)\/download\//.test(
          url.pathname,
        )
      ) {
        const credentials = await ctx.matrix.botCredentials();
        if (new URL(credentials.baseUrl).origin !== url.origin)
          throw new Error('matrix-origin-mismatch');
        url.pathname = url.pathname.replace(
          /^\/_matrix\/media\/v[13]\/download\//,
          '/_matrix/client/v1/media/download/',
        );
        headers.Authorization = `Bearer ${credentials.accessToken}`;
      }
      if (isVfs) {
        const store = ctx.config.UCAN_STORE_URL;
        if (typeof store !== 'string')
          throw new Error('private-reader-unavailable');
        const bearer = await vfsBearer(
          ctx,
          {
            VFS_BASE_URL: vfs.href,
            UCAN_STORE_URL: store,
            VFS_MAX_READ_LINES: 200,
            VFS_REQUEST_TIMEOUT_MS: 10_000,
          },
          'fs/read',
        );
        if ('error' in bearer) throw new Error('document-access-denied');
        headers.Authorization = `Bearer ${bearer.bearer}`;
      }
      return boundedBytes(
        await fetch(url, { headers, redirect: 'error', signal }),
        request.maxBytes,
      );
    },
  };
}

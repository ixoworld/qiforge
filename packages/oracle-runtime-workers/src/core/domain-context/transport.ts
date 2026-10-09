/**
 * The network edge of domain context: the IID anchor lookup on Blocksync and
 * document reads. Reads go only to https origins on an allowlist (configured
 * origins, the VFS, the Matrix homeserver, the IPFS gateway), never follow
 * redirects, never carry URL credentials and never buffer more than the
 * request's byte bound. Private documents are read through the user's VFS
 * UCAN bearer or the host's `readPrivateDocument` adapter.
 */
import { CID } from 'multiformats/cid';
import { z } from 'zod';
import {
  UCAN_STORE_DEFAULT_URLS,
  VFS_DEFAULT_BASE_URLS,
} from '../../owner-store/ixo-vfs-store';
import type { RuntimeContext } from '../../plugin-api/types';
import { vfsBearer } from '../../plugins/vfs/vfs-auth';
import { INDEX_MAX_BYTES } from './integrity';
import type {
  DocumentRequest,
  DomainContextOptions,
  DomainTransport,
} from './types';

/** Bound of one document read when the caller's signal does not end it sooner. */
export const DOCUMENT_READ_TIMEOUT_MS = 10_000;

const MATRIX_MEDIA_DOWNLOAD =
  /^\/_matrix\/(media\/v[13]|client\/v1\/media)\/download\//;
const VFS_FILE_CONTENT = /^\/api\/fs\/files\/[^/]+\/content$/;

const IID_QUERY =
  'query DomainAnchor($id: String!) { iids(filter: { id: { equalTo: $id } }) { nodes { id linkedResource } } }';

const iidResponse = z.object({
  data: z.object({
    iids: z.object({
      nodes: z.array(z.object({ id: z.string(), linkedResource: z.unknown() })),
    }),
  }),
  errors: z.array(z.unknown()).optional(),
});

/** Longest anchor CID accepted (a CIDv1 sha2-256 in base32 is 59 characters). */
export const MAX_ANCHOR_CID_CHARS = 128;
/** Longest anchor `serviceEndpoint` accepted. */
export const MAX_ANCHOR_URI_CHARS = 2048;

/** True when `value` is a parseable CID of a sane length. */
function isCid(value: string): boolean {
  if (value.length > MAX_ANCHOR_CID_CHARS) return false;
  try {
    CID.parse(value);
    return true;
  } catch {
    return false;
  }
}

// The anchor's CID lands in provenance (prompt, stream, SQLite) and its URI
// in the run's pins, so both are bounded here, before anything copies them.
const domainResources = z.array(
  z.looseObject({
    id: z.string(),
    proof: z.string().min(1).refine(isCid),
    serviceEndpoint: z.string().min(1).max(MAX_ANCHOR_URI_CHARS),
    encrypted: z.union([z.boolean(), z.string()]).optional(),
  }),
);

/**
 * The response body, at most `max` bytes. A declared or streamed size above
 * the bound cancels the body instead of buffering it.
 */
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

function optionalUrl(value: unknown): URL | undefined {
  if (typeof value !== 'string' || !value) return undefined;
  try {
    return new URL(value);
  } catch {
    return undefined;
  }
}

/** A configured value, else the per-NETWORK default (as the VFS plugin resolves them). */
function networkUrl(
  config: RuntimeContext['config'],
  key: string,
  defaults: Record<string, string>,
): URL | undefined {
  const network = typeof config.NETWORK === 'string' ? config.NETWORK : '';
  return optionalUrl(config[key]) ?? optionalUrl(defaults[network]);
}

function positiveNumber(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0
    ? value
    : fallback;
}

export function createDomainTransport(
  options: DomainContextOptions,
  ctx: RuntimeContext,
): DomainTransport {
  const blocksync =
    typeof ctx.config.BLOCKSYNC_GRAPHQL_URL === 'string'
      ? ctx.config.BLOCKSYNC_GRAPHQL_URL
      : '';
  const vfs = networkUrl(ctx.config, 'VFS_BASE_URL', VFS_DEFAULT_BASE_URLS);
  const ucanStore = networkUrl(
    ctx.config,
    'UCAN_STORE_URL',
    UCAN_STORE_DEFAULT_URLS,
  );
  const matrix = optionalUrl(ctx.config.MATRIX_BASE_URL);
  const ipfsGateway = optionalUrl(options.ipfsGateway);
  const allowed = new Set<string>();
  for (const origin of options.allowedOrigins ?? []) {
    const url = optionalUrl(origin);
    if (url) allowed.add(url.origin);
  }
  for (const url of [vfs, matrix, ipfsGateway])
    if (url) allowed.add(url.origin);

  const isVfsContent = (url: URL) =>
    !!vfs && url.origin === vfs.origin && VFS_FILE_CONTENT.test(url.pathname);

  /**
   * `ipfs://<cid>[/path]` on the gateway. The check runs on the URL as parsed
   * (dot segments, encoded ones like `%2e%2e` included, are already resolved
   * there): the path must stay under the gateway's `/ipfs/` and name a CID
   * first. The URI as written may carry no query, fragment or dot segment.
   */
  const ipfsTarget = (gateway: URL, path: string): URL => {
    const base = gateway.pathname.replace(/\/$/, '');
    let url: URL;
    try {
      url = new URL(`${gateway.origin}${base}/ipfs/${path}`);
    } catch {
      throw new Error('invalid-ipfs-uri');
    }
    const prefix = `${base}/ipfs/`;
    const segments = url.pathname.startsWith(prefix)
      ? url.pathname.slice(prefix.length).split('/')
      : [];
    const [root] = segments;
    if (
      !path ||
      path.includes('?') ||
      path.includes('#') ||
      // A dot segment, plain or percent-encoded, anywhere in the URI as
      // written: the parser would resolve it away from the CID it names.
      path.split(/[\\/]/).some((segment) => /^(\.|%2e){1,2}$/i.test(segment)) ||
      url.origin !== gateway.origin ||
      url.search ||
      url.hash ||
      !root ||
      !isCid(root)
    )
      throw new Error('invalid-ipfs-uri');
    return url;
  };

  const target = (request: DocumentRequest): URL => {
    const uri = request.uri;
    if (uri.startsWith('ipfs://')) {
      if (!ipfsGateway) throw new Error('ipfs-gateway-unconfigured');
      return ipfsTarget(ipfsGateway, uri.slice('ipfs://'.length));
    }
    try {
      return new URL(uri);
    } catch {
      throw new Error('unsupported-document-uri');
    }
  };

  return {
    isPublic(request) {
      if (request.private) return false;
      try {
        // A VFS read carries the user's bearer even for a "public" anchor.
        return !isVfsContent(target(request));
      } catch {
        return true;
      }
    },

    async resolve(did, signal) {
      if (!blocksync) throw new Error('iid-unavailable');
      const response = await fetch(blocksync, {
        method: 'POST',
        redirect: 'error',
        signal,
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ query: IID_QUERY, variables: { id: did } }),
      });
      const body = iidResponse.safeParse(
        JSON.parse(
          new TextDecoder().decode(
            await boundedBytes(response, INDEX_MAX_BYTES),
          ),
        ),
      );
      if (!body.success || body.data.errors?.length)
        throw new Error('iid-unavailable');
      const nodes = body.data.data.iids.nodes;
      const node = nodes[0];
      if (nodes.length !== 1 || node?.id !== did)
        throw new Error('iid-unavailable');
      const linked = node.linkedResource ?? [];
      if (!Array.isArray(linked)) throw new Error('invalid-anchor-resources');
      const candidates: unknown[] = linked;
      const matches = domainResources.safeParse(
        candidates.filter(
          (entry) =>
            !!entry &&
            typeof entry === 'object' &&
            'id' in entry &&
            (entry.id === `${did}#dom` || entry.id === '{id}#dom'),
        ),
      );
      if (!matches.success) throw new Error('invalid-anchor-resources');
      const [resource, ...rest] = matches.data;
      if (!resource) return null;
      // Both the full and the shorthand form present: refuse rather than pick one.
      if (rest.length) throw new Error('invalid-anchor-ambiguous');
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
        ? AbortSignal.any([
            callerSignal,
            AbortSignal.timeout(DOCUMENT_READ_TIMEOUT_MS),
          ])
        : AbortSignal.timeout(DOCUMENT_READ_TIMEOUT_MS);
      const url = target(request);
      const vfsContent = isVfsContent(url);
      if (request.private && !vfsContent) {
        if (!options.readPrivateDocument)
          throw new Error('private-reader-unavailable');
        const bytes = await options.readPrivateDocument(request, ctx, signal);
        if (bytes.length > request.maxBytes)
          throw new Error('document-too-large');
        return bytes;
      }
      if (
        url.protocol !== 'https:' ||
        url.username ||
        url.password ||
        !allowed.has(url.origin)
      )
        throw new Error('document-origin-denied');
      const headers: Record<string, string> = {};
      if (vfsContent && vfs) {
        if (!ucanStore) throw new Error('private-reader-unavailable');
        const bearer = await vfsBearer(
          ctx,
          {
            VFS_BASE_URL: vfs.href,
            UCAN_STORE_URL: ucanStore.href,
            VFS_MAX_READ_LINES: positiveNumber(
              ctx.config.VFS_MAX_READ_LINES,
              2000,
            ),
            VFS_REQUEST_TIMEOUT_MS: positiveNumber(
              ctx.config.VFS_REQUEST_TIMEOUT_MS,
              DOCUMENT_READ_TIMEOUT_MS,
            ),
          },
          'fs/read',
        );
        if ('error' in bearer) throw new Error('document-access-denied');
        headers.Authorization = `Bearer ${bearer.bearer}`;
      } else if (
        !request.private &&
        matrix &&
        url.origin === matrix.origin &&
        MATRIX_MEDIA_DOWNLOAD.test(url.pathname)
      ) {
        // Authenticated media: the legacy unauthenticated paths are rewritten
        // to the client v1 endpoint and fetched as the oracle's own device.
        const credentials = await ctx.matrix.botCredentials();
        if (new URL(credentials.baseUrl).origin !== url.origin)
          throw new Error('matrix-origin-mismatch');
        url.pathname = url.pathname.replace(
          /^\/_matrix\/media\/v[13]\/download\//,
          '/_matrix/client/v1/media/download/',
        );
        headers.Authorization = `Bearer ${credentials.accessToken}`;
      }
      return boundedBytes(
        await fetch(url, { headers, redirect: 'error', signal }),
        request.maxBytes,
      );
    },
  };
}

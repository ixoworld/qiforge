/**
 * Which Matrix homeserver does a user live on?
 *
 * The user↔oracle room alias is `#<user>_<oracle>:<SERVER>` where SERVER is the
 * USER's homeserver, not the oracle's — an oracle on `mx.example` serving a
 * user registered on `devmx.ixo.earth` must look the room up as
 * `#…:devmx.ixo.earth`. The Node runtime reads it per user from the DID
 * document's `MatrixHomeServer` service via Blocksync
 * (`getMatrixHomeServerCroppedForDid`); this is the Workers port, with the
 * same normalisation of the user-supplied `serviceEndpoint`.
 */

export const MATRIX_SERVICE_TYPE = 'MatrixHomeServer';

export interface DidService {
  id?: string;
  type?: string;
  serviceEndpoint?: string;
}

/**
 * On-chain `serviceEndpoint` values are registration-supplied and have been
 * seen with trailing slashes and stray whitespace/CRLF. Strip whitespace, add
 * `https://` to bare domains, drop trailing slashes. "" for empty input.
 */
export function normalizeMatrixHomeServerUrl(
  url: string | null | undefined,
): string {
  if (!url) return '';
  const trimmed = url.replace(/\s+/g, '');
  if (trimmed === '') return '';
  const withProtocol = /^https?:\/\//.test(trimmed)
    ? trimmed
    : `https://${trimmed}`;
  return withProtocol.replace(/\/+$/, '');
}

/** `https://devmx.ixo.earth/` → `devmx.ixo.earth` (the Matrix server name). */
export function extractUrlDomain(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    const cleaned = url.replace(/^https?:\/\//, '');
    return cleaned.split('/')[0] ?? cleaned;
  }
}

/** The server name from a DID document's services, or null when it has none. */
export function matrixServerNameFromServices(
  services: readonly DidService[] | null | undefined,
): string | null {
  const svc = (services ?? []).find((s) => s.type === MATRIX_SERVICE_TYPE);
  const normalized = normalizeMatrixHomeServerUrl(svc?.serviceEndpoint);
  if (!normalized) return null;
  const domain = extractUrlDomain(normalized);
  return domain ? domain.toLowerCase() : null;
}

const IID_SERVICES_QUERY = `
  query UserMatrixHomeServer($id: String!) {
    iids(filter: { id: { equalTo: $id } }) {
      nodes { id service }
    }
  }
`;

/**
 * Resolve a user's Matrix server name from Blocksync. Returns null when the
 * DID is unknown or carries no MatrixHomeServer service; throws on transport
 * failure so callers can decide whether to fall back.
 */
export async function fetchUserMatrixServerName(
  blocksyncGraphqlUrl: string,
  userDid: string,
  fetchImpl: typeof fetch = fetch,
): Promise<string | null> {
  const res = await fetchImpl(blocksyncGraphqlUrl, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      query: IID_SERVICES_QUERY,
      variables: { id: userDid },
    }),
  });
  if (!res.ok) {
    throw new Error(
      `Blocksync ${res.status} resolving MatrixHomeServer for ${userDid}`,
    );
  }
  const raw: unknown = await res.json();
  const body = raw as {
    data?: { iids?: { nodes?: Array<{ id: string; service?: unknown }> } };
    errors?: Array<{ message?: string }>;
  };
  if (body.errors?.length) {
    throw new Error(
      `Blocksync error resolving MatrixHomeServer for ${userDid}: ${body.errors[0]?.message ?? 'unknown'}`,
    );
  }
  const node = body.data?.iids?.nodes?.[0];
  if (!node) return null;
  const services: DidService[] = Array.isArray(node.service)
    ? node.service
    : [];
  return matrixServerNameFromServices(services);
}

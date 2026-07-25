import { type LinkedResource } from '@ixo/impactxclient-sdk/codegen/ixo/iid/v1beta1/types';
import { gqlClient } from 'src/gql/index.js';
import { type TGetSettingsResourceSchema } from '../client/entities/types.js';

type ProtocolEntity = Awaited<
  ReturnType<typeof gqlClient.GetEntityById>
>['entity'];

// Every settings resource on the same protocol (authz `#orz`, pricing `#fee`,
// …) resolves the identical entity document, and callers fetch them side by
// side — so entity lookups are deduped in-flight and briefly cached instead of
// hitting blocksync once per resource. Failures are evicted immediately.
const ENTITY_CACHE_TTL_MS = 60_000;
const entityFetchCache = new Map<
  string,
  { promise: Promise<ProtocolEntity>; at: number }
>();

function getEntityByIdCached(protocolDid: string): Promise<ProtocolEntity> {
  const cached = entityFetchCache.get(protocolDid);
  if (cached && Date.now() - cached.at < ENTITY_CACHE_TTL_MS) {
    return cached.promise;
  }

  const promise = gqlClient
    .GetEntityById({ id: protocolDid })
    .then((result) => result?.entity);
  entityFetchCache.set(protocolDid, { promise, at: Date.now() });
  promise.catch(() => {
    if (entityFetchCache.get(protocolDid)?.promise === promise) {
      entityFetchCache.delete(protocolDid);
    }
  });
  return promise;
}

function rewriteMatrixMediaUrl(url: string, matrixHomeServer: string): string {
  const mediaMatch = url.match(
    /https?:\/\/[^/]+\/_matrix\/media\/[^/]+\/download\/([^/]+)\/(.+)/,
  );
  if (!mediaMatch) return url;

  const [, serverName, mediaId] = mediaMatch;
  return `https://${matrixHomeServer}/_matrix/client/v1/media/download/${serverName}/${mediaId}`;
}

/**
 * Find one `linkedResource` on a protocol/entity document, or `undefined` when
 * the entity has no matching entry. Callers that treat a missing resource as an
 * error (the settings lane) raise it themselves; callers for which "not
 * published" is a normal state (the agent card) just get `undefined`.
 *
 * Returns the resource itself rather than its document so callers can read the
 * on-chain `proof` — the opaque version string that identifies which revision
 * of the document they resolved.
 */
export async function findLinkedResource(
  protocolDid: string,
  matches: (resource: LinkedResource) => boolean,
): Promise<LinkedResource | undefined> {
  const protocol = await getEntityByIdCached(protocolDid);
  if (!protocol) {
    throw new Error('Protocol not found with did: ' + protocolDid);
  }
  const linkedResources = (protocol.linkedResource ?? []) as LinkedResource[];
  return linkedResources.find(matches);
}

/**
 * Fetch a linked resource's document from its `serviceEndpoint`. Matrix-hosted
 * documents are rewritten onto the caller's homeserver and sent with its access
 * token — newer Synapse releases refuse anonymous reads on the legacy
 * `/_matrix/media/…/download` path.
 */
export async function fetchLinkedResourceDoc<T>(
  resource: LinkedResource,
  matrixAccessToken?: string,
  matrixHomeServer?: string,
): Promise<T> {
  const url = matrixHomeServer
    ? rewriteMatrixMediaUrl(resource.serviceEndpoint, matrixHomeServer)
    : resource.serviceEndpoint;
  const response = await fetch(url, {
    headers: {
      'Content-Type': 'application/json',
      ...(matrixAccessToken
        ? { Authorization: `Bearer ${matrixAccessToken}` }
        : {}),
    },
  });
  const data = await response.json();
  return data as T;
}

export async function getSettingsResource<T>(
  settingsResourceParams: TGetSettingsResourceSchema,
  matrixAccessToken?: string,
  matrixHomeServer?: string,
): Promise<T> {
  const resource = await findLinkedResource(
    settingsResourceParams.protocolDid,
    (candidate) =>
      candidate.id === settingsResourceParams.id ||
      candidate.type === settingsResourceParams.type,
  );
  if (!resource) {
    throw new Error('Resource not found');
  }

  return fetchLinkedResourceDoc<T>(
    resource,
    matrixAccessToken,
    matrixHomeServer,
  );
}

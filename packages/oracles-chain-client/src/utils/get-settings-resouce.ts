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

export async function getSettingsResource<T>(
  settingsResourceParams: TGetSettingsResourceSchema,
  matrixAccessToken?: string,
  matrixHomeServer?: string,
): Promise<T> {
  const protocol = await getEntityByIdCached(
    settingsResourceParams.protocolDid,
  );
  if (!protocol) {
    throw new Error(
      'Protocol not found with did: ' + settingsResourceParams.protocolDid,
    );
  }
  const settingsResource = protocol?.linkedResource as LinkedResource[];
  const resource = settingsResource.find(
    (resource) =>
      resource.id === settingsResourceParams.id ||
      resource.type === settingsResourceParams.type,
  );
  if (!resource) {
    throw new Error('Resource not found');
  }

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

import { type LinkedResource } from '@ixo/impactxclient-sdk/codegen/ixo/iid/v1beta1/types';
import { gqlClient } from 'src/gql/index.js';
import { type TGetSettingsResourceSchema } from '../client/entities/types.js';

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
  const protocol = (
    await gqlClient.GetEntityById({ id: settingsResourceParams.protocolDid })
  )?.entity;
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

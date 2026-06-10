/* eslint-disable no-console */
import { request } from '../utils/request.js';
import { decryptAndRetrieve, encryptAndStore } from '../utils/token-cache.js';
import {
  getMatrixUrlsForDid,
  normalizeMatrixHomeServerUrl,
} from '@ixo/oracles-chain-client/react';
import {
  type IOpenIDToken,
  type SourceSpaceResponse,
  type CreateAndJoinOracleRoomPayload,
  type JoinSpaceOrRoomPayload,
  type MatrixClientConstructorParams,
  type MatrixPowerLevels,
  type MatrixRoomMembersResponse,
  type SourceSpacePayload,
} from './types.js';

function getEntityRoomAliasFromDid(did: string) {
  return did.replace(/:/g, '-');
}

function extractHomeServerFromUserId(userId: string): string {
  const colonIndex = userId.indexOf(':');
  if (colonIndex === -1) {
    throw new Error(`Invalid Matrix user ID format: ${userId}`);
  }
  return `https://${userId.substring(colonIndex + 1)}`;
}

/**
 * MatrixClient for user operations in the browser.
 *
 * Methods support DID-based URL resolution for decoupled Matrix infrastructure.
 * When a userDid is provided, the homeserver is resolved from the DID document.
 * When no userDid is provided, constructor defaults are used (backwards compatible).
 */
class MatrixClient {
  constructor(public readonly params: MatrixClientConstructorParams) {
    this.params.appServiceBotUrl =
      this.params.appServiceBotUrl ??
      MatrixRoomBotServerUrl[chainNetwork ?? 'devnet'];
    this.params.homeserverUrl =
      this.params.homeserverUrl ??
      MatrixHomeServerUrl[chainNetwork ?? 'devnet'];

    if (!this.params.appServiceBotUrl || !this.params.homeserverUrl) {
      throw new Error('Matrix client params are not valid');
    }
  }

  private async resolveHomeServerUrl(userDid?: string): Promise<string> {
    if (userDid) {
      const matrixUrls = await getMatrixUrlsForDid(userDid);
      return matrixUrls.homeServer;
    }
    return (
      normalizeMatrixHomeServerUrl(this.params.homeserverUrl) ||
      this.params.homeserverUrl!
    );
  }

  private async resolveRoomsBotUrl(userDid?: string): Promise<string> {
    if (userDid) {
      const matrixUrls = await getMatrixUrlsForDid(userDid);
      return matrixUrls.roomsBot;
    }
    return this.params.appServiceBotUrl!;
  }

  public async sourceMainSpaceWithDid(payload: SourceSpacePayload): Promise<{
    mainSpaceId: string;
    subSpaces: string[];
  }> {
    const roomsBotUrl = await this.resolveRoomsBotUrl(payload.userDid);
    const url = `${roomsBotUrl}/spaces/source`;
    const response = await request<SourceSpaceResponse>(url, 'POST', {
      body: JSON.stringify({
        did: payload.userDid,
      }),
    });

    const subSpaces = Object.keys(response.subspaces).reduce<string[]>(
      (acc, key) => {
        const spaceId =
          response.subspaces[key as keyof typeof response.subspaces]?.space_id;
        if (spaceId) acc.push(spaceId);
        return acc;
      },
      [],
    );

    return {
      mainSpaceId: response.space_id,
      subSpaces,
    };
  }

  public async joinSpaceOrRoomWithDid(
    payload: JoinSpaceOrRoomPayload & { userDid?: string },
  ): Promise<string> {
    try {
      const homeServerUrl = await this.resolveHomeServerUrl(payload.userDid);
      const url = `${homeServerUrl}/_matrix/client/v3/join/${payload.roomId}`;

      const response = await request<{ room_id: string }>(url, 'POST', {
        headers: {
          Authorization: `Bearer ${this.params.userAccessToken}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({}),
      });

      return decodeURIComponent(response.room_id);
    } catch (error) {
      console.error('Error joining room:', error);
      throw error;
    }
  }

  public async createAndJoinOracleRoomWithDid(
    payload: CreateAndJoinOracleRoomPayload,
  ): Promise<string> {
    const roomsBotUrl = await this.resolveRoomsBotUrl(payload.userDid);
    const url = `${roomsBotUrl}/spaces/oracle/create`;
    const response = await request<{ roomId: string }>(url, 'POST', {
      body: JSON.stringify({
        did: payload.userDid,
        oracleDid: payload.oracleEntityDid,
      }),
      headers: {
        Authorization: `Bearer ${this.params.userAccessToken}`,
        'Content-Type': 'application/json',
      },
    });

    return this.joinSpaceOrRoomWithDid({
      roomId: response.roomId,
      userDid: payload.userDid,
    });
  }

  public async inviteUserWithDid(
    roomId: string,
    userId: string,
    userDid?: string,
  ): Promise<void> {
    const homeServerUrl = await this.resolveHomeServerUrl(userDid);
    const url = `${homeServerUrl}/_matrix/client/v3/rooms/${encodeURIComponent(roomId)}/invite`;
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${this.params.userAccessToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ user_id: userId }),
    });
    if (!res.ok) {
      const errText = await res.text();
      throw new Error(
        `Failed to invite ${userId} to ${roomId}: ${res.status} ${errText}`,
      );
    }
  }

  public async setPowerLevelWithDid(
    roomId: string,
    userId: string,
    powerLevel: number,
    userDid?: string,
  ): Promise<void> {
    const homeServerUrl = await this.resolveHomeServerUrl(userDid);

    const getUrl = `${homeServerUrl}/_matrix/client/v3/rooms/${encodeURIComponent(roomId)}/state/m.room.power_levels`;
    let res = await fetch(getUrl, {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${this.params.userAccessToken}`,
        'Content-Type': 'application/json',
      },
    });
    if (!res.ok) {
      const errText = await res.text();
      throw new Error(`Failed to fetch power levels: ${res.status} ${errText}`);
    }
    const plEvent = (await res.json()) as MatrixPowerLevels;

    plEvent.users = plEvent.users || {};
    plEvent.users[userId] = powerLevel;

    const putUrl = `${homeServerUrl}/_matrix/client/v3/rooms/${encodeURIComponent(roomId)}/state/m.room.power_levels`;
    res = await fetch(putUrl, {
      method: 'PUT',
      headers: {
        Authorization: `Bearer ${this.params.userAccessToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(plEvent),
    });
    if (!res.ok) {
      const errText = await res.text();
      throw new Error(`Failed to set power level: ${res.status} ${errText}`);
    }
  }

  public async getOracleRoomIdWithDid({
    userDid,
    oracleEntityDid,
  }: {
    userDid: string;
    oracleEntityDid: string;
  }): Promise<string | null> {
    const matrixUrls = await getMatrixUrlsForDid(userDid);
    const hostname = matrixUrls.homeServerCropped;
    const oracleRoomAlias = `${getEntityRoomAliasFromDid(userDid)}_${getEntityRoomAliasFromDid(oracleEntityDid)}`;
    const oracleRoomFullAlias = `#${oracleRoomAlias}:${hostname}`;

    const url = `${matrixUrls.homeServer}/_matrix/client/v3/directory/room/${encodeURIComponent(oracleRoomFullAlias)}`;
    const res = await fetch(url, {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${this.params.userAccessToken}`,
        'Content-Type': 'application/json',
      },
    });

    if (!res.ok) {
      if (res.status === 404) return null;
      const errText = await res.text();
      throw new Error(`Failed to get oracle room id: ${res.status} ${errText}`);
    }

    const data = (await res.json()) as { room_id: string; servers: string[] };
    return data.room_id;
  }

  public async listRoomMembersWithDid(
    roomId: string,
    userDid?: string,
  ): Promise<string[]> {
    const homeServerUrl = await this.resolveHomeServerUrl(userDid);
    const url = `${homeServerUrl}/_matrix/client/v3/rooms/${encodeURIComponent(roomId)}/members`;
    const res = await fetch(url, {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${this.params.userAccessToken}`,
        'Content-Type': 'application/json',
      },
    });
    if (!res.ok) {
      const errText = await res.text();
      throw new Error(`Failed to list room members: ${res.status} ${errText}`);
    }
    const data = (await res.json()) as MatrixRoomMembersResponse;
    return data.chunk.map((member) => member.user_id);
  }

  public async getOpenIdTokenWithDid(
    userId: string,
    userDid: string,
    useCache: boolean = true,
  ): Promise<IOpenIDToken> {
    try {
      if (!this.params.userAccessToken) {
        throw new Error('User access token not found');
      }

      if (!userId) {
        throw new Error('User ID not found');
      }

      if (!userDid) {
        throw new Error('User DID not found');
      }

      if (useCache) {
        try {
          const cachedToken = await decryptAndRetrieve({
            did: userDid,
            matrixAccessToken: this.params.userAccessToken,
          });
          if (cachedToken) {
            console.debug('Using cached OpenID token for user:', userId);
            return cachedToken;
          }
        } catch (error) {
          console.warn('Failed to retrieve cached token:', error);
        }
      }

      const homeServerUrl = extractHomeServerFromUserId(userId);

      console.debug('Generating new OpenID token for user:', userId);
      const response = await fetch(
        `${homeServerUrl}/_matrix/client/v3/user/${encodeURIComponent(userId)}/openid/request_token`,
        {
          method: 'POST',
          body: JSON.stringify({}),
          headers: {
            Authorization: `Bearer ${this.params.userAccessToken}`,
            'Content-Type': 'application/json',
          },
        },
      );

      if (response.ok) {
        const openIdToken = (await response.json()) as IOpenIDToken;

        if (useCache) {
          try {
            await encryptAndStore({
              token: openIdToken,
              matrixAccessToken: this.params.userAccessToken,
              did: userDid,
            });
            console.debug(
              'OpenID token generated and cached for user:',
              userId,
            );
          } catch (error) {
            console.warn('Failed to cache token:', error);
          }
        } else {
          console.debug(
            'OpenID token generated (caching disabled) for user:',
            userId,
          );
        }

        return openIdToken;
      } else {
        const errText = await response.text();
        throw new Error(
          `Failed to get OpenID token: ${response.status} ${response.statusText} ${errText}`,
        );
      }
    } catch (error) {
      console.error('Failed to get OpenID token:', error);
      throw error;
    }
  }
}

export default MatrixClient;

const MatrixRoomBotServerUrl = {
  devnet: 'https://rooms.bot.devmx.ixo.earth',
  testnet: 'https://rooms.bot.testmx.ixo.earth',
  mainnet: 'https://rooms.bot.mx.ixo.earth',
};

const MatrixHomeServerUrl = {
  devnet: 'https://devmx.ixo.earth',
  testnet: 'https://testmx.ixo.earth',
  mainnet: 'https://mx.ixo.earth',
};
const chainNetwork = process.env
  .NEXT_PUBLIC_CHAIN_NETWORK as keyof typeof MatrixRoomBotServerUrl;

import { Logger } from '@ixo/logger';
import {
  createMatrixApiClient,
  createMatrixClaimBotClient,
  createMatrixRoomBotClient,
  createMatrixStateBotClient,
} from '@ixo/matrixclient-sdk';
import {
  getMatrixUrlsForDid,
  getMatrixHomeServerCroppedForDid,
} from './did-matrix-batcher.js';
import {
  MATRIX_BOT_RESOURCES,
  type GetUcanToken,
} from './ucan-token-provider.js';

export interface MatrixConfig {
  botUrl: string;
  accessToken: string;
  roomId: string;
}

export class MatrixBotService {
  private accessToken?: string;
  private getUcanToken?: GetUcanToken;

  constructor(accessToken?: string, getUcanToken?: GetUcanToken) {
    this.accessToken = accessToken;
    this.getUcanToken = getUcanToken;
  }

  private async requireUcanToken(
    did: string,
    bot: keyof typeof MATRIX_BOT_RESOURCES,
  ): Promise<string> {
    if (!this.getUcanToken) {
      throw new Error(
        'A UCAN token provider is required for authenticated bot operations. ' +
          'Pass getUcanToken (see createUcanTokenProvider) to the MatrixBotService constructor.',
      );
    }
    // getMatrixUrlsForDid caches per DID, so this lookup is shared with the
    // bot-client getters rather than duplicated work.
    const matrixUrls = await getMatrixUrlsForDid(did);
    return this.getUcanToken(matrixUrls[bot], MATRIX_BOT_RESOURCES[bot]);
  }

  private async getStateBotForDid(did: string) {
    const matrixUrls = await getMatrixUrlsForDid(did);
    return createMatrixStateBotClient({
      botUrl: matrixUrls.stateBot,
      accessToken: this.accessToken,
      homeServerUrl: matrixUrls.homeServer,
    });
  }

  private async getApiClientForDid(did: string) {
    const matrixUrls = await getMatrixUrlsForDid(did);
    return createMatrixApiClient({
      homeServerUrl: matrixUrls.homeServer,
    });
  }

  private async getClaimBotForDid(did: string) {
    const matrixUrls = await getMatrixUrlsForDid(did);
    return createMatrixClaimBotClient({
      botUrl: matrixUrls.claimBot,
      accessToken: this.accessToken,
      homeServerUrl: matrixUrls.homeServer,
    });
  }

  private async getRoomBotForDid(did: string) {
    const matrixUrls = await getMatrixUrlsForDid(did);
    return createMatrixRoomBotClient({
      botUrl: matrixUrls.roomsBot,
      accessToken: this.accessToken ?? '',
      homeServerUrl: matrixUrls.homeServer,
    });
  }

  async getWithDid<T>(
    did: string,
    roomId: string,
    key: string,
    path?: string,
  ): Promise<T | Record<string, T>> {
    try {
      const ucanToken = await this.requireUcanToken(did, 'stateBot');
      const stateBot = await this.getStateBotForDid(did);
      const response = await stateBot.state.v1beta1.queryState(
        roomId,
        key,
        path ?? '',
        ucanToken,
      );
      return response.data as T | Record<string, T>;
    } catch (error) {
      Logger.error(
        `Error fetching data from type "${key}" with key "${path}" for DID "${did}":`,
        error,
      );
      throw new Error('Failed to retrieve data.');
    }
  }

  async getRoomIdFromAliasWithDid(entityDid: string): Promise<string> {
    const homeServerCropped = await getMatrixHomeServerCroppedForDid(entityDid);
    const daoRoomAlias = `#${entityDid.replaceAll(/:/g, '-')}:${homeServerCropped}`;
    const apiClient = await this.getApiClientForDid(entityDid);
    const response = await apiClient.room.v1beta1.queryId(daoRoomAlias);
    return response.room_id;
  }

  async getRoomAliasWithDid(did: string): Promise<string> {
    const homeServerCropped = await getMatrixHomeServerCroppedForDid(did);
    return `#${did.replaceAll(/:/g, '-')}:${homeServerCropped}`;
  }

  async getRoomByDidWithDid(entityDid: string): Promise<string | void> {
    if (!entityDid) throw new Error('Entity DID is required');
    const roomAlias = await this.getRoomAliasWithDid(entityDid);
    const apiClient = await this.getApiClientForDid(entityDid);

    try {
      const { room_id } = await apiClient.room.v1beta1.queryId(roomAlias);
      return room_id;
    } catch (error) {
      Logger.error('Error getting room by DID', { error });
      throw new Error(`[getRoomByDid] Error getting room by DID`);
    }
  }

  async sourceRoomAndJoinWithDid(entityDid: string): Promise<string> {
    try {
      const ucanToken = await this.requireUcanToken(entityDid, 'roomsBot');
      const roomBot = await this.getRoomBotForDid(entityDid);
      const sourceRoomResponse = await roomBot.room.v1beta1.sourceRoomAndJoin(
        entityDid,
        ucanToken,
      );

      const claimBot = await this.getClaimBotForDid(entityDid);
      await claimBot.bot.v1beta1.invite(sourceRoomResponse.roomId);
      return sourceRoomResponse.roomId;
    } catch (error) {
      Logger.error('Error sourcing room and joining', { error });
      throw new Error(`[sourceRoomAndJoin] Error sourcing room and joining`);
    }
  }

  async inviteClaimBotWithDid(entityDid: string, roomId: string) {
    try {
      const claimBot = await this.getClaimBotForDid(entityDid);
      await claimBot.bot.v1beta1.invite(roomId);
      return 'ok';
    } catch (error) {
      Logger.error('Error inviting bot', { error });
      throw new Error(`[inviteClaimBot] Error inviting bot: ${error}`);
    }
  }

  async saveClaimToMatrixWithDid(
    entityDid: string,
    collectionId: string,
    claim: unknown,
  ) {
    try {
      const ucanToken = await this.requireUcanToken(entityDid, 'claimBot');
      const claimBot = await this.getClaimBotForDid(entityDid);
      const claimToStr = JSON.stringify(claim);
      const response = await claimBot.claim.v1beta1.saveClaim(
        collectionId,
        claimToStr,
        ucanToken,
      );
      return response;
    } catch (error) {
      throw new Error(
        `[saveClaimToMatrix] Error saving claim to matrix: ${error}`,
      );
    }
  }

  async getClaimBodyWithDid(
    entityDid: string,
    collectionId: string,
    claimId: string,
  ) {
    const ucanToken = await this.requireUcanToken(entityDid, 'claimBot');
    const claimBot = await this.getClaimBotForDid(entityDid);
    const claimBody = await claimBot.claim.v1beta1.queryClaim(
      collectionId,
      claimId,
      ucanToken,
    );
    return claimBody;
  }
}

import { MatrixManager } from '@ixo/matrix';
import { getMatrixHomeServerCroppedForDid } from '@ixo/oracles-chain-client';
import { Controller, Get, Logger, Req } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import type { Request } from 'express';
import {
  UserPreferencesService,
  type UserPreferences,
} from './service/user-preferences.service.js';

/**
 * Exposes the per-room user preferences read endpoint. Lives inside the
 * plugin (not the runtime core) — the plugin's `getNestModules()` wires
 * this controller into Nest only when the plugin is loaded.
 *
 * Writes happen via the agent's `set_user_preferences` tool (the
 * plugin-supplied LLM tool), not over HTTP — keeping the surface narrow.
 */
@ApiTags('user-preferences')
@Controller('user-preferences')
export class UserPreferencesController {
  private readonly logger = new Logger(UserPreferencesController.name);

  constructor(private readonly configService: ConfigService) {}

  @Get()
  @ApiOperation({
    summary: 'Get user preferences for the user↔oracle Matrix room.',
  })
  @ApiResponse({
    status: 200,
    description:
      'Preferences object, or null when no preferences have been set yet.',
  })
  @ApiResponse({ status: 401, description: 'Missing or invalid auth token.' })
  async getPreferences(@Req() req: Request): Promise<UserPreferences | null> {
    const { did } = req.authData;
    const oracleEntityDid =
      this.configService.getOrThrow<string>('ORACLE_ENTITY_DID');

    const userHomeServer = await getMatrixHomeServerCroppedForDid(did);

    const { roomId } =
      await MatrixManager.getInstance().getOracleRoomIdWithHomeServer({
        userDid: did,
        oracleEntityDid,
        userHomeServer,
      });

    if (!roomId) {
      this.logger.warn(
        `Could not resolve user↔oracle room for userDid=${did}, oracleEntityDid=${oracleEntityDid}, userHomeServer=${userHomeServer}`,
      );
      return null;
    }

    const prefs = await UserPreferencesService.getInstance().get(roomId);
    this.logger.log(
      `Fetched user preferences for userDid=${did}, roomId=${roomId}: ${prefs ? 'Found' : 'null'}`,
    );
    return prefs ?? null;
  }
}

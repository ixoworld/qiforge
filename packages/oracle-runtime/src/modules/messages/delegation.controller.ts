import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Logger,
  NotFoundException,
  Post,
  Req,
} from '@nestjs/common';
import { ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import type { Request } from 'express';
import { UcanService } from '../ucan/ucan.service.js';
import { StoreDelegationDto } from './dto/store-delegation.dto.js';

/**
 * Accepts a freshly-signed user→oracle UCAN delegation from the client and
 * persists it durably (Matrix room state) plus warms the in-memory cache.
 * The FE re-auth popup POSTs here. `AuthHeaderMiddleware` runs on every route
 * and sets `req.authData.did`, so the user is already authenticated. The
 * canonical user↔oracle room is resolved inside `UcanService`, so the store
 * and the Matrix read-through can never target different rooms.
 */
@ApiTags('delegation')
@Controller('delegation')
export class DelegationController {
  private readonly logger = new Logger(DelegationController.name);

  constructor(private readonly ucan: UcanService) {}

  @Post()
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Store a user→oracle UCAN delegation for the authenticated user.',
  })
  @ApiResponse({ status: 200, description: 'Delegation stored.' })
  @ApiResponse({ status: 401, description: 'Missing or invalid auth token.' })
  @ApiResponse({ status: 404, description: 'User↔oracle room not found.' })
  async storeDelegation(
    @Req() req: Request,
    @Body() body: StoreDelegationDto,
  ): Promise<{ ok: true; expiration?: number }> {
    const { did } = req.authData;

    try {
      await this.ucan.storeDelegationForUser(did, body.raw, {
        issuer: body.issuer,
        audience: body.audience,
        expiration: body.expiration,
      });
    } catch (error) {
      this.logger.warn(
        `Failed to store delegation for userDid=${did}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
      throw new NotFoundException('User↔oracle room not found');
    }

    this.logger.log(`Stored delegation for userDid=${did}`);
    return { ok: true, expiration: body.expiration };
  }

  @Get()
  @ApiOperation({
    summary:
      'Whether the authenticated user has authorized this oracle for Matrix.',
  })
  @ApiResponse({ status: 200, description: 'Authorization status.' })
  @ApiResponse({ status: 401, description: 'Missing or invalid auth token.' })
  async getStatus(
    @Req() req: Request,
  ): Promise<{ authorized: boolean; expiration?: number }> {
    return this.ucan.getDelegationStatus(req.authData.did);
  }

  @Delete()
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Revoke the stored delegation for the authenticated user.',
  })
  @ApiResponse({ status: 200, description: 'Delegation revoked.' })
  @ApiResponse({ status: 401, description: 'Missing or invalid auth token.' })
  async revokeDelegation(@Req() req: Request): Promise<{ ok: true }> {
    await this.ucan.revokeDelegationForUser(req.authData.did);
    this.logger.log(`Revoked delegation for userDid=${req.authData.did}`);
    return { ok: true };
  }
}

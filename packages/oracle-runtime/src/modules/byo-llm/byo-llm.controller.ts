import {
  BadGatewayException,
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Logger,
  NotFoundException,
  Param,
  Post,
  Put,
  Query,
  Req,
} from '@nestjs/common';
import { ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import type { Request } from 'express';
import * as crypto from 'node:crypto';
import {
  BYO_DEFAULT_MODEL,
  toByoModelId,
  type ByoProvider,
} from '../../llm/byo-catalog.js';
import { ByoLlmService, type ByoProviderStatus } from './byo-llm.service.js';
import {
  buildAuthorizeUrl,
  ChatGptOAuthError,
  createPkcePair,
  exchangeAuthorizationCode,
  pollDeviceToken,
  startDeviceAuthorization,
} from './chatgpt-oauth.js';
import {
  ApiKeySaveDto,
  CodeExchangeDto,
  DevicePollDto,
  ProviderParamDto,
} from './dto/byo-llm.dto.js';

/**
 * Connect surface for bring-your-own-credential LLMs. Active only on
 * deployments with `BYO_LLM_ENABLED=true` (the personal companion) — on every
 * other oracle these routes 404. All routes run behind `AuthHeaderMiddleware`
 * (UCAN), so `req.authData.did` is the authenticated user.
 *
 * API keys are saved here too (`PUT credentials/:provider`) — the oracle
 * encrypts them to its own key and writes the room secret itself, exactly
 * like the OAuth tokens. A client-side write through the agent-secrets flow
 * would depend on Matrix room-key sharing from the user's browser device to
 * the oracle's device (often across federated homeservers); when that
 * to-device message goes missing the oracle receives ciphertext it can never
 * read. The oracle decrypts the key on every BYO turn anyway, so posting it
 * over TLS adds no exposure. The rest is the ChatGPT OAuth handshake (tokens
 * never touch the browser), status, validation, and disconnects.
 */
@ApiTags('byo-llm')
@Controller('byo-llm')
export class ByoLlmController {
  private readonly logger = new Logger(ByoLlmController.name);

  constructor(private readonly byoLlm: ByoLlmService) {}

  private ensureEnabled(): void {
    if (!this.byoLlm.isEnabled()) {
      throw new NotFoundException(
        'Bring-your-own-credential LLMs are not enabled on this oracle',
      );
    }
  }

  @Get('status')
  @ApiOperation({
    summary:
      'Per-provider connection status and the picker entries for connected providers.',
  })
  @ApiResponse({ status: 200, description: 'BYO status.' })
  async status(
    @Req() req: Request,
    @Query('refresh') refresh?: string,
  ): Promise<{ enabled: boolean; providers: ByoProviderStatus[] }> {
    return this.byoLlm.status(req.authData.did, undefined, {
      refresh: refresh === 'true' || refresh === '1',
    });
  }

  @Post('chatgpt/device/start')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary:
      'Start the ChatGPT device-authorization flow. 502 when the device flow is unavailable (client falls back to the pasted-redirect flow).',
  })
  @ApiResponse({ status: 200, description: 'Device authorization started.' })
  @ApiResponse({ status: 502, description: 'Device flow unavailable.' })
  async deviceStart(@Req() req: Request): Promise<{
    deviceAuthId: string;
    userCode: string;
    verificationUri: string;
    expiresIn: number;
    interval: number;
  }> {
    this.ensureEnabled();
    try {
      const authorization = await startDeviceAuthorization(
        this.byoLlm.chatGptClientId,
      );
      await this.byoLlm.bindDeviceAuth(
        req.authData.did,
        authorization.deviceAuthId,
      );
      return authorization;
    } catch (error) {
      if (
        error instanceof ChatGptOAuthError &&
        error.code === 'device_flow_unavailable'
      ) {
        throw new BadGatewayException(error.message);
      }
      throw error;
    }
  }

  @Post('chatgpt/device/poll')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary:
      'Poll the device grant once. On success the tokens are stored and the turn-ready default model id is returned.',
  })
  @ApiResponse({ status: 200, description: 'Poll result.' })
  async devicePoll(
    @Req() req: Request,
    @Body() body: DevicePollDto,
  ): Promise<
    | { status: 'pending' }
    | { status: 'connected'; defaultModelId: string }
    | { status: 'failed'; error: string }
  > {
    this.ensureEnabled();
    // The flow must have been started by this account in this process — a
    // poll for someone else's (or an unknown) device-auth id can neither
    // complete the grant nor capture the resulting tokens.
    const isOwner = await this.byoLlm.isDeviceAuthOwner(
      req.authData.did,
      body.deviceAuthId,
    );
    if (!isOwner) {
      return {
        status: 'failed',
        error: 'Unknown or expired sign-in attempt — please start again.',
      };
    }
    const result = await pollDeviceToken({
      clientId: this.byoLlm.chatGptClientId,
      deviceAuthId: body.deviceAuthId,
      userCode: body.userCode,
    });
    if (result.status === 'pending') return { status: 'pending' };
    if (result.status === 'failed') {
      return { status: 'failed', error: result.error };
    }
    try {
      await this.byoLlm.storeChatGptTokens(req.authData.did, result.tokens);
    } catch (error) {
      // The sign-in itself succeeded and the authorization code is spent —
      // failing here would force a full restart of the flow. Hold the tokens
      // in memory instead; the service retries persistence in the background.
      this.logger.error(
        `Could not persist ChatGPT tokens for ${req.authData.did} — holding in memory: ${error instanceof Error ? error.message : String(error)}`,
      );
      await this.byoLlm.holdUnpersistedChatGptTokens(
        req.authData.did,
        result.tokens,
      );
    }
    this.logger.log(`ChatGPT subscription connected for ${req.authData.did}`);
    return {
      status: 'connected',
      defaultModelId: toByoModelId('chatgpt', BYO_DEFAULT_MODEL.chatgpt),
    };
  }

  @Get('chatgpt/authorize-url')
  @ApiOperation({
    summary:
      'Authorize URL + PKCE verifier for the pasted-redirect fallback flow.',
  })
  @ApiResponse({ status: 200, description: 'Authorize URL minted.' })
  authorizeUrl(): { url: string; codeVerifier: string; state: string } {
    this.ensureEnabled();
    const { codeVerifier, codeChallenge } = createPkcePair();
    const state = crypto.randomBytes(32).toString('base64url');
    return {
      url: buildAuthorizeUrl({
        clientId: this.byoLlm.chatGptClientId,
        codeChallenge,
        state,
      }),
      codeVerifier,
      state,
    };
  }

  @Post('chatgpt/exchange')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary:
      'Exchange an authorization code from the pasted redirect URL; stores the tokens on success.',
  })
  @ApiResponse({ status: 200, description: 'Subscription connected.' })
  @ApiResponse({ status: 502, description: 'Exchange rejected upstream.' })
  async exchange(
    @Req() req: Request,
    @Body() body: CodeExchangeDto,
  ): Promise<{ connected: true; defaultModelId: string }> {
    this.ensureEnabled();
    let tokens;
    try {
      tokens = await exchangeAuthorizationCode({
        clientId: this.byoLlm.chatGptClientId,
        code: body.code,
        codeVerifier: body.codeVerifier,
      });
    } catch (error) {
      if (error instanceof ChatGptOAuthError) {
        throw new BadGatewayException(error.message);
      }
      throw error;
    }
    try {
      await this.byoLlm.storeChatGptTokens(req.authData.did, tokens);
    } catch (error) {
      // Same as the device path: the code is spent and the sign-in worked —
      // hold the tokens rather than failing a completed authentication.
      this.logger.error(
        `Could not persist ChatGPT tokens for ${req.authData.did} — holding in memory: ${error instanceof Error ? error.message : String(error)}`,
      );
      await this.byoLlm.holdUnpersistedChatGptTokens(req.authData.did, tokens);
    }
    this.logger.log(`ChatGPT subscription connected for ${req.authData.did}`);
    return {
      connected: true,
      defaultModelId: toByoModelId('chatgpt', BYO_DEFAULT_MODEL.chatgpt),
    };
  }

  @Post('validate/:provider')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary:
      'Live-check a stored credential (cheap provider call / token freshness).',
  })
  @ApiResponse({ status: 200, description: 'Validation result.' })
  async validate(
    @Req() req: Request,
    @Param() params: ProviderParamDto,
  ): Promise<{ valid: boolean; error?: string }> {
    this.ensureEnabled();
    return this.byoLlm.validate(req.authData.did, params.provider);
  }

  @Put('credentials/:provider')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary:
      'Save a provider API key (server-encrypted into the canonical room).',
  })
  @ApiResponse({ status: 200, description: 'API key stored.' })
  async saveApiKey(
    @Req() req: Request,
    @Param() params: ProviderParamDto,
    @Body() body: ApiKeySaveDto,
  ): Promise<{ ok: true; provider: ByoProvider }> {
    this.ensureEnabled();
    if (params.provider === 'chatgpt') {
      throw new BadRequestException(
        'ChatGPT connects via OAuth, not an API key',
      );
    }
    const apiKey = body.apiKey.trim();
    if (!apiKey) {
      throw new BadRequestException('API key must not be empty');
    }
    await this.byoLlm.storeApiKey(req.authData.did, params.provider, apiKey);
    this.logger.log(
      `BYO API key for ${params.provider} stored for ${req.authData.did}`,
    );
    return { ok: true, provider: params.provider };
  }

  @Delete('credentials/:provider')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary:
      'Disconnect a provider: clears the stored credential and its caches.',
  })
  @ApiResponse({ status: 200, description: 'Credential removed.' })
  async disconnect(
    @Req() req: Request,
    @Param() params: ProviderParamDto,
  ): Promise<{ ok: true; provider: ByoProvider }> {
    this.ensureEnabled();
    await this.byoLlm.deleteCredential(req.authData.did, params.provider);
    this.logger.log(
      `BYO credential ${params.provider} disconnected for ${req.authData.did}`,
    );
    return { ok: true, provider: params.provider };
  }
}

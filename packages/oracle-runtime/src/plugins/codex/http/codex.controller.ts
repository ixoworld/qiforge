import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Inject,
  Logger,
  NotFoundException,
  Post,
  Req,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import type { Request } from 'express';
import { z } from 'zod';
import {
  CODEX_APPROVAL_DECISIONS,
  type CodexApprovalDecision,
} from '../app-server/protocol.js';
import type { CodexConnectionSnapshot } from '../auth/connection-state.js';
import { describeCodexAuthMode } from '../domain/capabilities.js';
import {
  CODEX_AUTH_MODES,
  CODEX_PROVIDER_DISPLAY_NAME,
  CODEX_PROVIDER_ID,
  isAuthActionable,
  type CodexAuthMode,
  type CodexTenantScope,
} from '../domain/provider.js';
import type { CodexRuntimeRegistry } from '../session/registry.js';
import { CODEX_REGISTRY } from './codex.tokens.js';
import { createRoomSecretReader } from './room-secret-reader.js';

const authModeBody = z.object({ mode: z.enum(CODEX_AUTH_MODES) });
const approvalBody = z.object({
  approvalId: z.string().min(1),
  decision: z.enum(CODEX_APPROVAL_DECISIONS),
});

/** Provider descriptor + live connection state, as rendered by a settings UI. */
export interface CodexProviderStatus {
  provider: string;
  displayName: string;
  authMode: CodexAuthMode;
  authModeDescription: string;
  status: CodexConnectionSnapshot['status'];
  /** True when the user can fix the current status by (re)authenticating. */
  actionRequired: boolean;
  capabilities: {
    runtimeThreads: boolean;
    directModelApi: boolean;
    billing: 'subscription' | 'usage_based';
    modelOverride: boolean;
  };
  detail?: string;
  authorizationUrl?: string;
  threadId: string | null;
  pendingApprovals: number;
}

/**
 * Settings + control surface for the Codex provider.
 *
 * Every route is tenant-scoped from the authenticated DID — a caller can only
 * ever read or mutate its own runtime. Responses are credential-free by
 * construction: the API key and ChatGPT tokens never leave the process.
 */
@ApiTags('codex')
@Controller('codex')
export class CodexController {
  private readonly logger = new Logger(CodexController.name);

  constructor(
    @Inject(CODEX_REGISTRY) private readonly registry: CodexRuntimeRegistry,
    private readonly config: ConfigService,
  ) {}

  private scope(req: Request): CodexTenantScope {
    return {
      userDid: req.authData.did,
      oracleEntityDid: this.config.getOrThrow<string>('ORACLE_ENTITY_DID'),
    };
  }

  private describe(req: Request): CodexProviderStatus {
    const scope = this.scope(req);
    const session = this.registry.for(scope);
    const snapshot = session.snapshot();
    const { capabilities } = this.registry.plan();

    return {
      provider: CODEX_PROVIDER_ID,
      displayName: CODEX_PROVIDER_DISPLAY_NAME,
      authMode: snapshot.authMode,
      authModeDescription: describeCodexAuthMode(snapshot.authMode),
      status: snapshot.status,
      actionRequired: isAuthActionable(snapshot.status),
      capabilities: { ...capabilities },
      ...(snapshot.detail ? { detail: snapshot.detail } : {}),
      ...(snapshot.authorizationUrl
        ? { authorizationUrl: snapshot.authorizationUrl }
        : {}),
      threadId: session.currentThreadId(),
      pendingApprovals: this.registry.pendingApprovals(scope).length,
    };
  }

  @Get('status')
  @ApiOperation({ summary: 'Codex provider status for the calling user.' })
  @ApiResponse({ status: 200, description: 'Provider descriptor and status.' })
  getStatus(@Req() req: Request): CodexProviderStatus {
    return this.describe(req);
  }

  @Get('transitions')
  @ApiOperation({
    summary: 'Audit trail of Codex connection transitions for this user.',
  })
  getTransitions(@Req() req: Request) {
    return { transitions: this.registry.for(this.scope(req)).history() };
  }

  @Post('connect')
  @ApiOperation({
    summary:
      'Start (or re-authorize) the Codex runtime using the configured auth mode.',
  })
  async connect(@Req() req: Request): Promise<CodexProviderStatus> {
    const scope = this.scope(req);
    try {
      await this.registry.connect(scope, {
        secrets: createRoomSecretReader(scope),
      });
    } catch (error) {
      // The status carries the reason; a failed connect is a state, not a 500.
      this.logger.warn(
        `codex connect failed for ${scope.userDid}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
    return this.describe(req);
  }

  @Post('disconnect')
  @ApiOperation({ summary: 'Stop the Codex runtime for this user.' })
  async disconnect(@Req() req: Request): Promise<CodexProviderStatus> {
    await this.registry.disconnect(this.scope(req));
    return this.describe(req);
  }

  @Post('auth-mode')
  @ApiOperation({
    summary:
      'Switch between ChatGPT subscription and API key access. Always explicit — never inferred.',
  })
  async setAuthMode(
    @Req() req: Request,
    @Body() body: unknown,
  ): Promise<CodexProviderStatus> {
    const parsed = authModeBody.safeParse(body);
    if (!parsed.success) {
      throw new BadRequestException(
        `mode must be one of: ${CODEX_AUTH_MODES.join(', ')}`,
      );
    }
    const session = this.registry.for(this.scope(req));
    if (session.snapshot().authMode === parsed.data.mode) {
      return this.describe(req);
    }
    await session.setAuthMode(parsed.data.mode);
    return this.describe(req);
  }

  @Get('approvals')
  @ApiOperation({ summary: 'Approvals Codex is currently blocked on.' })
  listApprovals(@Req() req: Request) {
    return { approvals: this.registry.pendingApprovals(this.scope(req)) };
  }

  @Post('approvals')
  @ApiOperation({
    summary: 'Answer a pending Codex approval. Never auto-granted server-side.',
  })
  resolveApproval(@Req() req: Request, @Body() body: unknown) {
    const parsed = approvalBody.safeParse(body);
    if (!parsed.success) {
      throw new BadRequestException(
        `approvalId is required and decision must be one of: ${CODEX_APPROVAL_DECISIONS.join(', ')}`,
      );
    }
    const decision: CodexApprovalDecision = parsed.data.decision;
    const settled = this.registry.resolveApproval(
      this.scope(req),
      parsed.data.approvalId,
      decision,
    );
    if (!settled) {
      throw new NotFoundException(
        'No pending approval with that id for this user.',
      );
    }
    return { approvalId: parsed.data.approvalId, decision };
  }
}

import { GraphEventEmitter, rootEventEmitter } from '@ixo/oracles-events';
import { Logger, Optional } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ApiOperation, ApiResponse } from '@nestjs/swagger';
import {
  ConnectedSocket,
  MessageBody,
  SubscribeMessage,
  WebSocketGateway,
  WebSocketServer,
  type OnGatewayConnection,
  type OnGatewayDisconnect,
  type OnGatewayInit,
} from '@nestjs/websockets';
import { Server, Socket } from 'socket.io';

import { validateUcanDelegation } from '../auth/validate-ucan-delegation.js';
import {
  DEFAULT_UCAN_AUTH_MAX_TTL_SECONDS,
  validateUcanInvocation,
} from '../auth/validate-ucan-invocation.js';
import { UcanService } from '../ucan/ucan.service.js';
import { WsService } from './ws.service.js';

@WebSocketGateway({
  cors: {
    origin: '*',
  },
  namespace: '/',
})
export class WsGateway
  implements OnGatewayConnection, OnGatewayDisconnect, OnGatewayInit
{
  @WebSocketServer()
  server!: Server;

  private readonly logger = new Logger(WsGateway.name);

  constructor(
    private readonly wsService: WsService,
    private readonly configService: ConfigService,
    @Optional() private readonly ucanService?: UcanService,
  ) {}

  afterInit(): void {
    this.logger.log('WebSocket gateway initialized');
    GraphEventEmitter.registerEventHandlers(this.server);
  }

  async handleConnection(client: Socket): Promise<void> {
    const sessionId = client.handshake.query.sessionId;

    if (!sessionId || typeof sessionId !== 'string') {
      this.logger.error(
        `WebSocket connection attempt without sessionId from ${client.id}`,
      );
      client.disconnect();
      return;
    }

    // Authenticate the handshake the same way HTTP requests are: a user-signed
    // UCAN invocation is the primary auth (a bare delegation is accepted as a
    // migration fallback), and the identity is the *validated invoker* — never
    // the `userDid` the client put in the query. Trusting the query (the old
    // behaviour) let any client impersonate another user and poison the per-DID
    // delegation cache.
    const invocation = client.handshake.auth?.invocation as string | undefined;
    const ucanDelegation = client.handshake.auth?.ucanDelegation as
      | string
      | undefined;

    if (!invocation && !ucanDelegation) {
      this.logger.warn(
        `WebSocket connection rejected for session ${sessionId}: missing UCAN auth (client: ${client.id})`,
      );
      client.disconnect();
      return;
    }

    const oracleDid = this.configService.get<string>('ORACLE_DID');
    if (!oracleDid) {
      this.logger.error(
        'WebSocket auth unavailable: ORACLE_DID not configured — rejecting connection',
      );
      client.disconnect();
      return;
    }
    const blocksyncUri = this.configService.getOrThrow<string>(
      'BLOCKSYNC_GRAPHQL_URL',
    );

    // Validate the delegation once (if sent): used for downstream authorization
    // and as the auth fallback for pre-invocation clients.
    const delegationOutcome = ucanDelegation
      ? await validateUcanDelegation(ucanDelegation, {
          oracleDid,
          blocksyncUri,
        })
      : null;
    if (delegationOutcome && !delegationOutcome.ok) {
      this.logger.warn(
        `WebSocket delegation invalid for session ${sessionId}: ${delegationOutcome.error} (client: ${client.id})`,
      );
    }
    const validDelegation =
      delegationOutcome && delegationOutcome.ok
        ? delegationOutcome.result
        : null;

    // Authenticated identity: invocation (primary) → delegation (fallback).
    let userDid: string | null = null;
    if (invocation) {
      const maxTtlSeconds =
        Number(this.configService.get('UCAN_AUTH_MAX_TTL_SECONDS')) ||
        DEFAULT_UCAN_AUTH_MAX_TTL_SECONDS;
      const invOutcome = await validateUcanInvocation(invocation, {
        oracleDid,
        blocksyncUri,
        maxTtlSeconds,
      });
      if (!invOutcome.ok) {
        this.logger.warn(
          `WebSocket connection rejected for session ${sessionId}: ${invOutcome.error} (client: ${client.id})`,
        );
        client.disconnect();
        return;
      }
      userDid = invOutcome.result.userDid;
    } else if (validDelegation) {
      userDid = validDelegation.userDid;
    }

    if (!userDid) {
      this.logger.warn(
        `WebSocket connection rejected for session ${sessionId}: no valid UCAN auth (client: ${client.id})`,
      );
      client.disconnect();
      return;
    }

    // Stash the validated identity on the socket so disconnect-time history
    // processing reads the authenticated DID rather than the untrusted query.
    client.data.userDid = userDid;

    this.logger.log(
      `WebSocket connection established for session: ${sessionId}, did: ${userDid}, client: ${client.id}`,
    );

    // Cache the delegation for downstream invocations — but only when it was
    // issued by the authenticated user (delegations are public; never act on
    // someone else's just because a client presented it).
    if (
      this.ucanService &&
      validDelegation &&
      validDelegation.userDid === userDid
    ) {
      await this.ucanService.cacheDelegation(
        userDid,
        ucanDelegation as string,
        validDelegation.delegation.expiration,
      );
    } else if (validDelegation && validDelegation.userDid !== userDid) {
      this.logger.warn(
        `WebSocket ignoring delegation for downstream: issuer ${validDelegation.userDid} != authenticated ${userDid}`,
      );
    }

    // Join the sessionId room (channel) — this is the key integration!
    await client.join(sessionId);

    this.wsService.addClientConnection(sessionId, client);

    client.emit('connected', {
      message: 'Connected successfully',
      sessionId,
      timestamp: new Date().toISOString(),
    });
  }

  handleDisconnect(client: Socket): void {
    const sessionId = client.handshake.query.sessionId as string;

    if (sessionId) {
      this.logger.log(
        `WebSocket connection closed for session: ${sessionId}, client: ${client.id}`,
      );
      void this.wsService.removeClientConnection(sessionId, client);
    } else {
      this.logger.warn(
        `WebSocket disconnected without sessionId: ${client.id}`,
      );
    }
  }

  @SubscribeMessage('ping')
  handlePing(@ConnectedSocket() client: Socket): void {
    client.emit('pong', {
      timestamp: new Date().toISOString(),
      sessionId: client.handshake.query.sessionId as string,
    });
  }

  @SubscribeMessage('status')
  handleStatus(@ConnectedSocket() client: Socket): void {
    client.emit('status', {
      connected: true,
      sessionId: client.handshake.query.sessionId as string,
      activeSessions: this.wsService.getActiveSessionsCount(),
      totalConnections: this.wsService.getTotalConnectionsCount(),
      timestamp: new Date().toISOString(),
    });
  }

  /**
   * Forward a tool/action result back to LangGraph via the root event emitter.
   */
  private handleFrontendToolResult(
    client: Socket,
    data: {
      toolCallId: string;
      result?: unknown;
      error?: string;
      sessionId?: string;
    },
    eventType: 'browser_tool_result' | 'action_call_result',
  ): void {
    const sessionId = client.handshake.query.sessionId as string;
    const toolId = data.toolCallId;

    this.logger.log(
      `${eventType} received for session: ${sessionId}, toolId: ${toolId}`,
    );

    rootEventEmitter.emit(eventType, {
      sessionId,
      ...data,
      timestamp: new Date().toISOString(),
    });
  }

  @SubscribeMessage('tool_result')
  @ApiOperation({
    summary: 'Handle Tool Result',
    description:
      'Receive tool execution result from client and forward to LangGraph',
  })
  @ApiResponse({
    status: 200,
    description: 'Tool result received successfully',
  })
  handleToolResult(
    @ConnectedSocket() client: Socket,
    @MessageBody()
    data: { toolCallId: string; result: unknown; error?: string },
  ): void {
    this.handleFrontendToolResult(client, data, 'browser_tool_result');
  }

  @SubscribeMessage('action_call_result')
  @ApiOperation({
    summary: 'Handle AG-UI Action Result',
    description:
      'Receive AG-UI action execution result from client and forward to LangGraph',
  })
  @ApiResponse({
    status: 200,
    description: 'Action result received successfully',
  })
  handleActionCallResult(
    @ConnectedSocket() client: Socket,
    @MessageBody()
    data: { sessionId: string; toolCallId: string; result: unknown },
  ): void {
    this.handleFrontendToolResult(client, data, 'action_call_result');
  }

  @SubscribeMessage('list-events')
  @ApiOperation({
    summary: 'List Available Events',
    description: 'Get a list of all available WebSocket events',
  })
  @ApiResponse({
    status: 200,
    description: 'List of available events',
  })
  handleListEvents(@ConnectedSocket() client: Socket): void {
    client.emit('available-events', {
      clientEvents: [
        'ping',
        'status',
        'subscribe',
        'list-events',
        'tool_result',
        'action_call_result',
      ],
      serverEvents: [
        'connected',
        'pong',
        'status',
        'subscribed',
        'available-events',
        // LangGraph events
        'render_component',
        'tool_call',
        'action_call',
        'browser_tool_call',
        'router_update',
        'message_cache_invalidation',
      ],
      sessionId: client.handshake.query.sessionId as string,
      timestamp: new Date().toISOString(),
    });
  }
}

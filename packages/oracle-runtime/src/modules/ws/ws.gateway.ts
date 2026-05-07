import { GraphEventEmitter, rootEventEmitter } from '@ixo/oracles-events';
import { Logger, Optional } from '@nestjs/common';
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
    @Optional() private readonly ucanService?: UcanService,
  ) {}

  afterInit(): void {
    this.logger.log('WebSocket gateway initialized');
    GraphEventEmitter.registerEventHandlers(this.server);
  }

  async handleConnection(client: Socket): Promise<void> {
    const sessionId = client.handshake.query.sessionId;
    const userDid = client.handshake.query.userDid;

    if (!sessionId || !userDid) {
      this.logger.error(
        `WebSocket connection attempt without ${sessionId ? 'sessionId' : ''} and ${userDid ? 'userDid' : ''} from ${client.id}`,
      );
      client.disconnect();
      return;
    }

    this.logger.log(
      `WebSocket connection established for session: ${sessionId}, client: ${client.id}`,
    );

    // Cache UCAN delegation from the client for use on disconnect (memory engine auth).
    const ucanDelegation = client.handshake.auth?.ucanDelegation as
      | string
      | undefined;
    if (ucanDelegation && this.ucanService) {
      await this.ucanService.cacheDelegation(userDid as string, ucanDelegation);
    }

    // Join the sessionId room (channel) — this is the key integration!
    await client.join(sessionId);

    this.wsService.addClientConnection(sessionId as string, client);

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

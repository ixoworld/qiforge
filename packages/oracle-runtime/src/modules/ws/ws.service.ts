import { type AllEvents } from '@ixo/oracles-events';
import {
  Injectable,
  Logger,
  type OnModuleDestroy,
  type OnModuleInit,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { type Socket } from 'socket.io';
import { SessionHistoryProcessor } from '../sessions/session-history-processor.service.js';
import { WS_SERVICE_EVENT_NAME, wsEmitter } from './emitter.js';

@Injectable()
export class WsService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(WsService.name);
  private readonly sessionConnections = new Map<string, Set<Socket>>();

  constructor(
    private readonly sessionHistoryProcessor: SessionHistoryProcessor,
    private readonly configService: ConfigService,
  ) {}

  /** Add a WebSocket connection for a specific session. */
  addClientConnection(sessionId: string, socket: Socket): void {
    if (!this.sessionConnections.has(sessionId)) {
      this.logger.log(`Creating new session for: ${sessionId}`);
      this.sessionConnections.set(sessionId, new Set());
    }

    const connections = this.sessionConnections.get(sessionId);
    connections?.add(socket);
    this.logger.log(
      `Added connection to session: ${sessionId}, total connections: ${connections?.size}`,
    );
  }

  /** Publish an event to all connections in a specific session. */
  publishToSession(sessionId: string, event: AllEvents): void {
    const connections = this.sessionConnections.get(sessionId);
    if (connections && connections.size > 0) {
      this.logger.log(
        `Publishing event to session: ${sessionId}, connections: ${connections.size}`,
      );
      connections.forEach((socket) => {
        if (socket.connected) {
          socket.emit('event', event);
        } else {
          connections.delete(socket);
        }
      });
      // A session fully drained of dead sockets here would otherwise keep
      // its empty Set in the map forever — `removeClientConnection` never
      // sees sockets that dropped without a disconnect event.
      if (connections.size === 0) {
        this.sessionConnections.delete(sessionId);
        this.logger.log(`Cleaned up drained session: ${sessionId}`);
      }
    } else {
      this.logger.warn(
        `Attempted to publish to non-existent session: ${sessionId}`,
      );
    }
  }

  /** Remove a client connection on disconnect. */
  async removeClientConnection(
    sessionId: string,
    socket: Socket,
  ): Promise<void> {
    const connections = this.sessionConnections.get(sessionId);
    if (connections) {
      connections.delete(socket);
      this.logger.log(
        `Removed connection from session: ${sessionId}, remaining: ${connections.size}`,
      );

      if (connections.size === 0) {
        this.sessionConnections.delete(sessionId);
        this.logger.log(`Cleaned up empty session: ${sessionId}`);
        const oracleEntityDid =
          this.configService.getOrThrow('ORACLE_ENTITY_DID');

        // Use the DID validated at handshake time (stashed on `socket.data`),
        // never the untrusted `handshake.query.userDid`.
        const did: string | undefined = socket.data?.userDid;
        if (!did) {
          this.logger.warn(
            `User DID not found for session ${sessionId}, skipping processing on disconnect`,
          );
          return;
        }

        // Process session history when last client disconnects
        this.sessionHistoryProcessor
          .processSessionHistory({
            sessionId,
            did,
            oracleEntityDid,
          })
          .catch((err) =>
            this.logger.error(
              `Failed to process session ${sessionId} on disconnect:`,
              err,
            ),
          );
      }
    }
  }

  /** Active sessions count for monitoring. */
  getActiveSessionsCount(): number {
    return this.sessionConnections.size;
  }

  /** Total connections count for monitoring. */
  getTotalConnectionsCount(): number {
    let total = 0;
    this.sessionConnections.forEach((connections) => {
      total += connections.size;
    });
    return total;
  }

  /**
   * Kept as a field so `onModuleDestroy` can unsubscribe — `wsEmitter` is a
   * module-level singleton, so a listener left behind pins the destroyed
   * service (and its whole connection map) for the life of the process.
   */
  private readonly onWsEvent = (event: AllEvents): void => {
    this.publishToSession(event.payload.sessionId, event);
  };

  onModuleInit(): void {
    this.logger.log('WebSocket service initialized');
    wsEmitter.on(WS_SERVICE_EVENT_NAME, this.onWsEvent);
  }

  onModuleDestroy(): void {
    this.logger.log('Cleaning up all WebSocket connections');
    wsEmitter.off(WS_SERVICE_EVENT_NAME, this.onWsEvent);
    this.sessionConnections.forEach((connections) => {
      connections.forEach((socket) => {
        socket.disconnect();
      });
    });
    this.sessionConnections.clear();
  }
}

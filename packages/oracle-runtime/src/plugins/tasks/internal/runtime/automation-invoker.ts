import { randomUUID } from 'node:crypto';
import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { MatrixManager } from '@ixo/matrix';
import { getMatrixHomeServerCroppedForDid } from '@ixo/oracles-chain-client';
import { MessagesService } from '../../../../modules/messages/messages.service.js';

export interface InvokeArgs {
  userDid: string;
  message: string;
  taskId: string;
  runId: string;
  modelTier?: 'low' | 'medium' | 'high';
}

export interface InvokeResult {
  output: string;
  /** The user's resolved "main" room — used by the room resolver when the
   *  task delivers to `delivery.roomId: 'main'`. Null if not discoverable. */
  mainRoomId: string | null;
}

/**
 * Calls `MessagesService` from the BullMQ worker so credits middleware,
 * capability gating, checkpointer — everything — applies unchanged.
 *
 * We use a synthetic per-task session id so task runs don't pollute the
 * user's main conversation thread.
 */
@Injectable()
export class AutomationInvoker {
  private readonly logger = new Logger(AutomationInvoker.name);

  constructor(
    private readonly messages: MessagesService,
    private readonly config: ConfigService,
  ) {}

  async invoke(args: InvokeArgs): Promise<InvokeResult> {
    const sessionId = `task-${args.taskId}-${args.runId}`;

    // Resolve the user's main room if we can. Falls back to null — the
    // worker will skip delivery for `delivery.roomId: 'main'` specs that
    // can't be routed.
    const mainRoomId = await this.resolveMainRoom(args.userDid);

    try {
      const reply = await this.messages.sendMessage({
        message: args.message,
        did: args.userDid,
        sessionId,
        stream: false,
        // Suppress Matrix replay — Tasks owns delivery and posts to the
        // configured room itself.
        msgFromMatrixRoom: true,
        clientType: 'matrix',
      });
      const output =
        typeof reply?.message?.content === 'string'
          ? reply.message.content
          : '';
      return { output, mainRoomId };
    } catch (err) {
      this.logger.error(
        `Task ${args.taskId} agent invocation failed: ${(err as Error).message}`,
      );
      throw err;
    }
  }

  private async resolveMainRoom(userDid: string): Promise<string | null> {
    try {
      const oracleEntityDid = this.config.get<string>('ORACLE_ENTITY_DID');
      if (!oracleEntityDid) return null;
      const homeServer = await getMatrixHomeServerCroppedForDid(userDid);
      if (!homeServer) return null;
      const { roomId } =
        await MatrixManager.getInstance().getOracleRoomIdWithHomeServer({
          userDid,
          oracleEntityDid,
          userHomeServer: homeServer,
        });
      return roomId ?? null;
    } catch (err) {
      this.logger.warn(
        `Failed to resolve main room for ${userDid}: ${(err as Error).message}`,
      );
      return null;
    }
  }
}

/**
 * `runId` helper for tests / callers needing the same ID across hops.
 */
export function newRunId(): string {
  return randomUUID();
}

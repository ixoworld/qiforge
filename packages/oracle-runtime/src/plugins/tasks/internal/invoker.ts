import { randomUUID } from 'node:crypto';
import { SessionManagerService } from '@ixo/common';
import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { MessagesService } from '../../../modules/messages/messages.service.js';

/**
 * Runs the main agent off-request by calling `MessagesService.sendMessage` —
 * the same entry point HTTP chat uses — so credits metering, capability
 * gating, and the checkpointer all apply unchanged.
 *
 * Sessions are created with a synthetic `overrideEventId`, which skips the
 * `"New Conversation Started"` Matrix post `SessionManagerService` would
 * otherwise make. The session row exists in SQLite long enough for
 * `RequestPreparer.prepare()` to resolve it, then we delete it. The user
 * never sees the task's internal session in their session list, and the
 * main Matrix room stays clean.
 *
 * Each run gets its own session, so there's no persistent task thread —
 * tasks are stateless across runs. That's fine: the spec body controls
 * what each run does, and the LLM has no need to recall a previous run.
 * (Memory across runs, if ever needed, is FOLLOWUP-11.)
 */
@Injectable()
export class AgentInvoker {
  private readonly logger = new Logger(AgentInvoker.name);

  constructor(
    private readonly messages: MessagesService,
    private readonly sessionManager: SessionManagerService,
    private readonly config: ConfigService,
  ) {}

  /**
   * Create a throwaway session, invoke the main agent on it with `message`,
   * delete the session, return the agent's output. Anchored in `roomId`
   * when provided (a dedicated task room); otherwise in the user's main
   * oracle room (resolved by `SessionManagerService`).
   *
   * Note: `roomId` here is purely the *session anchor* — `RequestPreparer`
   * uses it to satisfy its room-resolution check. Delivery to the task's
   * room is the worker's job, not this method's.
   */
  async runOnce(args: {
    did: string;
    message: string;
    roomId?: string;
  }): Promise<string> {
    const oracleEntityDid = this.config.getOrThrow<string>('ORACLE_ENTITY_DID');
    // Synthetic session id — Matrix never sees it. The leading `$` matches
    // Matrix event-id syntax so any sloppy consumer treats it as an event id.
    const sessionId = `$task-${randomUUID()}`;
    await this.sessionManager.createSession(
      {
        did: args.did,
        roomId: args.roomId,
        oracleName: this.config.getOrThrow<string>('ORACLE_NAME'),
        oracleDid: this.config.getOrThrow<string>('ORACLE_DID'),
        oracleEntityDid,
      },
      sessionId,
    );
    try {
      const reply = await this.messages.sendMessage({
        did: args.did,
        sessionId,
        message: args.message,
        stream: false,
        // Tasks own delivery — suppress Matrix replay of input and reply.
        msgFromMatrixRoom: true,
        clientType: 'matrix',
      });
      const content = reply?.message.content;
      if (typeof content !== 'string' || content.length === 0) {
        throw new Error('Agent returned no output');
      }
      return content;
    } finally {
      // Best-effort cleanup: an orphaned SQLite row is harmless (filtered
      // out of session lists by roomId) but we want to leave nothing.
      await this.sessionManager
        .deleteSession({ did: args.did, sessionId, oracleEntityDid })
        .catch((err) =>
          this.logger.warn(
            `Failed to delete task session ${sessionId}: ${(err as Error).message}`,
          ),
        );
    }
  }
}

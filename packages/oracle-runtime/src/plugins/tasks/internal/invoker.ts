import { SessionManagerService } from '@ixo/common';
import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { MessagesService } from '../../../modules/messages/messages.service.js';

/**
 * Runs the main agent off-request by calling `MessagesService` — the same
 * entry point HTTP chat uses — so credits metering, capability gating, and
 * the checkpointer all apply unchanged.
 *
 * Sessions are real (created via `SessionManagerService`, which posts the
 * thread root into the room and registers the row `RequestPreparer` looks
 * up). Each task owns ONE session for its lifetime: every run continues the
 * same LangGraph thread, giving the task memory across runs.
 */
@Injectable()
export class AgentInvoker {
  constructor(
    private readonly messages: MessagesService,
    private readonly sessionManager: SessionManagerService,
    private readonly config: ConfigService,
  ) {}

  /**
   * Create a session anchored in `roomId` (the task's dedicated room), or in
   * the user's main oracle room when omitted. Returns the session id.
   */
  async createSession(did: string, roomId?: string): Promise<string> {
    const session = await this.sessionManager.createSession({
      did,
      roomId,
      oracleName: this.config.getOrThrow<string>('ORACLE_NAME'),
      oracleDid: this.config.getOrThrow<string>('ORACLE_DID'),
      oracleEntityDid: this.config.getOrThrow<string>('ORACLE_ENTITY_DID'),
    });
    return session.sessionId;
  }

  async deleteSession(did: string, sessionId: string): Promise<void> {
    await this.sessionManager.deleteSession({
      did,
      sessionId,
      oracleEntityDid: this.config.getOrThrow<string>('ORACLE_ENTITY_DID'),
    });
  }

  /** One agent turn on the given session. Returns the assistant's text. */
  async run(args: {
    did: string;
    sessionId: string;
    message: string;
  }): Promise<string> {
    const reply = await this.messages.sendMessage({
      did: args.did,
      sessionId: args.sessionId,
      message: args.message,
      stream: false,
      // Tasks own delivery — suppress the Matrix replay of both the input
      // and the assistant reply (same flag the Matrix listener path uses).
      msgFromMatrixRoom: true,
      clientType: 'matrix',
    });
    const content = reply?.message.content;
    if (typeof content !== 'string' || content.length === 0) {
      throw new Error('Agent returned no output');
    }
    return content;
  }
}

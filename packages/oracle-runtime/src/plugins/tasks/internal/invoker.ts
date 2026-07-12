import { randomUUID } from 'node:crypto';
import { SessionManagerService } from '@ixo/common';
import type { BaseMessage } from '@langchain/core/messages';
import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { MessagesService } from '../../../modules/messages/messages.service.js';
import { TASK_SESSION_PREFIX } from './runtime.js';

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
 * A `never` task uses `runOnce`: a throwaway session, deleted right after,
 * so there's no persistent thread. A `before-action` task uses
 * `runConversational`: a persistent session the worker binds to the task's
 * room, so the user's reply continues the same thread and the agent — with
 * its own draft in the checkpointer history — performs (or revises) the
 * action on the follow-up turn.
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
   * delete the session, return the agent's output plus the run's thread
   * (read from the checkpointer before the session teardown erases it — the
   * verified-work hook serializes it into the claim's execution trace).
   * Anchored in `roomId` when provided (a dedicated task room); otherwise in
   * the user's main oracle room (resolved by `SessionManagerService`).
   *
   * Note: `roomId` here is purely the *session anchor* — `RequestPreparer`
   * uses it to satisfy its room-resolution check. Delivery to the task's
   * room is the worker's job, not this method's.
   */
  async runOnce(args: {
    did: string;
    message: string;
    roomId?: string;
  }): Promise<{ output: string; sessionId: string; messages: BaseMessage[] }> {
    const startedAt = Date.now();
    const oracleEntityDid = this.config.getOrThrow<string>('ORACLE_ENTITY_DID');
    // Synthetic session id — Matrix never sees it. The leading `$` matches
    // Matrix event-id syntax so any sloppy consumer treats it as an event id,
    // and the prefix is what shows up as the LangSmith thread id for the run.
    const sessionId = `${TASK_SESSION_PREFIX}${randomUUID()}`;
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
        // This session is deleted in the `finally` below; without this the
        // fire-and-forget post-sync races that delete and re-inserts the
        // synthetic session as an orphan in the user's main room.
        skipPostSync: true,
        clientType: 'matrix',
      });
      // When a middleware short-circuits the graph (e.g. the group-chat
      // gate), the tail of state is the input HumanMessage itself —
      // delivering that would post the spec body back as the "result".
      if (!reply || reply.message.type !== 'ai') {
        throw new Error('Agent did not produce a reply');
      }
      const content = reply.message.content;
      if (content.length === 0) {
        throw new Error('Agent returned no output');
      }
      // Best-effort: the thread only feeds trace capture, so a read failure
      // must not turn a delivered run into a failed one.
      let messages: BaseMessage[] = [];
      try {
        messages = await this.messages.getThreadMessages(args.did, sessionId);
      } catch (err) {
        this.logger.warn(
          `Could not read run thread for ${sessionId}: ${(err as Error).message}`,
        );
      }
      this.logger.log(
        `runOnce completed for ${args.did} (session ${sessionId}) in ${Date.now() - startedAt}ms`,
      );
      return { output: content, sessionId, messages };
    } finally {
      // Best-effort cleanup. This synthetic session lives in the user's main
      // room, so a leaked row would surface in their session list — delete it
      // (and its checkpointer thread, handled by deleteSession).
      await this.deleteSession(args.did, sessionId);
    }
  }

  /**
   * Run the main agent on a fresh, PERSISTENT session anchored in `roomId` and
   * return both its id and the agent's output. Unlike `runOnce`, the session
   * is NOT deleted: the worker binds the dedicated task room to it so the
   * user's plainly-typed reply continues this exact thread (the draft sits in
   * the checkpointer history, so the follow-up turn can act on it).
   *
   * The session id IS `anchorEventId` — the real Matrix event the worker
   * posted as the run marker — exactly like a normal chat session rooted at a
   * real event. Replies and replays thread under it natively; nothing about
   * this session needs special-casing downstream.
   */
  async runConversational(args: {
    did: string;
    roomId: string;
    anchorEventId: string;
    message: string;
  }): Promise<{ sessionId: string; output: string }> {
    const startedAt = Date.now();
    // The override skips the "New Conversation Started" post — the worker's
    // run marker already plays that role.
    const sessionId = args.anchorEventId;
    await this.sessionManager.createSession(
      {
        did: args.did,
        roomId: args.roomId,
        oracleName: this.config.getOrThrow<string>('ORACLE_NAME'),
        oracleDid: this.config.getOrThrow<string>('ORACLE_DID'),
        oracleEntityDid: this.config.getOrThrow<string>('ORACLE_ENTITY_DID'),
      },
      sessionId,
    );
    const reply = await this.messages.sendMessage({
      did: args.did,
      sessionId,
      message: args.message,
      stream: false,
      // The worker owns delivery (it posts the draft+ask itself) — suppress
      // Matrix replay of the spec body and the agent's reply.
      msgFromMatrixRoom: true,
      // Skip the post-turn session sync for the run itself: it would spend an
      // LLM call titling the thread on every scheduled fire. The user's later
      // turns on this session sync normally.
      skipPostSync: true,
      clientType: 'matrix',
    });
    if (!reply || reply.message.type !== 'ai') {
      throw new Error('Agent did not produce a reply');
    }
    const output = reply.message.content;
    if (output.length === 0) {
      throw new Error('Agent returned no output');
    }
    this.logger.log(
      `runConversational completed for ${args.did} (session ${sessionId}) in ${Date.now() - startedAt}ms`,
    );
    return { sessionId, output };
  }

  /** Best-effort session teardown — warns on failure rather than throwing. */
  async deleteSession(did: string, sessionId: string): Promise<void> {
    const oracleEntityDid = this.config.getOrThrow<string>('ORACLE_ENTITY_DID');
    await this.sessionManager
      .deleteSession({ did, sessionId, oracleEntityDid })
      .catch((err) =>
        this.logger.warn(
          `Failed to delete task session ${sessionId}: ${(err as Error).message}`,
        ),
      );
  }
}

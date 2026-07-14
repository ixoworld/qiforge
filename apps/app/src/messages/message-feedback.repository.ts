import type { Database as DatabaseType } from 'better-sqlite3';
import { BadRequestException, NotFoundException } from '@nestjs/common';
import type {
  MessageFeedback,
  MessageFeedbackResponse,
} from './dto/message-feedback.dto';

export function listMessageFeedback(
  db: DatabaseType,
  sessionId: string,
): Map<string, MessageFeedback> {
  const rows = db
    .prepare(
      `SELECT message_id, feedback
       FROM message_feedback
       WHERE session_id = ?`,
    )
    .all(sessionId) as Array<{
    message_id: string;
    feedback: MessageFeedback;
  }>;

  return new Map(rows.map((row) => [row.message_id, row.feedback]));
}

export function saveMessageFeedback(
  db: DatabaseType,
  params: {
    sessionId: string;
    messageId: string;
    feedback: MessageFeedback;
  },
): MessageFeedbackResponse {
  const now = new Date().toISOString();
  db.prepare(
    `INSERT INTO message_feedback (
       session_id, message_id, feedback, created_at, updated_at
     ) VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(session_id, message_id) DO UPDATE SET
       feedback = excluded.feedback,
       updated_at = excluded.updated_at`,
  ).run(params.sessionId, params.messageId, params.feedback, now, now);

  return { ...params, updatedAt: now };
}

export function clearMessageFeedback(
  db: DatabaseType,
  params: { sessionId: string; messageId: string },
): MessageFeedbackResponse {
  db.prepare(
    `DELETE FROM message_feedback
     WHERE session_id = ? AND message_id = ?`,
  ).run(params.sessionId, params.messageId);

  return {
    ...params,
    feedback: null,
    updatedAt: new Date().toISOString(),
  };
}

export function deleteSessionMessageFeedback(
  db: DatabaseType,
  sessionId: string,
): void {
  db.prepare('DELETE FROM message_feedback WHERE session_id = ?').run(
    sessionId,
  );
}

export function validateMessageFeedbackTarget<
  T extends {
    id: string;
    type: string;
    isComplete?: boolean;
  },
>(db: DatabaseType, sessionId: string, messageId: string, messages: T[]): T {
  const session = db
    .prepare('SELECT session_id FROM sessions WHERE session_id = ?')
    .get(sessionId) as { session_id: string } | undefined;
  if (!session) {
    throw new NotFoundException('Session not found');
  }

  const message = messages.find((candidate) => candidate.id === messageId);
  if (!message) {
    throw new NotFoundException('Message not found');
  }
  if (message.type !== 'ai' || message.isComplete === false) {
    throw new BadRequestException(
      'Feedback can only be recorded for completed Agent messages',
    );
  }

  return message;
}

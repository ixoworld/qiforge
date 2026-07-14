import Database from 'better-sqlite3';
import {
  clearMessageFeedback,
  deleteSessionMessageFeedback,
  listMessageFeedback,
  saveMessageFeedback,
  validateMessageFeedbackTarget,
} from './message-feedback.repository';
import { BadRequestException, NotFoundException } from '@nestjs/common';

describe('message feedback repository', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = new Database(':memory:');
    db.exec(`
      CREATE TABLE sessions (session_id TEXT PRIMARY KEY);
      CREATE TABLE message_feedback (
        session_id TEXT NOT NULL,
        message_id TEXT NOT NULL,
        feedback TEXT NOT NULL CHECK (feedback IN ('approved', 'disapproved')),
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        PRIMARY KEY (session_id, message_id)
      );
    `);
    db.prepare('INSERT INTO sessions (session_id) VALUES (?)').run('session-1');
  });

  afterEach(() => db.close());

  it('upserts and lists one feedback value per message', () => {
    saveMessageFeedback(db, {
      sessionId: 'session-1',
      messageId: 'message-1',
      feedback: 'approved',
    });
    saveMessageFeedback(db, {
      sessionId: 'session-1',
      messageId: 'message-1',
      feedback: 'disapproved',
    });

    expect(listMessageFeedback(db, 'session-1')).toEqual(
      new Map([['message-1', 'disapproved']]),
    );
  });

  it('clears one message without affecting the rest of the session', () => {
    saveMessageFeedback(db, {
      sessionId: 'session-1',
      messageId: 'message-1',
      feedback: 'approved',
    });
    saveMessageFeedback(db, {
      sessionId: 'session-1',
      messageId: 'message-2',
      feedback: 'disapproved',
    });

    const response = clearMessageFeedback(db, {
      sessionId: 'session-1',
      messageId: 'message-1',
    });
    expect(response.feedback).toBeNull();
    expect(listMessageFeedback(db, 'session-1')).toEqual(
      new Map([['message-2', 'disapproved']]),
    );
  });

  it('removes all feedback when a session is deleted', () => {
    saveMessageFeedback(db, {
      sessionId: 'session-1',
      messageId: 'message-1',
      feedback: 'approved',
    });

    deleteSessionMessageFeedback(db, 'session-1');
    expect(listMessageFeedback(db, 'session-1').size).toBe(0);
  });

  it('rejects missing sessions and messages', () => {
    expect(() =>
      validateMessageFeedbackTarget(db, 'another-session', 'agent-1', []),
    ).toThrow(NotFoundException);
    expect(() =>
      validateMessageFeedbackTarget(db, 'session-1', 'missing', []),
    ).toThrow(NotFoundException);
  });

  it('accepts only completed Agent messages', () => {
    const messages = [
      { id: 'human-1', type: 'human', isComplete: true },
      { id: 'agent-streaming', type: 'ai', isComplete: false },
      { id: 'agent-1', type: 'ai', isComplete: true },
    ];

    expect(() =>
      validateMessageFeedbackTarget(db, 'session-1', 'human-1', messages),
    ).toThrow(BadRequestException);
    expect(() =>
      validateMessageFeedbackTarget(
        db,
        'session-1',
        'agent-streaming',
        messages,
      ),
    ).toThrow(BadRequestException);
    expect(
      validateMessageFeedbackTarget(db, 'session-1', 'agent-1', messages),
    ).toMatchObject({ id: 'agent-1' });
  });

  it('isolates feedback to the authenticated user database', () => {
    const otherUserDb = new Database(':memory:');
    otherUserDb.exec(`
      CREATE TABLE sessions (session_id TEXT PRIMARY KEY);
      CREATE TABLE message_feedback (
        session_id TEXT NOT NULL,
        message_id TEXT NOT NULL,
        feedback TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        PRIMARY KEY (session_id, message_id)
      );
    `);

    expect(() =>
      validateMessageFeedbackTarget(otherUserDb, 'session-1', 'agent-1', [
        { id: 'agent-1', type: 'ai', isComplete: true },
      ]),
    ).toThrow(NotFoundException);
    otherUserDb.close();
  });
});

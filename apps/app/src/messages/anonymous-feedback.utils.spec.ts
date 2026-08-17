import { BadRequestException, NotFoundException } from '@nestjs/common';
import Database from 'better-sqlite3';
import {
  createAnonymousFeedbackFingerprint,
  normalizeFeedbackText,
  validateAnonymousFeedbackTarget,
} from './anonymous-feedback.utils';

describe('anonymous feedback privacy helpers', () => {
  it('trims feedback and rejects direct identifiers and credentials', () => {
    expect(normalizeFeedbackText('  The answer needs citations.  ')).toBe(
      'The answer needs citations.',
    );

    for (const feedback of [
      'Email me at person@example.com',
      'My Matrix ID is @person:matrix.example',
      'My DID is did:ixo:1234',
      'Use wallet ixo1qqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqq',
      'Call me on +1 415 555 2671',
      'api_key=secret-value',
      'See https://example.com/path?token=secret-value',
    ]) {
      expect(() => normalizeFeedbackText(feedback)).toThrow(
        BadRequestException,
      );
    }
  });

  it('creates stable, namespaced fingerprints without exposing source values', () => {
    const first = createAnonymousFeedbackFingerprint(
      'a-private-secret',
      'user',
      'did:ixo:user',
    );
    const second = createAnonymousFeedbackFingerprint(
      'a-private-secret',
      'user',
      'did:ixo:user',
    );

    expect(first).toBe(second);
    expect(first).toMatch(/^user_[a-f0-9]{64}$/);
    expect(first).not.toContain('did:ixo:user');
    expect(
      createAnonymousFeedbackFingerprint(
        'a-private-secret',
        'session',
        'did:ixo:user',
      ),
    ).not.toBe(first);
  });
});

describe('anonymous feedback target validation', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = new Database(':memory:');
    db.exec('CREATE TABLE sessions (session_id TEXT PRIMARY KEY);');
    db.prepare('INSERT INTO sessions (session_id) VALUES (?)').run('session-1');
  });

  afterEach(() => db.close());

  it('accepts only completed Agent messages in the authenticated user database', () => {
    const messages = [
      { id: 'human-1', type: 'human', isComplete: true },
      { id: 'agent-streaming', type: 'ai', isComplete: false },
      { id: 'agent-1', type: 'ai', isComplete: true },
    ];

    expect(() =>
      validateAnonymousFeedbackTarget(db, 'session-1', 'human-1', messages),
    ).toThrow(BadRequestException);
    expect(() =>
      validateAnonymousFeedbackTarget(
        db,
        'session-1',
        'agent-streaming',
        messages,
      ),
    ).toThrow(BadRequestException);
    expect(
      validateAnonymousFeedbackTarget(db, 'session-1', 'agent-1', messages),
    ).toMatchObject({ id: 'agent-1' });
  });

  it('rejects missing sessions and messages', () => {
    expect(() =>
      validateAnonymousFeedbackTarget(db, 'another-session', 'agent-1', []),
    ).toThrow(NotFoundException);
    expect(() =>
      validateAnonymousFeedbackTarget(db, 'session-1', 'missing', []),
    ).toThrow(NotFoundException);
  });
});

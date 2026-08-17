import { BadRequestException, NotFoundException } from '@nestjs/common';
import type { Database as DatabaseType } from 'better-sqlite3';
import { createHmac } from 'node:crypto';

const DIRECT_IDENTIFIER_PATTERNS: Array<{
  name: string;
  pattern: RegExp;
}> = [
  {
    name: 'email address',
    pattern: /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/i,
  },
  {
    name: 'Matrix identifier',
    pattern: /@[A-Z0-9._=-]+:[A-Z0-9.-]+/i,
  },
  {
    name: 'decentralized identifier',
    pattern: /\bdid:[a-z0-9]+:[A-Za-z0-9._:%-]+\b/i,
  },
  {
    name: 'wallet address',
    pattern: /\b(?:ixo|cosmos)1[0-9a-z]{20,}\b|\b0x[a-fA-F0-9]{40}\b/,
  },
  {
    name: 'phone number',
    pattern: /(?:^|\s)(?:\+?\d[\d\s().-]{7,}\d)(?:\s|$)/,
  },
  {
    name: 'credential',
    pattern:
      /-----BEGIN [A-Z ]*PRIVATE KEY-----|\b(?:api[_ -]?key|password|secret|token|authorization)\s*[:=]\s*\S+/i,
  },
  {
    name: 'secret-bearing URL',
    pattern:
      /https?:\/\/\S+[?&](?:access_token|api_key|apikey|auth|key|password|secret|token)=/i,
  },
];

export function normalizeFeedbackText(feedback: string): string {
  const normalized = feedback.trim();
  if (!normalized) {
    throw new BadRequestException('Feedback cannot be empty');
  }

  const match = DIRECT_IDENTIFIER_PATTERNS.find(({ pattern }) =>
    pattern.test(normalized),
  );
  if (match) {
    throw new BadRequestException({
      code: 'FEEDBACK_CONTAINS_PERSONAL_DATA',
      message:
        'Remove personal information, account identifiers, or secrets before submitting feedback',
    });
  }

  return normalized;
}

export function createAnonymousFeedbackFingerprint(
  secret: string,
  namespace: 'user' | 'session' | 'message' | 'rate-limit',
  ...parts: string[]
): string {
  const digest = createHmac('sha256', secret)
    .update([namespace, ...parts].join('\0'), 'utf8')
    .digest('hex');
  return `${namespace}_${digest}`;
}

export function validateAnonymousFeedbackTarget<
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
      'Feedback can only be submitted for completed Agent messages',
    );
  }

  return message;
}

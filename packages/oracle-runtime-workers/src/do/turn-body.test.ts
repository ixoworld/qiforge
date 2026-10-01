import { describe, expect, it } from 'vitest';
import { parseTurnBody, TURN_BODY_KEYS } from './turn-body';

describe('parseTurnBody', () => {
  it('accepts every SendMessageDto top-level field', () => {
    const body = {
      message: 'hi',
      stream: false,
      returnAllMessages: true,
      model: 'x',
      tools: [],
      agActions: [],
      metadata: { a: 1 },
      timezone: 'UTC',
      homeServer: 'https://mx',
      mcpInvocations: {},
      attachments: [],
      requestId: 'r1',
    };
    expect(Object.keys(body).every((k) => TURN_BODY_KEYS.has(k))).toBe(true);
    expect(parseTurnBody(JSON.stringify(body))).toEqual({ ok: true, body });
  });

  it('rejects malformed JSON with a 400 instead of throwing', () => {
    expect(parseTurnBody('{"message": "unterminated')).toEqual({
      ok: false,
      status: 400,
      message: 'Invalid JSON body',
    });
  });

  it.each(['null', '[]', '"str"', '42'])(
    'rejects non-object body %s',
    (raw) => {
      expect(parseTurnBody(raw)).toEqual({
        ok: false,
        status: 400,
        message: 'Request body must be a JSON object',
      });
    },
  );

  it('rejects unknown top-level fields like forbidNonWhitelisted', () => {
    expect(
      parseTurnBody(
        JSON.stringify({ message: 'hi', systemPromptOverride: 'x' }),
      ),
    ).toEqual({
      ok: false,
      status: 400,
      message: 'property systemPromptOverride should not exist',
    });
  });

  it.each(['{}', '{"message":""}', '{"message":7}'])(
    'requires a non-empty string message (%s)',
    (raw) => {
      expect(parseTurnBody(raw)).toEqual({
        ok: false,
        status: 400,
        message: 'message is required',
      });
    },
  );
});

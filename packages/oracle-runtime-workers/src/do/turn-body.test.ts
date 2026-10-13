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
    // The fields the runtime ignores are accepted and not passed on.
    const read = Object.fromEntries(
      Object.entries(body).filter(
        ([key]) => !['homeServer', 'mcpInvocations', 'requestId'].includes(key),
      ),
    );
    expect(parseTurnBody(JSON.stringify(body))).toEqual({
      ok: true,
      body: read,
    });
  });

  it('treats null in an optional field as absent', () => {
    const optional = [...TURN_BODY_KEYS].filter((key) => key !== 'message');
    expect(
      parseTurnBody(
        JSON.stringify({
          message: 'hi',
          ...Object.fromEntries(optional.map((key) => [key, null])),
        }),
      ),
    ).toEqual({ ok: true, body: { message: 'hi' } });
    expect(parseTurnBody('{"message":null}')).toEqual({
      ok: false,
      status: 400,
      message: 'message is required',
    });
  });

  it('passes declared tools and AG-UI actions through', () => {
    const tool = { name: 't', description: 'd', schema: { type: 'object' } };
    expect(
      parseTurnBody(
        JSON.stringify({
          message: 'hi',
          multitask: 'enqueue',
          tools: [tool],
          agActions: [{ ...tool, hasRender: true }],
        }),
      ),
    ).toEqual({
      ok: true,
      body: {
        message: 'hi',
        multitask: 'enqueue',
        tools: [tool],
        agActions: [{ ...tool, hasRender: true }],
      },
    });
  });

  it.each([
    [{ stream: 'false' }, 'stream must be a boolean'],
    [{ returnAllMessages: 1 }, 'returnAllMessages must be a boolean'],
    [{ model: 7 }, 'model must be a string'],
    [{ timezone: {} }, 'timezone must be a string'],
    [{ requestId: 1 }, 'requestId must be a string'],
    [{ metadata: [] }, 'metadata must be an object'],
    [{ attachments: {} }, 'attachments must be an array'],
    [{ tools: {} }, 'tools must be an array'],
    [
      { tools: [{ name: 't' }] },
      'each tool needs a string name, description and an object schema',
    ],
    [{ agActions: 'x' }, 'agActions must be an array'],
    [
      {
        agActions: [
          { name: 'a', description: 'd', schema: {}, hasRender: 'yes' },
        ],
      },
      'each agAction needs a string name, description and an object schema',
    ],
    [{ multitask: 'queue' }, 'multitask must be one of: interrupt, enqueue'],
  ])('rejects a field of the wrong type: %j', (fields, message) => {
    expect(parseTurnBody(JSON.stringify({ message: 'hi', ...fields }))).toEqual(
      { ok: false, status: 400, message },
    );
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

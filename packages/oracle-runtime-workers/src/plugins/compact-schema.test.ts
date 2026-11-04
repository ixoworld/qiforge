import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { compactJsonSchema, modelFacingSchema } from './compact-schema';

const strict = z.strictObject({
  id: z
    .string()
    .min(1)
    .max(64)
    .regex(/^[a-z]+$/)
    .describe('The id.'),
  kind: z.enum(['a', 'b']).describe('The kind.'),
  at: z
    .union([z.string().max(10), z.null()])
    .optional()
    .describe('When.'),
  list: z
    .array(z.strictObject({ n: z.number().int().min(1).max(9) }))
    .min(1)
    .max(3),
  extra: z.record(z.string().max(5), z.unknown()).optional(),
  later: z.string().default('x'),
});

describe('compactJsonSchema', () => {
  it('keeps the shape and drops what only a strict parse needs', () => {
    const compact = compactJsonSchema(
      z.toJSONSchema(strict, { io: 'input', unrepresentable: 'any' }),
    );
    expect(compact).toEqual({
      type: 'object',
      properties: {
        id: { type: 'string', description: 'The id.' },
        kind: { type: 'string', enum: ['a', 'b'], description: 'The kind.' },
        at: {
          description: 'When.',
          anyOf: [{ type: 'string' }, { type: 'null' }],
        },
        list: {
          type: 'array',
          items: {
            type: 'object',
            properties: { n: { type: 'integer' } },
            required: ['n'],
            additionalProperties: false,
          },
        },
        extra: { type: 'object', additionalProperties: {} },
        later: { type: 'string', default: 'x' },
      },
      required: ['id', 'kind', 'list'],
      additionalProperties: false,
    });
  });

  it('drops the descriptions on request and keeps a field named like a keyword', () => {
    const compact = compactJsonSchema(
      {
        type: 'object',
        description: 'Gone.',
        properties: {
          pattern: { type: 'string', description: 'Gone too.', maxLength: 3 },
        },
      },
      { descriptions: false },
    );
    expect(compact).toEqual({
      type: 'object',
      properties: { pattern: { type: 'string' } },
    });
  });
});

describe('modelFacingSchema', () => {
  const bound = modelFacingSchema(strict, { descriptions: false });
  const valid = { id: 'abc', kind: 'a', list: [{ n: 1 }] };

  it('lets through what only the limits refuse, for the handler to name', () => {
    const tooLong = { ...valid, id: 'x'.repeat(100) };
    expect(bound.safeParse(tooLong).success).toBe(true);
    expect(strict.safeParse(tooLong).success).toBe(false);
  });

  it('still refuses a wrong shape: a missing field, a wrong type, a value off the enum', () => {
    expect(bound.safeParse({ id: 'abc', kind: 'a' }).success).toBe(false);
    expect(bound.safeParse({ ...valid, id: 1 }).success).toBe(false);
    expect(bound.safeParse({ ...valid, kind: 'c' }).success).toBe(false);
  });

  it('keeps an unknown key refused only where the schema is strict', () => {
    expect(bound.safeParse({ ...valid, stray: 1 }).success).toBe(false);
    const loose = modelFacingSchema(z.object({ a: z.string() }));
    expect(loose.safeParse({ a: 'x', stray: 1 }).success).toBe(true);
  });

  it('binds the input of a transformed schema', () => {
    const transformed = z.object({
      when: z
        .object({ at: z.string() })
        .transform(({ at }) => new Date(at).getTime()),
    });
    expect(
      modelFacingSchema(transformed).safeParse({ when: { at: 'x' } }).success,
    ).toBe(true);
  });
});

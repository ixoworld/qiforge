import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import {
  clientSchemaToZod,
  inlineLocalJsonPointerRefs,
} from './client-tool-schema.js';

/**
 * Shape of what `zod-to-json-schema` emits with its default
 * `$refStrategy: 'root'` when the same subschema appears twice: the second
 * occurrence becomes a JSON pointer into the document.
 */
const SCHEMA_WITH_POINTER_REF = {
  type: 'object',
  properties: {
    ops: {
      type: 'array',
      items: {
        anyOf: [
          { type: 'object', properties: { blockId: { type: 'string' } } },
          { type: 'object', properties: { pageId: { type: 'string' } } },
          {
            type: 'object',
            properties: {
              questionId: { type: 'string', minLength: 1 },
              value: { type: 'string' },
            },
            required: ['questionId'],
          },
        ],
      },
    },
    focus: {
      type: 'object',
      properties: {
        questionId: {
          $ref: '#/properties/ops/items/anyOf/2/properties/questionId',
        },
      },
    },
  },
  required: ['ops'],
};

describe('inlineLocalJsonPointerRefs', () => {
  it('replaces a JSON-pointer ref with the subschema it targets', () => {
    const inlined = inlineLocalJsonPointerRefs(SCHEMA_WITH_POINTER_REF);

    const focus = inlined.properties as Record<string, unknown>;
    expect(focus.focus).toEqual({
      type: 'object',
      properties: {
        questionId: { type: 'string', minLength: 1 },
      },
    });
  });

  it('leaves refs zod resolves itself untouched', () => {
    const schema = {
      type: 'object',
      $defs: { name: { type: 'string' } },
      properties: { name: { $ref: '#/$defs/name' } },
    };

    const inlined = inlineLocalJsonPointerRefs(schema);

    expect((inlined.properties as Record<string, unknown>).name).toEqual({
      $ref: '#/$defs/name',
    });
  });

  it('expands a self-referential pointer once, then cuts it off', () => {
    const schema = {
      type: 'object',
      properties: {
        node: {
          type: 'object',
          properties: { child: { $ref: '#/properties/node' } },
        },
      },
    };

    const inlined = inlineLocalJsonPointerRefs(schema);

    // One level of the recursive shape survives; the pointer inside that copy
    // is already on the active path, so it collapses instead of recursing.
    expect(inlined.properties).toEqual({
      node: {
        type: 'object',
        properties: {
          child: {
            type: 'object',
            properties: { child: {} },
          },
        },
      },
    });
  });

  it('drops a pointer that resolves to nothing', () => {
    const schema = {
      type: 'object',
      properties: { missing: { $ref: '#/properties/nope/properties/gone' } },
    };

    const inlined = inlineLocalJsonPointerRefs(schema);

    expect((inlined.properties as Record<string, unknown>).missing).toEqual({});
  });

  it('decodes RFC 6901 escapes in pointer segments', () => {
    const schema = {
      type: 'object',
      properties: {
        'a/b': { type: 'string', minLength: 2 },
        alias: { $ref: '#/properties/a~1b' },
      },
    };

    const inlined = inlineLocalJsonPointerRefs(schema);

    expect((inlined.properties as Record<string, unknown>).alias).toEqual({
      type: 'string',
      minLength: 2,
    });
  });
});

describe('clientSchemaToZod', () => {
  it('converts a schema that zod alone would reject', () => {
    expect(() => z.fromJSONSchema(SCHEMA_WITH_POINTER_REF)).toThrow(
      /Reference not found/,
    );

    const schema = clientSchemaToZod(SCHEMA_WITH_POINTER_REF, 'apply_ops');

    expect(schema).not.toBeNull();
    expect(
      schema?.safeParse({
        ops: [{ questionId: 'q1', value: 'yes' }],
        focus: { questionId: 'q1' },
      }).success,
    ).toBe(true);
  });

  it('preserves the constraints carried by the inlined subschema', () => {
    const schema = clientSchemaToZod(SCHEMA_WITH_POINTER_REF, 'apply_ops');

    // `questionId` was pointed at a `minLength: 1` string — an empty string
    // must still be rejected after inlining.
    expect(
      schema?.safeParse({ ops: [], focus: { questionId: '' } }).success,
    ).toBe(false);
  });

  it('returns null when the schema cannot be converted at all', () => {
    const schema = clientSchemaToZod(
      { type: 'object', properties: { x: { $ref: 'https://example.com/x' } } },
      'broken_tool',
    );

    expect(schema).toBeNull();
  });
});

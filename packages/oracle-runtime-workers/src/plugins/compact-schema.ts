import { z } from 'zod';

type JsonSchema = z.core.JSONSchema._JSONSchema;
type ObjectSchema = z.core.JSONSchema.JSONSchema;

/**
 * Keywords a model does not need to write a valid call and that repeat all
 * over a large schema. They stay enforced by the handler's strict parse.
 */
const CHECK_ONLY = [
  'minLength',
  'maxLength',
  'pattern',
  'minItems',
  'maxItems',
  'minimum',
  'maximum',
  'exclusiveMinimum',
  'exclusiveMaximum',
  'propertyNames',
  '$schema',
] as const;

type Options = { descriptions?: boolean };

function compactInner(schema: JsonSchema, options: Options): JsonSchema {
  return typeof schema === 'boolean'
    ? schema
    : compactJsonSchema(schema, options);
}

/**
 * `schema` with the same shape (properties, required keys, types, enums,
 * constants, nesting) and without {@link CHECK_ONLY}, and without its
 * descriptions when `descriptions` is false.
 */
export function compactJsonSchema(
  schema: ObjectSchema,
  options: Options = {},
): ObjectSchema {
  const compact = { ...schema };
  for (const keyword of CHECK_ONLY) delete compact[keyword];
  if (options.descriptions === false) delete compact.description;
  const { properties, items, additionalProperties, anyOf, oneOf } = schema;
  if (properties)
    compact.properties = Object.fromEntries(
      Object.entries(properties).map(([name, property]) => [
        name,
        compactInner(property, options),
      ]),
    );
  if (items !== undefined)
    compact.items = Array.isArray(items)
      ? items.map((item) => compactInner(item, options))
      : compactInner(items, options);
  if (additionalProperties !== undefined)
    compact.additionalProperties = compactInner(additionalProperties, options);
  if (anyOf) compact.anyOf = anyOf.map((s) => compactJsonSchema(s, options));
  if (oneOf) compact.oneOf = oneOf.map((s) => compactJsonSchema(s, options));
  return compact;
}

/**
 * The schema a tool binds when its handler parses its input strictly itself:
 * the shape of `schema` as its input, reduced by {@link compactJsonSchema}.
 * Tools repeating a large schema bind this, so the model reads each field's
 * limits and words once at most; a call the bound schema lets through and
 * the handler refuses must name the problem in its answer.
 */
export function modelFacingSchema(
  schema: z.ZodType,
  options: Options = {},
): z.ZodType {
  return z.fromJSONSchema(
    compactJsonSchema(
      z.toJSONSchema(schema, { io: 'input', unrepresentable: 'any' }),
      options,
    ),
  );
}

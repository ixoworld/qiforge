/**
 * The tool schemas a model is shown, made acceptable to OpenAI-family
 * function calling. OpenAI and Azure OpenAI compile every string `pattern`
 * of a function's parameters with Python's `re` (see `python-regex.ts`) and
 * refuse the WHOLE request (HTTP 400 `invalid_function_parameters`) when one
 * does not compile, so a single JavaScript-only construct such as a Unicode
 * property escape (`\p{L}`, from a zod `.regex(/…/u)`) takes OpenAI and Azure
 * out of every call that carries the tool. On OpenRouter the call then falls
 * through to the remaining providers and the fallback models.
 *
 * Such a `pattern` is left out of the copy the model is shown; the tool's
 * own schema is not touched, so the arguments of a call are still checked
 * against it, the pattern included, before the tool runs. A pattern Python
 * compiles is kept as it is. The first time a tool loses a pattern in an
 * isolate, one warning names the tool and the field.
 *
 * Only the `pattern` keyword is checked: `patternProperties` is not a
 * keyword OpenAI's structured outputs support, and no bundled tool uses it.
 */
import type { Logger } from '../plugin-api/types';
import { pythonRegexRefusal } from './python-regex';

export interface RemovedPattern {
  /** Where the pattern was, as a dotted schema path (`properties.language`). */
  path: string;
  pattern: string;
  /** Python's reason, e.g. `bad escape \p`. */
  reason: string;
}

/** Schema keywords whose value is a map of subschemas. */
const SCHEMA_MAPS = [
  'properties',
  'patternProperties',
  '$defs',
  'definitions',
  'dependentSchemas',
] as const;
/** Schema keywords whose value is a subschema. */
const SCHEMA_VALUES = [
  'additionalProperties',
  'unevaluatedProperties',
  'items',
  'additionalItems',
  'unevaluatedItems',
  'contains',
  'propertyNames',
  'not',
  'if',
  'then',
  'else',
] as const;
/** Schema keywords whose value is a list of subschemas. */
const SCHEMA_LISTS = [
  'anyOf',
  'oneOf',
  'allOf',
  'prefixItems',
  'items',
] as const;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function walk(
  schema: unknown,
  path: string,
  removed: RemovedPattern[],
): unknown {
  return isRecord(schema) ? walkRecord(schema, path, removed) : schema;
}

function walkRecord(
  schema: Record<string, unknown>,
  path: string,
  removed: RemovedPattern[],
): Record<string, unknown> {
  let copy: Record<string, unknown> | undefined;
  const set = (key: string, value: unknown): void => {
    copy ??= { ...schema };
    copy[key] = value;
  };
  if (typeof schema.pattern === 'string') {
    const reason = pythonRegexRefusal(schema.pattern);
    if (reason !== null) {
      removed.push({ path: path || '(root)', pattern: schema.pattern, reason });
      copy ??= { ...schema };
      delete copy.pattern;
    }
  }
  const at = (key: string): string => (path ? `${path}.${key}` : key);
  for (const keyword of SCHEMA_MAPS) {
    const map = schema[keyword];
    if (!isRecord(map)) continue;
    let mapCopy: Record<string, unknown> | undefined;
    for (const [name, sub] of Object.entries(map)) {
      const next = walk(sub, at(`${keyword}.${name}`), removed);
      if (next !== sub) {
        mapCopy ??= { ...map };
        mapCopy[name] = next;
      }
    }
    if (mapCopy) set(keyword, mapCopy);
  }
  for (const keyword of SCHEMA_VALUES) {
    const sub = schema[keyword];
    if (!isRecord(sub)) continue;
    const next = walkRecord(sub, at(keyword), removed);
    if (next !== sub) set(keyword, next);
  }
  for (const keyword of SCHEMA_LISTS) {
    const list = schema[keyword];
    if (!Array.isArray(list)) continue;
    let changed = false;
    const next = list.map((sub, i) => {
      const out = walk(sub, at(`${keyword}.${i}`), removed);
      if (out !== sub) changed = true;
      return out;
    });
    if (changed) set(keyword, next);
  }
  return copy ?? schema;
}

/**
 * `parameters` without the `pattern`s OpenAI refuses, and what was taken
 * out. The input is never changed; it is returned as is when nothing was.
 */
export function modelFacingParameters(parameters: Record<string, unknown>): {
  parameters: Record<string, unknown>;
  removed: RemovedPattern[];
} {
  const removed: RemovedPattern[] = [];
  return { parameters: walkRecord(parameters, '', removed), removed };
}

/** Tool + path pairs already reported in this isolate. */
const reported = new Set<string>();

/**
 * The parameters of function tool `name` as the model is shown them (see
 * the module comment); `parameters` itself when nothing had to go. Each
 * pattern left out is reported once per isolate on `logger`.
 */
export function guardFunctionParameters(
  name: string,
  parameters: Record<string, unknown>,
  logger?: Logger,
): Record<string, unknown> {
  const { parameters: shown, removed } = modelFacingParameters(parameters);
  for (const entry of removed) {
    const key = `${name}\u0000${entry.path}`;
    if (reported.has(key)) continue;
    reported.add(key);
    logger?.warn(
      `[tool-schema] tool "${name}": the pattern of ${entry.path} is not shown to the model (${entry.reason}; OpenAI and Azure refuse the whole request for it); the tool still checks it when called. Pattern: ${entry.pattern}`,
    );
  }
  return shown;
}

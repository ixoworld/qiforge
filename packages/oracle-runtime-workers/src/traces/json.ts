/**
 * The tracer's JSON: what a run's payload becomes on the wire. It never
 * throws and always yields JSON the service accepts, whatever LangChain hands
 * over, with a bound on its length (it stops as soon as it is passed) and on
 * its depth.
 *
 * How each value is written:
 * - strings: as JSON strings, with the signature of every signed link
 *   replaced (`redactSignedLinkText`); numbers: finite ones as numbers,
 *   `NaN` and infinities as `null`; booleans; `null`.
 * - `undefined`, functions and symbols: left out of an object, `null` in an
 *   array, `null` on their own (as `JSON.stringify` does).
 * - `bigint`: its decimal digits as a string.
 * - an object with `toJSON` (a `Date`, a LangChain message): what `toJSON`
 *   returns (an invalid `Date` gives `null`); a `toJSON` that throws gives
 *   `"[Unserializable]"`.
 * - an `Error`: `{ name, message }`, plus `code` when it is a string or a
 *   number; never its stack.
 * - a `Map`: an object when every key is a string or a number, else a list
 *   of `[key, value]` pairs; a `Set`: a list.
 * - binary data (`ArrayBuffer`, typed arrays, `DataView`, `Blob`): never the
 *   bytes, only `{ "_binary": { "type", "bytes" } }`.
 * - a reference back to an object being written (a cycle):
 *   `"[Circular]"`; an object reached twice without a cycle is written twice.
 * - a property whose getter throws (or a revoked proxy):
 *   `"[Unserializable]"`.
 * - the key `$blob` (reserved by the service for its block references) is
 *   written as `_$blob`.
 * - an object or array nested deeper than `maxDepth`:
 *   `{ "_truncated": { "depth": maxDepth } }`.
 */
import { redactSignedLinkText } from '../core/llm';
import { BLOB_REF_KEY } from './contract';

export interface TraceJsonOptions {
  /** Characters the JSON may hold; past it the walk stops (`tooLarge`). */
  maxChars: number;
  /** Levels of objects and arrays; the value itself is level 1. */
  maxDepth: number;
  /** Count only: build no string (`json` is then empty). */
  measureOnly?: boolean;
}

export type TraceJsonResult =
  | { tooLarge: false; json: string; chars: number }
  /** `chars`: how far the walk got before it stopped (a lower bound). */
  | { tooLarge: true; chars: number };

const UNSERIALIZABLE = '"[Unserializable]"';
const CIRCULAR = '"[Circular]"';
/** Marks a value an object leaves out (`undefined`, a function, a symbol). */
const OMIT = Symbol('omit');
/** Thrown inside the walk once the output is past `maxChars` (one instance, no stack per throw). */
class OverLimit extends Error {}
const OVER = new OverLimit('trace JSON over its limit');
/** Stands for a value whose read threw. */
const UNSERIALIZABLE_VALUE = Symbol('unserializable');

function isBinary(value: object): { type: string; bytes: number } | undefined {
  if (value instanceof ArrayBuffer)
    return { type: 'ArrayBuffer', bytes: value.byteLength };
  if (ArrayBuffer.isView(value))
    return { type: value.constructor.name, bytes: value.byteLength };
  if (typeof Blob !== 'undefined' && value instanceof Blob)
    return { type: 'Blob', bytes: value.size };
  return undefined;
}

/** `value` as its holder hands it to JSON: through `toJSON`, or left out. */
function resolve(value: unknown, key: string): unknown {
  if (value === UNSERIALIZABLE_VALUE) return value;
  if (
    value === undefined ||
    typeof value === 'function' ||
    typeof value === 'symbol'
  )
    return OMIT;
  if (value === null || typeof value !== 'object' || value instanceof Error)
    return value;
  const toJSON: unknown = Reflect.get(value, 'toJSON');
  if (typeof toJSON !== 'function') return value;
  const result: unknown = toJSON.call(value, key);
  if (
    result === undefined ||
    typeof result === 'function' ||
    typeof result === 'symbol'
  )
    return OMIT;
  return result;
}

export function traceJson(
  value: unknown,
  options: TraceJsonOptions,
): TraceJsonResult {
  const { maxChars, maxDepth } = options;
  const measureOnly = options.measureOnly === true;
  const parts: string[] = [];
  const ancestors = new Set<object>();
  let chars = 0;

  const push = (text: string): void => {
    chars += text.length;
    if (chars > maxChars) throw OVER;
    if (!measureOnly) parts.push(text);
  };

  const writeString = (text: string): void => {
    // A string longer than what is left is never escaped (no copy of it).
    if (chars + text.length + 2 > maxChars) {
      chars += text.length + 2;
      throw OVER;
    }
    push(JSON.stringify(redactSignedLinkText(text)));
  };

  const writeKey = (key: string): void => {
    writeString(key === BLOB_REF_KEY ? `_${BLOB_REF_KEY}` : key);
    push(':');
  };

  const writeEntries = (
    entries: Iterable<[string, unknown]>,
    depth: number,
  ): void => {
    push('{');
    let first = true;
    for (const [key, raw] of entries) {
      let resolved: unknown;
      try {
        resolved = resolve(raw, key);
      } catch {
        resolved = UNSERIALIZABLE_VALUE;
      }
      if (resolved === OMIT) continue;
      if (!first) push(',');
      first = false;
      writeKey(key);
      write(resolved, depth + 1);
    }
    push('}');
  };

  const writeList = (items: Iterable<unknown>, depth: number): void => {
    push('[');
    let index = 0;
    for (const raw of items) {
      if (index > 0) push(',');
      let resolved: unknown;
      try {
        resolved = resolve(raw, String(index));
      } catch {
        resolved = UNSERIALIZABLE_VALUE;
      }
      if (resolved === OMIT) push('null');
      else write(resolved, depth + 1);
      index += 1;
    }
    push(']');
  };

  /** Writes a value already through `resolve` (never OMIT), at `depth`. */
  function write(value: unknown, depth: number): void {
    if (value === UNSERIALIZABLE_VALUE) return push(UNSERIALIZABLE);
    if (value === null) return push('null');
    switch (typeof value) {
      case 'string':
        return writeString(value);
      case 'number':
        return push(Number.isFinite(value) ? JSON.stringify(value) : 'null');
      case 'boolean':
        return push(value ? 'true' : 'false');
      case 'bigint':
        return writeString(value.toString());
      case 'object':
        break;
      default:
        return push('null');
    }
    if (depth > maxDepth) return push(`{"_truncated":{"depth":${maxDepth}}}`);
    if (ancestors.has(value)) return push(CIRCULAR);
    ancestors.add(value);
    try {
      if (value instanceof Error) {
        const code: unknown = Reflect.get(value, 'code');
        const shown: Array<[string, unknown]> = [
          ['name', value.name],
          ['message', value.message],
        ];
        if (typeof code === 'string' || typeof code === 'number')
          shown.push(['code', code]);
        return writeEntries(shown, depth);
      }
      const binary = isBinary(value);
      if (binary)
        return push(
          `{"_binary":{"type":${JSON.stringify(binary.type)},"bytes":${binary.bytes}}}`,
        );
      if (value instanceof Map) {
        const keys = [...value.keys()];
        if (keys.every((k) => typeof k === 'string' || typeof k === 'number'))
          return writeEntries(
            [...value.entries()].map(([k, v]): [string, unknown] => [
              String(k),
              v,
            ]),
            depth,
          );
        return writeList(
          [...value.entries()].map(([k, v]) => [k, v]),
          depth,
        );
      }
      if (value instanceof Set) return writeList(value, depth);
      if (Array.isArray(value)) return writeList(value, depth);
      const keys = Object.keys(value);
      return writeEntries(
        (function* (): Generator<[string, unknown]> {
          for (const key of keys) {
            let item: unknown;
            try {
              item = Reflect.get(value, key);
            } catch {
              item = UNSERIALIZABLE_VALUE;
            }
            yield [key, item];
          }
        })(),
        depth,
      );
    } finally {
      ancestors.delete(value);
    }
  }

  try {
    let resolved: unknown;
    try {
      resolved = resolve(value, '');
    } catch {
      resolved = UNSERIALIZABLE_VALUE;
    }
    if (resolved === OMIT) push('null');
    else write(resolved, 1);
  } catch (error) {
    if (error === OVER) return { tooLarge: true, chars };
    // Anything else (a proxy trap that throws past every guard): a marker.
    return {
      tooLarge: false,
      json: measureOnly ? '' : UNSERIALIZABLE,
      chars: UNSERIALIZABLE.length,
    };
  }
  return { tooLarge: false, json: measureOnly ? '' : parts.join(''), chars };
}

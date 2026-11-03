/**
 * The checkpointer's storage form of a value: every human message that
 * carries inline attachment bytes (base64 content blocks, see
 * `src/attachments/retention.ts`) is replaced by its placeholder copy
 * (`offloadInlinePayloads`), wherever it sits in the value.
 *
 * Every byte the saver writes passes through here: message rows
 * (`encodeMessageRow`, which `put` and `appendTurnMessages` use), the
 * checkpoint blob's other channel values and every pending write
 * (`putWrites` — a node's output and LangGraph's `Send` packets, which
 * carry a copy of the whole state, messages included). The graph's
 * in-memory state keeps the real blocks: nothing here mutates its input,
 * and a container is copied only when something inside it was replaced,
 * so a value without inline payloads comes back as the same object.
 */
import { isBaseMessage } from '@langchain/core/messages';
import { offloadInlinePayloads } from '../attachments/retention';

/**
 * How deep a value is searched. A `Send` packet holds the state, the state
 * holds the message list, the list holds the message: four levels; the
 * margin covers state channels that nest a little deeper.
 */
const MAX_DEPTH = 12;

function isPlainObject(value: object): value is Record<string, unknown> {
  const proto: unknown = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

/**
 * A LangGraph `Send` packet (`lg_name: 'Send'`), the shape the serializer
 * recognises (`serialization.ts` `_default`, `JsonPlusSerializer`).
 */
function isSendPacket(
  value: object,
): value is { lg_name: 'Send'; node: unknown; args: unknown } {
  return Reflect.get(value, 'lg_name') === 'Send';
}

function strip(value: unknown, depth: number): unknown {
  if (typeof value !== 'object' || value === null || depth > MAX_DEPTH)
    return value;
  if (isBaseMessage(value)) return offloadInlinePayloads(value) ?? value;
  if (Array.isArray(value)) {
    let out: unknown[] | undefined;
    for (let i = 0; i < value.length; i++) {
      const item: unknown = value[i];
      const stripped = strip(item, depth + 1);
      if (stripped === item) continue;
      out ??= value.slice();
      out[i] = stripped;
    }
    return out ?? value;
  }
  if (isSendPacket(value)) {
    const args = strip(value.args, depth + 1);
    if (args === value.args) return value;
    // Serialized exactly like the `Send` it replaces: both serializers
    // write `{ node, args }` (plus `timeout` when set) for this shape.
    const timeout: unknown = Reflect.get(value, 'timeout');
    return {
      lg_name: 'Send',
      node: value.node,
      args,
      ...(timeout !== undefined ? { timeout } : {}),
    };
  }
  if (!isPlainObject(value)) return value;
  let out: Record<string, unknown> | undefined;
  for (const [key, item] of Object.entries(value)) {
    const stripped = strip(item, depth + 1);
    if (stripped === item) continue;
    out ??= { ...value };
    out[key] = stripped;
  }
  return out ?? value;
}

/**
 * `value` as the checkpointer stores it: inline attachment payloads
 * replaced by their placeholder (see the module comment). The same object
 * when there is nothing to replace.
 */
export function withoutInlinePayloads(value: unknown): unknown {
  return strip(value, 0);
}

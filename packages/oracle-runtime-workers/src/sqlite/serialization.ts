/**
 * Message serialization helpers shared with the Node runtime's
 * `@ixo/sqlite-saver` (ported from its `utils.ts`). The wire format of the
 * `messages.message` column must stay byte-compatible so a database written
 * by either runtime loads in the other:
 *
 *   JSON.stringify(message, replacer = _default)
 *
 * where `message.toJSON()` is LangChain's `Serializable` envelope
 * (`{ lc: 1, type: 'constructor', id: [...], kwargs: {...} }`) and `_default`
 * mirrors `JsonPlusSerializer`'s handling of `undefined`, Set/Map/RegExp/Error
 * and LangGraph `Send` objects. `stringify` is fast-safe-stringify's
 * circular-safe variant, typed.
 */

type Replacer = (this: unknown, key: string, value: unknown) => unknown;

const CIRCULAR_REPLACE_NODE = '[Circular]';

type Restore = {
  parent: Record<string, unknown> | unknown[];
  key: string | number;
  value: unknown;
  descriptor?: PropertyDescriptor;
};

interface GetterReplacement {
  value: unknown;
  key: string | number;
  replacement: string;
}

function isObjectLike(
  value: unknown,
): value is Record<string, unknown> | unknown[] {
  return typeof value === 'object' && value !== null;
}

/**
 * `JSON.stringify` that never throws on circular references: every back
 * reference is temporarily replaced by `'[Circular]'` while serializing and
 * restored afterwards, so the input object is left untouched.
 */
export function stringify(
  obj: unknown,
  replacer?: Replacer,
  spacer?: string | number,
): string {
  const restores: Restore[] = [];
  const getterReplacements: GetterReplacement[] = [];
  decirc(obj, '', [], undefined, restores, getterReplacements);
  try {
    const effectiveReplacer =
      getterReplacements.length === 0
        ? replacer
        : replaceGetterValues(replacer, getterReplacements);
    return JSON.stringify(obj, effectiveReplacer, spacer);
  } catch {
    return JSON.stringify(
      '[unable to serialize, circular reference is too complex to analyze]',
    );
  } finally {
    while (restores.length !== 0) {
      const part = restores.pop();
      if (part === undefined) break;
      if (part.descriptor !== undefined) {
        Object.defineProperty(part.parent, part.key, part.descriptor);
      } else if (Array.isArray(part.parent)) {
        part.parent[Number(part.key)] = part.value;
      } else {
        part.parent[String(part.key)] = part.value;
      }
    }
  }
}

function setReplace(
  replacement: string,
  value: unknown,
  key: string | number,
  parent: Record<string, unknown> | unknown[],
  restores: Restore[],
  getterReplacements: GetterReplacement[],
): void {
  const descriptor = Object.getOwnPropertyDescriptor(parent, key);
  if (descriptor?.get !== undefined) {
    if (descriptor.configurable) {
      Object.defineProperty(parent, key, { value: replacement });
      restores.push({ parent, key, value, descriptor });
    } else {
      getterReplacements.push({ value, key, replacement });
    }
    return;
  }
  if (Array.isArray(parent)) {
    parent[Number(key)] = replacement;
  } else {
    parent[String(key)] = replacement;
  }
  restores.push({ parent, key, value });
}

function decirc(
  value: unknown,
  key: string | number,
  stack: unknown[],
  parent: Record<string, unknown> | unknown[] | undefined,
  restores: Restore[],
  getterReplacements: GetterReplacement[],
): void {
  if (!isObjectLike(value)) return;
  if (stack.includes(value)) {
    if (parent !== undefined)
      setReplace(
        CIRCULAR_REPLACE_NODE,
        value,
        key,
        parent,
        restores,
        getterReplacements,
      );
    return;
  }
  stack.push(value);
  if (Array.isArray(value)) {
    for (let i = 0; i < value.length; i++) {
      decirc(value[i], i, stack, value, restores, getterReplacements);
    }
  } else {
    for (const childKey of Object.keys(value)) {
      decirc(
        value[childKey],
        childKey,
        stack,
        value,
        restores,
        getterReplacements,
      );
    }
  }
  stack.pop();
}

function replaceGetterValues(
  replacer: Replacer | undefined,
  getterReplacements: GetterReplacement[],
): Replacer {
  const inner: Replacer = replacer ?? ((_key, value) => value);
  return function (this: unknown, key, value) {
    let effective = value;
    if (getterReplacements.length > 0) {
      for (let i = 0; i < getterReplacements.length; i++) {
        const part = getterReplacements[i];
        if (part !== undefined && part.key === key && part.value === value) {
          effective = part.replacement;
          getterReplacements.splice(i, 1);
          break;
        }
      }
    }
    return inner.call(this, key, effective);
  };
}

interface ConstructorEnvelope {
  lc: 2;
  type: 'constructor';
  id: string[];
  method: string | null;
  args: unknown[];
  kwargs: Record<string, unknown>;
}

function encodeConstructorArgs(
  constructorName: string,
  method?: string,
  args?: unknown[],
  kwargs?: Record<string, unknown>,
): ConstructorEnvelope {
  return {
    lc: 2,
    type: 'constructor',
    id: [constructorName],
    method: method ?? null,
    args: args ?? [],
    kwargs: kwargs ?? {},
  };
}

function isSend(
  value: unknown,
): value is { lg_name: 'Send'; node: unknown; args: unknown } {
  return (
    isObjectLike(value) && !Array.isArray(value) && value.lg_name === 'Send'
  );
}

/** Replacer applied to every value while serializing a message (mirrors `JsonPlusSerializer`). */
export function _default(obj: unknown): unknown {
  if (obj === undefined) {
    return { lc: 2, type: 'undefined' };
  }
  if (obj instanceof Set || obj instanceof Map) {
    return encodeConstructorArgs(obj.constructor.name, undefined, [
      Array.from(obj),
    ]);
  }
  if (obj instanceof RegExp) {
    return encodeConstructorArgs('RegExp', undefined, [obj.source, obj.flags]);
  }
  if (obj instanceof Error) {
    return encodeConstructorArgs(obj.constructor.name, undefined, [
      obj.message,
    ]);
  }
  if (isSend(obj)) {
    return { node: obj.node, args: obj.args };
  }
  return obj;
}

export interface AttachmentMeta {
  filename: string;
  mimetype: string;
  size?: number;
  mxcUri?: string;
  eventId?: string;
  category: string;
}

export interface ReasoningDetail {
  type: string;
  text: string;
}

/**
 * The `additional_kwargs` shape persisted on every message row. Same
 * allowlist as the Node runtime so both runtimes read each other's rows.
 */
export interface CleanAdditionalKwargs {
  msgFromMatrixRoom: boolean;
  timestamp: string;
  oracleName: string;
  /** Provenance marker set by LangChain middlewares (e.g. `"summarization"`). */
  lc_source?: string;
  reasoning?: string;
  reasoningDetails?: ReasoningDetail[];
  attachment?: AttachmentMeta;
  attachments?: AttachmentMeta[];
  // Group-chat speaker + threading metadata (the gating middleware needs these across turns).
  senderDid?: string;
  senderMatrixUserId?: string;
  senderDisplayName?: string;
  threadId?: string;
  eventId?: string;
  isGroupChat?: boolean;
  'm.mentions'?: { user_ids?: string[] };
  'm.relates_to'?: { 'm.in_reply_to'?: { event_id: string } };
  [key: string]: unknown;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isAttachmentMeta(value: unknown): value is AttachmentMeta {
  return (
    isRecord(value) &&
    typeof value.filename === 'string' &&
    typeof value.mimetype === 'string' &&
    typeof value.category === 'string'
  );
}

function isReasoningDetail(value: unknown): value is ReasoningDetail {
  return (
    isRecord(value) &&
    typeof value.type === 'string' &&
    typeof value.text === 'string'
  );
}

/** OpenRouter-style reasoning fields on the raw streamed chunk, when the model emitted them. */
function extractReasoning(additionalKwargs: Record<string, unknown>): {
  reasoning?: string;
  reasoningDetails?: ReasoningDetail[];
} {
  const raw = additionalKwargs.__raw_response;
  if (!isRecord(raw) || !Array.isArray(raw.choices)) return {};
  const first: unknown = raw.choices[0];
  if (!isRecord(first) || !isRecord(first.delta)) return {};
  const { reasoning, reasoning_details: details } = first.delta;
  if (typeof reasoning !== 'string' || reasoning.length === 0) return {};
  const reasoningDetails = Array.isArray(details)
    ? details
        .filter(isReasoningDetail)
        .filter((detail) => detail.text.trim().length > 0)
        .map(({ type, text }) => ({ type, text }))
    : [];
  return reasoningDetails.length > 0
    ? { reasoning, reasoningDetails }
    : { reasoning };
}

/**
 * Reduce a message's `additional_kwargs` to the persisted allowlist. An
 * existing `timestamp` is preserved: every checkpoint `put` rewrites every
 * message row, so stamping "now" would churn `created_at` on the whole thread
 * each super-step and destroy the transcript's chronological order.
 */
export function cleanAdditionalKwargs(
  additionalKwargs: Record<string, unknown>,
  msgFromMatrixRoom: boolean,
  oracleName: string,
): CleanAdditionalKwargs {
  const cleaned: CleanAdditionalKwargs = {
    msgFromMatrixRoom,
    timestamp:
      typeof additionalKwargs.timestamp === 'string' &&
      additionalKwargs.timestamp.length > 0
        ? additionalKwargs.timestamp
        : new Date().toISOString(),
    oracleName,
  };
  if (typeof additionalKwargs.lc_source === 'string')
    cleaned.lc_source = additionalKwargs.lc_source;
  if (isAttachmentMeta(additionalKwargs.attachment))
    cleaned.attachment = additionalKwargs.attachment;
  if (
    Array.isArray(additionalKwargs.attachments) &&
    additionalKwargs.attachments.length > 0
  ) {
    const attachments = additionalKwargs.attachments.filter(isAttachmentMeta);
    if (attachments.length > 0) cleaned.attachments = attachments;
  }
  for (const key of [
    'senderDid',
    'senderMatrixUserId',
    'senderDisplayName',
    'threadId',
    'eventId',
  ] as const) {
    const value = additionalKwargs[key];
    if (typeof value === 'string') cleaned[key] = value;
  }
  if (typeof additionalKwargs.isGroupChat === 'boolean')
    cleaned.isGroupChat = additionalKwargs.isGroupChat;
  const mentions = additionalKwargs['m.mentions'];
  if (isRecord(mentions)) {
    const userIds = mentions.user_ids;
    cleaned['m.mentions'] =
      Array.isArray(userIds) &&
      userIds.every((id): id is string => typeof id === 'string')
        ? { user_ids: userIds }
        : {};
  }
  const relatesTo = additionalKwargs['m.relates_to'];
  if (isRecord(relatesTo)) {
    const inReplyTo = relatesTo['m.in_reply_to'];
    cleaned['m.relates_to'] =
      isRecord(inReplyTo) && typeof inReplyTo.event_id === 'string'
        ? { 'm.in_reply_to': { event_id: inReplyTo.event_id } }
        : {};
  }
  const { reasoning, reasoningDetails } = extractReasoning(additionalKwargs);
  if (reasoning !== undefined) cleaned.reasoning = reasoning;
  if (reasoningDetails !== undefined)
    cleaned.reasoningDetails = reasoningDetails;
  return cleaned;
}

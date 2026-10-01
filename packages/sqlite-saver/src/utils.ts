/* eslint-disable */
// @ts-nocheck

// Stringify that can handle circular references.
// Inlined due to ESM import issues
// Source: https://www.npmjs.com/package/fast-safe-stringify

var LIMIT_REPLACE_NODE = '[...]';
var CIRCULAR_REPLACE_NODE = '[Circular]';

var arr = [];
var replacerStack = [];

function defaultOptions() {
  return {
    depthLimit: Number.MAX_SAFE_INTEGER,
    edgesLimit: Number.MAX_SAFE_INTEGER,
  };
}

// Regular stringify
export function stringify(obj, replacer?, spacer?, options?) {
  if (typeof options === 'undefined') {
    options = defaultOptions();
  }

  decirc(obj, '', 0, [], undefined, 0, options);
  var res;
  try {
    if (replacerStack.length === 0) {
      res = JSON.stringify(obj, replacer, spacer);
    } else {
      res = JSON.stringify(obj, replaceGetterValues(replacer), spacer);
    }
  } catch (_) {
    return JSON.stringify(
      '[unable to serialize, circular reference is too complex to analyze]',
    );
  } finally {
    while (arr.length !== 0) {
      var part = arr.pop();
      if (part.length === 4) {
        Object.defineProperty(part[0], part[1], part[3]);
      } else {
        part[0][part[1]] = part[2];
      }
    }
  }
  return res;
}

function setReplace(replace, val, k, parent) {
  var propertyDescriptor = Object.getOwnPropertyDescriptor(parent, k);
  if (propertyDescriptor.get !== undefined) {
    if (propertyDescriptor.configurable) {
      Object.defineProperty(parent, k, { value: replace });
      arr.push([parent, k, val, propertyDescriptor]);
    } else {
      replacerStack.push([val, k, replace]);
    }
  } else {
    parent[k] = replace;
    arr.push([parent, k, val]);
  }
}

function decirc(val, k, edgeIndex, stack, parent, depth, options) {
  depth += 1;
  var i;
  if (typeof val === 'object' && val !== null) {
    for (i = 0; i < stack.length; i++) {
      if (stack[i] === val) {
        setReplace(CIRCULAR_REPLACE_NODE, val, k, parent);
        return;
      }
    }

    if (
      typeof options.depthLimit !== 'undefined' &&
      depth > options.depthLimit
    ) {
      setReplace(LIMIT_REPLACE_NODE, val, k, parent);
      return;
    }

    if (
      typeof options.edgesLimit !== 'undefined' &&
      edgeIndex + 1 > options.edgesLimit
    ) {
      setReplace(LIMIT_REPLACE_NODE, val, k, parent);
      return;
    }

    stack.push(val);
    // Optimize for Arrays. Big arrays could kill the performance otherwise!
    if (Array.isArray(val)) {
      for (i = 0; i < val.length; i++) {
        decirc(val[i], i, i, stack, val, depth, options);
      }
    } else {
      var keys = Object.keys(val);
      for (i = 0; i < keys.length; i++) {
        var key = keys[i];
        decirc(val[key], key, i, stack, val, depth, options);
      }
    }
    stack.pop();
  }
}

// Stable-stringify
function compareFunction(a, b) {
  if (a < b) {
    return -1;
  }
  if (a > b) {
    return 1;
  }
  return 0;
}

function deterministicStringify(obj, replacer, spacer, options) {
  if (typeof options === 'undefined') {
    options = defaultOptions();
  }

  var tmp = deterministicDecirc(obj, '', 0, [], undefined, 0, options) || obj;
  var res;
  try {
    if (replacerStack.length === 0) {
      res = JSON.stringify(tmp, replacer, spacer);
    } else {
      res = JSON.stringify(tmp, replaceGetterValues(replacer), spacer);
    }
  } catch (_) {
    return JSON.stringify(
      '[unable to serialize, circular reference is too complex to analyze]',
    );
  } finally {
    // Ensure that we restore the object as it was.
    while (arr.length !== 0) {
      var part = arr.pop();
      if (part.length === 4) {
        Object.defineProperty(part[0], part[1], part[3]);
      } else {
        part[0][part[1]] = part[2];
      }
    }
  }
  return res;
}

function deterministicDecirc(val, k, edgeIndex, stack, parent, depth, options) {
  depth += 1;
  var i;
  if (typeof val === 'object' && val !== null) {
    for (i = 0; i < stack.length; i++) {
      if (stack[i] === val) {
        setReplace(CIRCULAR_REPLACE_NODE, val, k, parent);
        return;
      }
    }
    try {
      if (typeof val.toJSON === 'function') {
        return;
      }
    } catch (_) {
      return;
    }

    if (
      typeof options.depthLimit !== 'undefined' &&
      depth > options.depthLimit
    ) {
      setReplace(LIMIT_REPLACE_NODE, val, k, parent);
      return;
    }

    if (
      typeof options.edgesLimit !== 'undefined' &&
      edgeIndex + 1 > options.edgesLimit
    ) {
      setReplace(LIMIT_REPLACE_NODE, val, k, parent);
      return;
    }

    stack.push(val);
    // Optimize for Arrays. Big arrays could kill the performance otherwise!
    if (Array.isArray(val)) {
      for (i = 0; i < val.length; i++) {
        deterministicDecirc(val[i], i, i, stack, val, depth, options);
      }
    } else {
      // Create a temporary object in the required way
      var tmp = {};
      var keys = Object.keys(val).sort(compareFunction);
      for (i = 0; i < keys.length; i++) {
        var key = keys[i];
        deterministicDecirc(val[key], key, i, stack, val, depth, options);
        tmp[key] = val[key];
      }
      if (typeof parent !== 'undefined') {
        arr.push([parent, k, val]);
        parent[k] = tmp;
      } else {
        return tmp;
      }
    }
    stack.pop();
  }
}

// wraps replacer function to handle values we couldn't replace
// and mark them as replaced value
function replaceGetterValues(replacer) {
  replacer =
    typeof replacer !== 'undefined'
      ? replacer
      : function (k, v) {
          return v;
        };
  return function (key, val) {
    if (replacerStack.length > 0) {
      for (var i = 0; i < replacerStack.length; i++) {
        var part = replacerStack[i];
        if (part[1] === key && part[0] === val) {
          val = part[2];
          replacerStack.splice(i, 1);
          break;
        }
      }
    }
    return replacer.call(this, key, val);
  };
}

function _encodeConstructorArgs(
  // eslint-disable-next-line @typescript-eslint/ban-types
  constructor: Function,
  method?: string,
  args?: any[],
  kwargs?: Record<string, any>,
): object {
  return {
    lc: 2,
    type: 'constructor',
    id: [constructor.name],
    method: method ?? null,
    args: args ?? [],
    kwargs: kwargs ?? {},
  };
}

export function _default(obj: any): any {
  if (obj === undefined) {
    return {
      lc: 2,
      type: 'undefined',
    };
  } else if (obj instanceof Set || obj instanceof Map) {
    return _encodeConstructorArgs(obj.constructor, undefined, [
      Array.from(obj),
    ]);
  } else if (obj instanceof RegExp) {
    return _encodeConstructorArgs(RegExp, undefined, [obj.source, obj.flags]);
  } else if (obj instanceof Error) {
    return _encodeConstructorArgs(obj.constructor, undefined, [obj.message]);
    // TODO: Remove special case
  } else if (obj?.lg_name === 'Send') {
    return {
      node: obj.node,
      args: obj.args,
    };
  } else {
    return obj;
  }
}

export interface AttachmentMeta {
  filename: string;
  mimetype: string;
  size?: number;
  mxcUri?: string;
  eventId?: string;
  category: string;
}

export interface CleanAdditionalKwargs {
  msgFromMatrixRoom: boolean;
  timestamp: string;
  oracleName: string;
  /**
   * Provenance marker set by LangChain middlewares (e.g. `"summarization"`
   * on the condensed-history message). Preserved so list endpoints can
   * filter middleware-authored messages out of the user-visible transcript.
   */
  lc_source?: string;
  reasoning?: string;
  reasoningDetails?: Array<{
    type: string;
    text: string;
  }>;
  attachment?: AttachmentMeta;
  attachments?: AttachmentMeta[];
  // Group-chat speaker + threading metadata. The Matrix transport stashes
  // these so the group-chat gating middleware can find them across turns —
  // without this allowlist entry, the saver would strip them and the gate
  // would silently let every message through.
  senderDid?: string;
  senderMatrixUserId?: string;
  senderDisplayName?: string;
  threadId?: string;
  eventId?: string;
  isGroupChat?: boolean;
  'm.mentions'?: { user_ids?: string[] };
  'm.relates_to'?: { 'm.in_reply_to'?: { event_id: string } };
  [key: string]: unknown; // Allow additional properties for LangChain compatibility
}

/**
 * Cleans up additional_kwargs by extracting reasoning information and keeping only essential fields
 * @param additionalKwargs - The original additional_kwargs object
 * @param msgFromMatrixRoom - Whether the message came from Matrix room
 * @returns Cleaned additional_kwargs with only essential fields
 */
export function cleanAdditionalKwargs(
  additionalKwargs: any,
  msgFromMatrixRoom: boolean,
): CleanAdditionalKwargs {
  // Extract reasoning information from raw response
  // Note: Reasoning is only available when the AI model supports it (e.g., GPT-OSS-120B with include_reasoning: true)
  const rawResponse = additionalKwargs.__raw_response as any;

  // Check if reasoning exists in the response
  // Reasoning will not be present in all AI responses, only when the model supports it
  const hasReasoning = rawResponse?.choices?.[0]?.delta?.reasoning;
  const reasoning = hasReasoning
    ? rawResponse.choices[0].delta.reasoning
    : undefined;
  const reasoningDetails =
    hasReasoning && rawResponse.choices[0].delta.reasoning_details
      ? rawResponse.choices[0].delta.reasoning_details
      : undefined;

  // Return cleaned additional_kwargs with only essential fields.
  // An existing timestamp is preserved: every checkpoint `put` rewrites every
  // message row, so stamping "now" here would churn `created_at` on the whole
  // thread each super-step and destroy the transcript's chronological order.
  const cleanedKwargs: CleanAdditionalKwargs = {
    msgFromMatrixRoom,
    timestamp:
      typeof additionalKwargs.timestamp === 'string' &&
      additionalKwargs.timestamp.length > 0
        ? additionalKwargs.timestamp
        : new Date().toISOString(),
    oracleName: process.env.ORACLE_NAME || 'IXO Oracle',
    ...(typeof additionalKwargs.lc_source === 'string' && {
      lc_source: additionalKwargs.lc_source,
    }),
    ...(additionalKwargs.attachment && {
      attachment: additionalKwargs.attachment as AttachmentMeta,
    }),
    ...(Array.isArray(additionalKwargs.attachments) &&
      additionalKwargs.attachments.length > 0 && {
        attachments: additionalKwargs.attachments as AttachmentMeta[],
      }),
    // Preserve group-chat speaker + threading metadata when present —
    // the group-chat gating middleware needs these to decide whether
    // the bot should reply, and they're cheap to keep.
    ...(typeof additionalKwargs.senderDid === 'string' && {
      senderDid: additionalKwargs.senderDid,
    }),
    ...(typeof additionalKwargs.senderMatrixUserId === 'string' && {
      senderMatrixUserId: additionalKwargs.senderMatrixUserId,
    }),
    ...(typeof additionalKwargs.senderDisplayName === 'string' && {
      senderDisplayName: additionalKwargs.senderDisplayName,
    }),
    ...(typeof additionalKwargs.threadId === 'string' && {
      threadId: additionalKwargs.threadId,
    }),
    ...(typeof additionalKwargs.eventId === 'string' && {
      eventId: additionalKwargs.eventId,
    }),
    ...(typeof additionalKwargs.isGroupChat === 'boolean' && {
      isGroupChat: additionalKwargs.isGroupChat,
    }),
    ...(additionalKwargs['m.mentions'] &&
      typeof additionalKwargs['m.mentions'] === 'object' && {
        'm.mentions': additionalKwargs['m.mentions'],
      }),
    ...(additionalKwargs['m.relates_to'] &&
      typeof additionalKwargs['m.relates_to'] === 'object' && {
        'm.relates_to': additionalKwargs['m.relates_to'],
      }),
  };

  // Add reasoning fields only if they exist
  if (reasoning) {
    cleanedKwargs.reasoning = reasoning;
  }
  if (
    reasoningDetails &&
    Array.isArray(reasoningDetails) &&
    reasoningDetails.length > 0
  ) {
    // Clean up reasoning details - remove useless format field and keep only useful data
    cleanedKwargs.reasoningDetails = reasoningDetails
      .filter(
        (
          detail,
        ): detail is NonNullable<
          CleanAdditionalKwargs['reasoningDetails']
        >[number] => {
          // Type guard to ensure detail has required properties
          return (
            detail &&
            typeof detail === 'object' &&
            typeof detail.type === 'string' &&
            typeof detail.text === 'string' &&
            detail.text.trim().length > 0 // Only keep details with actual text content
          );
        },
      )
      .map((detail) => ({
        type: detail.type,
        text: detail.text,
        // Skip index and format fields - not useful
      }));
  }

  return cleanedKwargs;
}

/**
 * Call ids on the ChatGPT lane's Responses requests.
 *
 * The Responses API rejects an input item whose `call_id` is longer than 64
 * characters ("Invalid 'input[10].call_id': string too long ... maximum
 * length 64"). Stored history can hold longer ones: a tool call id is minted
 * by whichever model answered an earlier turn, or by the runtime itself (a
 * sub-agent's forwarded tool calls are renamed `<parent call id>_<call id>`),
 * and the same thread is later replayed to the ChatGPT backend. The backend
 * is stateless here (`store: false`): it only needs a `function_call` item
 * and its `function_call_output` to carry the same `call_id`, not the id it
 * issued, so an over-long id is replaced in the outgoing request only. The
 * stored message, the turn's tool marks and the transcript keep the original.
 *
 * The replacement is `call_` + the unpadded base64url of the SHA-256 of the
 * original id: 48 characters, a function of the original alone (retries and
 * resumes send the same id), and the whole digest, never a truncation of it.
 * A request in which a replacement would equal a different call id of the
 * same request is refused rather than sent.
 */

/** The Responses API's limit on `call_id`. */
export const MAX_CALL_ID_LENGTH = 64;

const REPLACEMENT_PREFIX = 'call_';

function base64Url(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary)
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

/** The id sent in place of an over-long `callId`. */
export async function shortCallId(callId: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(callId),
  );
  return `${REPLACEMENT_PREFIX}${base64Url(new Uint8Array(digest))}`;
}

export class CallIdCollisionError extends Error {
  constructor(shortened: string) {
    super(
      `[byo-chatgpt] shortening a tool call id would collide with another call id of the request (${shortened})`,
    );
    this.name = 'CallIdCollisionError';
  }
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

/**
 * The request body with every over-long `input[].call_id` replaced (one
 * replacement per distinct original, so a call and its output still match).
 * A body that is not a JSON object with an `input` array, or that has no
 * over-long id, is returned as it came.
 */
export async function shortenCallIds(body: string): Promise<string> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return body;
  }
  const request = asRecord(parsed);
  const input = request?.['input'];
  if (!request || !Array.isArray(input)) return body;

  const items = input.flatMap((item) => {
    const record = asRecord(item);
    return record && typeof record['call_id'] === 'string' ? [record] : [];
  });
  const longIds = new Set<string>();
  const keptIds = new Set<string>();
  for (const item of items) {
    const callId = item['call_id'] as string;
    (callId.length > MAX_CALL_ID_LENGTH ? longIds : keptIds).add(callId);
  }
  if (longIds.size === 0) return body;

  const replacements = new Map<string, string>();
  for (const callId of longIds) {
    const shortened = await shortCallId(callId);
    if (keptIds.has(shortened)) throw new CallIdCollisionError(shortened);
    replacements.set(callId, shortened);
  }
  if (new Set(replacements.values()).size !== replacements.size) {
    throw new CallIdCollisionError('two over-long ids');
  }
  for (const item of items) {
    const replacement = replacements.get(item['call_id'] as string);
    if (replacement !== undefined) item['call_id'] = replacement;
  }
  return JSON.stringify(request);
}

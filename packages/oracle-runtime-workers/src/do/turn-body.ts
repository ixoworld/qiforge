/**
 * `POST /messages/:id` body validation — the Workers counterpart of Node's
 * `SendMessageDto` under a `ValidationPipe({ whitelist, forbidNonWhitelisted })`
 * behind express body-parser: malformed JSON, unknown top-level fields and a
 * missing `message` are all 400s, never a failed turn or a 500.
 */

/** Top-level fields of Node's `SendMessageDto`; anything else is rejected. */
export const TURN_BODY_KEYS: ReadonlySet<string> = new Set([
  'message',
  'stream',
  'returnAllMessages',
  'model',
  'tools',
  'agActions',
  'metadata',
  'timezone',
  'homeServer',
  'mcpInvocations',
  'attachments',
  'requestId',
]);

export interface TurnBody {
  message: string;
  stream?: boolean;
  returnAllMessages?: boolean;
  timezone?: string;
  model?: string;
  /**
   * Free-form client metadata (Node's `SendMessageDto.metadata`); the runtime
   * reads `editorRoomId`, `spaceId`, `sessionRunId` and `currentEntityDid`.
   */
  metadata?: Record<string, unknown> & {
    editorRoomId?: string;
    spaceId?: string;
    sessionRunId?: string;
    currentEntityDid?: string | null;
  };
  tools?: Array<{
    name: string;
    description: string;
    schema: Record<string, unknown>;
  }>;
  agActions?: Array<{
    name: string;
    description: string;
    schema: Record<string, unknown>;
    hasRender?: boolean;
  }>;
  attachments?: unknown[];
}

export type ParsedTurnBody =
  | { ok: true; body: TurnBody }
  | { ok: false; status: 400; message: string };

const reject = (message: string): ParsedTurnBody => ({
  ok: false,
  status: 400,
  message,
});

/** Parse and validate a raw request body. Never throws. */
export function parseTurnBody(raw: string): ParsedTurnBody {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return reject('Invalid JSON body');
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return reject('Request body must be a JSON object');
  }
  const record = parsed as Record<string, unknown>;
  const unknownProp = Object.keys(record).find((k) => !TURN_BODY_KEYS.has(k));
  if (unknownProp !== undefined) {
    return reject(`property ${unknownProp} should not exist`);
  }
  if (typeof record.message !== 'string' || record.message.length === 0) {
    return reject('message is required');
  }
  return { ok: true, body: record as unknown as TurnBody };
}

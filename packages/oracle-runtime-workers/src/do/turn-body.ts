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
  'multitask',
]);

export interface TurnBody {
  message: string;
  stream?: boolean;
  /** `interrupt` (default) or `enqueue` — see `TurnRequest.multitask`. */
  multitask?: 'interrupt' | 'enqueue';
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
    currentEntityDid?: string;
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

type ToolDeclaration = NonNullable<TurnBody['tools']>[number];

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** A client-declared tool (or AG-UI action): name, description, schema. */
function toolDeclaration(value: unknown): ToolDeclaration | null {
  if (
    !isRecord(value) ||
    typeof value.name !== 'string' ||
    typeof value.description !== 'string' ||
    !isRecord(value.schema)
  )
    return null;
  return {
    name: value.name,
    description: value.description,
    schema: value.schema,
  };
}

/**
 * Parse and validate a raw request body. Never throws. Every field the
 * runtime reads is checked for its type here, so a wrong one is a 400 and
 * not a failed turn later; the accepted fields the runtime ignores
 * (`homeServer`, `mcpInvocations`, `requestId`) are not passed on.
 */
export function parseTurnBody(raw: string): ParsedTurnBody {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return reject('Invalid JSON body');
  }
  if (!isRecord(parsed)) {
    return reject('Request body must be a JSON object');
  }
  const unknownProp = Object.keys(parsed).find((k) => !TURN_BODY_KEYS.has(k));
  if (unknownProp !== undefined) {
    return reject(`property ${unknownProp} should not exist`);
  }
  // A field sent as `null` is a field not sent (clients serialise unset
  // optionals either way).
  const record = Object.fromEntries(
    Object.entries(parsed).filter(([, value]) => value !== null),
  );
  if (typeof record.message !== 'string' || record.message.length === 0) {
    return reject('message is required');
  }
  const { stream, returnAllMessages, timezone, model, metadata, attachments } =
    record;
  if (
    record.multitask !== undefined &&
    record.multitask !== 'interrupt' &&
    record.multitask !== 'enqueue'
  ) {
    return reject('multitask must be one of: interrupt, enqueue');
  }
  for (const [name, value] of [
    ['stream', stream],
    ['returnAllMessages', returnAllMessages],
  ] as const)
    if (value !== undefined && typeof value !== 'boolean')
      return reject(`${name} must be a boolean`);
  for (const [name, value] of [
    ['timezone', timezone],
    ['model', model],
    ['homeServer', record.homeServer],
    ['requestId', record.requestId],
  ] as const)
    if (value !== undefined && typeof value !== 'string')
      return reject(`${name} must be a string`);
  if (metadata !== undefined && !isRecord(metadata))
    return reject('metadata must be an object');
  if (attachments !== undefined && !Array.isArray(attachments))
    return reject('attachments must be an array');
  let tools: ToolDeclaration[] | undefined;
  if (record.tools !== undefined) {
    if (!Array.isArray(record.tools)) return reject('tools must be an array');
    tools = [];
    for (const item of record.tools) {
      const tool = toolDeclaration(item);
      if (!tool)
        return reject(
          'each tool needs a string name, description and an object schema',
        );
      tools.push(tool);
    }
  }
  let agActions: NonNullable<TurnBody['agActions']> | undefined;
  if (record.agActions !== undefined) {
    if (!Array.isArray(record.agActions))
      return reject('agActions must be an array');
    agActions = [];
    for (const item of record.agActions) {
      const action = toolDeclaration(item);
      const hasRender = isRecord(item) ? item.hasRender : undefined;
      if (
        !action ||
        (hasRender !== undefined && typeof hasRender !== 'boolean')
      )
        return reject(
          'each agAction needs a string name, description and an object schema',
        );
      agActions.push(
        hasRender === undefined ? action : { ...action, hasRender },
      );
    }
  }
  return {
    ok: true,
    body: {
      message: record.message,
      ...(typeof stream === 'boolean' ? { stream } : {}),
      ...(record.multitask === 'interrupt' || record.multitask === 'enqueue'
        ? { multitask: record.multitask }
        : {}),
      ...(typeof returnAllMessages === 'boolean' ? { returnAllMessages } : {}),
      ...(typeof timezone === 'string' ? { timezone } : {}),
      ...(typeof model === 'string' ? { model } : {}),
      ...(isRecord(metadata) ? { metadata } : {}),
      ...(tools ? { tools } : {}),
      ...(agActions ? { agActions } : {}),
      ...(Array.isArray(attachments) ? { attachments } : {}),
    },
  };
}

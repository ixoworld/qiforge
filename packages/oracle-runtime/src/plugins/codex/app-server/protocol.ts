import { z } from 'zod';

/**
 * Wire method names for the Codex App Server. Centralized here because the
 * protocol has renamed methods across Codex releases — an upgrade changes
 * this table, not the adapter.
 */
export const CODEX_METHODS = {
  initialize: 'initialize',
  initialized: 'initialized',
  threadStart: 'thread/start',
  threadResume: 'thread/resume',
  turnStart: 'turn/start',
  turnInterrupt: 'turn/interrupt',
  accountRead: 'account/read',
} as const;

/** Notifications the server pushes during a turn. */
export const CODEX_NOTIFICATIONS = {
  turnStarted: 'turn/started',
  turnCompleted: 'turn/completed',
  itemStarted: 'item/started',
  itemCompleted: 'item/completed',
  agentMessageDelta: 'item/agentMessage/delta',
  reasoningDelta: 'item/reasoning/textDelta',
} as const;

/** Server→client requests. Each one blocks the turn until answered. */
export const CODEX_APPROVAL_REQUESTS = {
  commandExecution: 'item/commandExecution/requestApproval',
  fileChange: 'item/fileChange/requestApproval',
} as const;

export const CODEX_APPROVAL_DECISIONS = [
  'accept',
  'acceptForSession',
  'decline',
  'cancel',
] as const;
export type CodexApprovalDecision = (typeof CODEX_APPROVAL_DECISIONS)[number];

/**
 * The App Server speaks a JSON-RPC variant that omits the `jsonrpc` version
 * field on the wire. Frames are newline-delimited JSON.
 */
export const jsonRpcIdSchema = z.union([z.string(), z.number()]);

export const jsonRpcRequestSchema = z.object({
  id: jsonRpcIdSchema,
  method: z.string(),
  params: z.unknown().optional(),
});

export const jsonRpcResponseSchema = z.object({
  id: jsonRpcIdSchema,
  result: z.unknown().optional(),
  error: z
    .object({
      code: z.number(),
      message: z.string(),
      data: z.unknown().optional(),
    })
    .optional(),
});

export const jsonRpcNotificationSchema = z.object({
  method: z.string(),
  params: z.unknown().optional(),
});

export type JsonRpcId = z.infer<typeof jsonRpcIdSchema>;

/** An inbound frame, discriminated by shape rather than by a version field. */
export type CodexInboundFrame =
  | {
      kind: 'response';
      id: JsonRpcId;
      result?: unknown;
      error?: { code: number; message: string };
    }
  | { kind: 'request'; id: JsonRpcId; method: string; params: unknown }
  | { kind: 'notification'; method: string; params: unknown };

/** Classify a decoded JSON frame. Returns null for anything unrecognised. */
export function classifyFrame(raw: unknown): CodexInboundFrame | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const frame = raw as Record<string, unknown>;

  const hasId = 'id' in frame && frame.id !== null && frame.id !== undefined;
  const hasMethod = typeof frame.method === 'string';

  if (hasId && hasMethod) {
    const parsed = jsonRpcRequestSchema.safeParse(frame);
    if (!parsed.success) return null;
    return {
      kind: 'request',
      id: parsed.data.id,
      method: parsed.data.method,
      params: parsed.data.params ?? {},
    };
  }

  if (hasId) {
    const parsed = jsonRpcResponseSchema.safeParse(frame);
    if (!parsed.success) return null;
    return {
      kind: 'response',
      id: parsed.data.id,
      ...(parsed.data.error ? { error: parsed.data.error } : {}),
      result: parsed.data.result,
    };
  }

  if (hasMethod) {
    const parsed = jsonRpcNotificationSchema.safeParse(frame);
    if (!parsed.success) return null;
    return {
      kind: 'notification',
      method: parsed.data.method,
      params: parsed.data.params ?? {},
    };
  }

  return null;
}

// ---------------------------------------------------------------------------
// Result payloads
// ---------------------------------------------------------------------------

export const threadStartResultSchema = z.object({
  thread: z.object({ id: z.string().min(1) }),
});

export const turnStartResultSchema = z.object({
  turn: z.object({ id: z.string().min(1), status: z.string().optional() }),
});

/**
 * `account/read` reports how the App Server itself is authenticated. The
 * harness uses it as the authoritative check — the presence of a credential
 * file or env var is necessary, not sufficient.
 */
export const accountReadResultSchema = z.object({
  account: z
    .object({
      authMode: z.string().optional(),
      planType: z.string().optional(),
      email: z.string().optional(),
    })
    .nullable()
    .optional(),
});

// ---------------------------------------------------------------------------
// Notification payloads
// ---------------------------------------------------------------------------

export const turnStartedParamsSchema = z.object({
  turn: z.object({ id: z.string() }),
});

export const turnCompletedParamsSchema = z.object({
  turn: z.object({
    id: z.string(),
    status: z.enum(['completed', 'interrupted', 'failed']).optional(),
    error: z.object({ message: z.string() }).optional(),
  }),
});

export const itemParamsSchema = z.object({
  item: z.object({
    id: z.string(),
    type: z.string().optional(),
    status: z.string().optional(),
    text: z.string().optional(),
    command: z.string().optional(),
  }),
});

export const deltaParamsSchema = z.object({
  itemId: z.string().optional(),
  delta: z.string(),
});

export const approvalParamsSchema = z.object({
  itemId: z.string().optional(),
  threadId: z.string().optional(),
  turnId: z.string().optional(),
  command: z.string().optional(),
  cwd: z.string().optional(),
  reason: z.string().optional(),
});

export type CodexApprovalParams = z.infer<typeof approvalParamsSchema>;

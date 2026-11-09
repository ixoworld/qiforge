import { z } from 'zod';

const text = z.string().min(1).max(512);
const requestId = z.string().uuid();
const jsonValue = z.json();
export type JsonValue = z.infer<typeof jsonValue>;
const values = z.record(z.string().max(256), jsonValue);
// Requests are strict: a field this version does not know is refused.
// Stored records and responses are read with the same shapes but strip
// unknown fields, so an added field never breaks an older reader. Adding a
// value to a closed list (`status`, `cancelReason`, an owner `kind`) is a
// contract version change: an older reader refuses such a record.
const claimOwnerShape = {
  kind: z.literal('flow-claim'),
  flowId: text,
  runId: text,
  stepId: text,
  collectionId: text,
  schemaDigest: text,
  network: text,
  accountDid: text,
};
const claimBlockOwnerShape = {
  ...claimOwnerShape,
  kind: z.literal('flow-claim-block'),
};
const bidOwnerShape = {
  ...claimOwnerShape,
  kind: z.literal('flow-bid'),
  roleId: text,
  groupId: text.optional(),
};
const approvalOwnerShape = {
  kind: z.literal('approval'),
  family: z.enum(['plugin', 'domain-write', 'recipe-release']),
  requestKey: text,
  accountDid: text,
};
const claimOwner = z.strictObject(claimOwnerShape);
const claimBlockOwner = z.strictObject(claimBlockOwnerShape);
const bidOwner = z.strictObject(bidOwnerShape);
const approvalOwner = z.strictObject(approvalOwnerShape);
const matrixEventLocatorShape = {
  family: z.enum([
    'matrix-flow-input',
    'matrix-evaluation-review',
    'matrix-commerce',
  ]),
  roomId: text,
  eventId: text,
  revision: text,
  threadRootEventId: text.optional(),
};
const topicLocatorShape = {
  family: z.enum(['topic-proposal', 'topic-outcome', 'topic-review']),
  roomId: text,
  topicId: text,
  threadRootEventId: text,
  eventId: text,
  revision: text,
};
const flowDetailLocatorShape = {
  family: z.literal('flow-detail'),
  roomId: text,
  flowId: text,
  runId: text,
  stepId: text,
  actionType: text,
  revision: text,
};
const flowDetailSelectionShape = {
  kind: z.literal('claim'),
  claimId: text,
  collectionId: text,
  resultDigest: text.optional(),
};
const workbenchLocatorShape = {
  family: z.literal('workbench-proposal'),
  entityDid: text,
  formId: text,
  baseContentHash: text,
  proposalDigest: text,
};
/** Locators only. The native owner revalidates access, revision and every human action. */
export const OwnerReferenceLocatorSchema = z.discriminatedUnion('family', [
  z.strictObject(matrixEventLocatorShape),
  z.strictObject(topicLocatorShape),
  z.strictObject({
    ...flowDetailLocatorShape,
    selection: z.strictObject(flowDetailSelectionShape).optional(),
  }),
  z.strictObject(workbenchLocatorShape),
]);
export type OwnerReferenceLocator = z.infer<typeof OwnerReferenceLocatorSchema>;
const ownerReference = z.strictObject({
  kind: z.literal('owner-reference'),
  accountDid: text,
  locator: OwnerReferenceLocatorSchema,
});
const storedOwnerReference = z.object({
  kind: z.literal('owner-reference'),
  accountDid: text,
  locator: z.discriminatedUnion('family', [
    z.object(matrixEventLocatorShape),
    z.object(topicLocatorShape),
    z.object({
      ...flowDetailLocatorShape,
      selection: z.object(flowDetailSelectionShape).optional(),
    }),
    z.object(workbenchLocatorShape),
  ]),
});
export const DispatchOwnerSchema = z.discriminatedUnion('kind', [
  claimOwner,
  claimBlockOwner,
  bidOwner,
  approvalOwner,
]);
export const InteractionOwnerSchema = z.discriminatedUnion('kind', [
  claimOwner,
  claimBlockOwner,
  bidOwner,
  approvalOwner,
  ownerReference,
  z.strictObject({ kind: z.literal('task'), taskId: text }),
  z.strictObject({ kind: z.literal('question'), requestId: text }),
  z.strictObject({ kind: z.literal('artifact'), artifactId: text }),
]);
const storedOwner = z.discriminatedUnion('kind', [
  z.object(claimOwnerShape),
  z.object(claimBlockOwnerShape),
  z.object(bidOwnerShape),
  z.object(approvalOwnerShape),
  storedOwnerReference,
  z.object({ kind: z.literal('task'), taskId: text }),
  z.object({ kind: z.literal('question'), requestId: text }),
  z.object({ kind: z.literal('artifact'), artifactId: text }),
]);
const context = { version: z.literal(1), requestId, sessionId: text };
export const PrepareInteractionSchema = z.strictObject({
  ...context,
  owner: InteractionOwnerSchema,
  values,
  /**
   * Asks for another operation on an owner that already has a reported one,
   * for owner kinds that repeat (a Flow claim step takes many claims).
   * Without it, such an owner keeps its submitted card. Send it only to a
   * runtime whose `/health` lists the `repeat` operation: an older runtime
   * refuses the field.
   */
  repeat: z.boolean().optional(),
});
/**
 * The `expiresAt` of a card kind without an action window. It stays open for
 * as long as its chat, so every reader, an older one included, keeps it open.
 */
export const NO_ACTION_WINDOW = Date.UTC(9999, 11, 31, 23, 59, 59, 999);
const mutation = { ...context, expectedRevision: z.number().int().positive() };
export const UpdateInteractionSchema = z.discriminatedUnion('kind', [
  z
    .strictObject({
      ...mutation,
      kind: z.literal('update'),
      patch: values,
      remove: z.array(z.string().min(1).max(256)).max(256).optional(),
      source: z.enum(['agent', 'user']),
    })
    .refine(
      (input) => {
        const removed = input.remove ?? [];
        return (
          new Set(removed).size === removed.length &&
          removed.every((name) => !Object.hasOwn(input.patch, name))
        );
      },
      {
        message:
          'Removed fields must be unique and cannot also appear in the patch',
      },
    ),
  z.strictObject({ ...mutation, kind: z.literal('cancel') }),
]);
export const ReserveInteractionSchema = z.strictObject({
  ...mutation,
  valuesDigest: z.string().regex(/^[a-f0-9]{64}$/),
});
export const ObserveInteractionSchema = z.discriminatedUnion('outcome', [
  z.strictObject({
    ...mutation,
    operationKey: requestId,
    outcome: z.literal('unknown'),
    receipt: values.optional(),
  }),
  /**
   * The executor refused before anything was sent (a declined signature,
   * an input or eligibility refusal). Only for a reservation that is still
   * `reserved`: it ends the card and releases the step for another attempt.
   */
  z.strictObject({
    ...mutation,
    operationKey: requestId,
    outcome: z.literal('not-submitted'),
  }),
  z.strictObject({
    ...mutation,
    operationKey: requestId,
    outcome: z.literal('reported'),
    ownerExecutionRef: text,
    receipt: values.optional(),
  }),
  z.strictObject({
    ...mutation,
    operationKey: requestId,
    outcome: z.literal('partial'),
    ownerExecutionRef: text,
    receipt: values.optional(),
  }),
]);
export const CheckClaimDispatchSchema = z
  .strictObject({
    version: z.literal(1),
    owner: claimOwner,
    cardRef: requestId.optional(),
    operationKey: requestId.optional(),
    valuesDigest: z
      .string()
      .regex(/^[a-f0-9]{64}$/)
      .optional(),
  })
  .refine((input) => Boolean(input.cardRef) === Boolean(input.operationKey), {
    message: 'cardRef and operationKey must be supplied together',
  });
export const CheckDispatchSchema = z
  .strictObject({
    version: z.literal(1),
    owner: DispatchOwnerSchema,
    cardRef: requestId.optional(),
    operationKey: requestId.optional(),
    valuesDigest: z
      .string()
      .regex(/^[a-f0-9]{64}$/)
      .optional(),
  })
  .refine((input) => Boolean(input.cardRef) === Boolean(input.operationKey), {
    message: 'cardRef and operationKey must be supplied together',
  });
export type CheckDispatch = z.infer<typeof CheckDispatchSchema>;
export type CheckClaimDispatch = z.infer<typeof CheckClaimDispatchSchema>;
export const ClaimDispatchResultSchema = z.object({
  allowed: z.literal(true),
  managed: z.boolean(),
});
export const InteractionSchema = z.object({
  version: z.literal(1),
  id: requestId,
  revision: z.number().int().positive(),
  sessionId: text,
  oracleDid: text,
  owner: storedOwner,
  values,
  updatedByUser: z.array(z.string()),
  status: z.enum([
    'draft',
    'reserved',
    'outcome-unknown',
    'observed',
    'partial',
    'cancelled',
  ]),
  createdAt: z.number().int(),
  expiresAt: z.number().int(),
  reservation: z
    .object({ operationKey: requestId, valuesDigest: text })
    .optional(),
  ownerExecutionRef: text.optional(),
  receipt: values.optional(),
  /**
   * Why a `cancelled` draft ended: `user` when a person or the agent
   * cancelled it; `superseded` when the same claim step was submitted from
   * the ordinary form (or a newer card replaced a stale one) before this
   * draft's operation reached the executor; `not-submitted` when the host
   * reported that the executor refused before sending anything. Absent on
   * records written before the field existed.
   */
  cancelReason: z.enum(['user', 'superseded', 'not-submitted']).optional(),
});
export const InteractionReferenceSchema = InteractionSchema.omit({
  values: true,
  updatedByUser: true,
  receipt: true,
}).strip();
export type InteractionReference = z.infer<typeof InteractionReferenceSchema>;
export const InteractionResultSchema = z.object({
  interaction: InteractionSchema,
  replayed: z.boolean(),
});
export type Interaction = z.infer<typeof InteractionSchema>;
export type PrepareInteraction = z.infer<typeof PrepareInteractionSchema>;
export type UpdateInteraction = z.infer<typeof UpdateInteractionSchema>;
export type ReserveInteraction = z.infer<typeof ReserveInteractionSchema>;
export type ObserveInteraction = z.infer<typeof ObserveInteractionSchema>;
export type InteractionResult = z.infer<typeof InteractionResultSchema>;

/** Stable JSON encoding shared by the draft owner and the reviewing host. */
export function canonicalJson(value: JsonValue): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value !== null && typeof value === 'object')
    return `{${Object.entries(value)
      .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
      .map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`)
      .join(',')}}`;
  return JSON.stringify(value);
}
export async function interactionValuesDigest(
  value: Interaction['values'],
): Promise<string> {
  const hash = await crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(canonicalJson(value)),
  );
  return Array.from(new Uint8Array(hash), (byte) =>
    byte.toString(16).padStart(2, '0'),
  ).join('');
}

export class ActionInteractionError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

export function createActionInteractionsClient(options: {
  baseUrl: string;
  headers: () => Promise<HeadersInit>;
  fetch?: typeof fetch;
}) {
  const fetcher = options.fetch ?? fetch;
  async function request(
    path: string,
    method = 'GET',
    input?: unknown,
  ): Promise<unknown> {
    const headers = new Headers(await options.headers());
    if (input !== undefined) headers.set('content-type', 'application/json');
    const response = await fetcher(
      `${options.baseUrl.replace(/\/$/, '')}/action-interactions${path}`,
      {
        method,
        headers,
        ...(input !== undefined ? { body: JSON.stringify(input) } : {}),
      },
    );
    // A body limit, gateway or platform error page may not be JSON.
    const body: unknown = await response.json().catch(() => null);
    if (!response.ok) {
      // Interaction routes answer `{code, message}`; the shell's shared
      // authentication (401) and rate limit (429) answer `{statusCode,
      // message}`, so those get a code from their status.
      const error = z
        .object({ code: z.string().optional(), message: z.string() })
        .safeParse(body);
      const fallbackCode =
        response.status === 401
          ? 'unauthorized'
          : response.status === 429
            ? 'rate_limited'
            : 'request_failed';
      throw new ActionInteractionError(
        response.status,
        (error.success && error.data.code) || fallbackCode,
        error.success ? error.data.message : 'Interaction request failed',
      );
    }
    return body;
  }
  return {
    readTask: async (taskId: string, sessionId: string) =>
      z
        .object({ task: values })
        .parse(
          await request(
            `/tasks/${encodeURIComponent(taskId)}?sessionId=${encodeURIComponent(sessionId)}`,
          ),
        ),
    checkDispatch: async (input: CheckDispatch) =>
      ClaimDispatchResultSchema.parse(
        await request('/dispatch', 'POST', CheckDispatchSchema.parse(input)),
      ),
    checkClaimDispatch: async (input: CheckClaimDispatch) =>
      ClaimDispatchResultSchema.parse(
        await request(
          '/claim-dispatch',
          'POST',
          CheckClaimDispatchSchema.parse(input),
        ),
      ),
    listReferences: async (sessionId: string) =>
      z
        .array(InteractionReferenceSchema)
        .parse(
          await request(
            `?sessionId=${encodeURIComponent(sessionId)}&view=references`,
          ),
        ),
    /** One unreadable record is left out instead of failing the whole list. */
    list: async (sessionId: string) =>
      z
        .array(z.unknown())
        .parse(await request(`?sessionId=${encodeURIComponent(sessionId)}`))
        .flatMap((item) => {
          const record = InteractionSchema.safeParse(item);
          return record.success ? [record.data] : [];
        }),
    read: async (id: string, sessionId: string) =>
      InteractionSchema.parse(
        await request(
          `/${encodeURIComponent(id)}?sessionId=${encodeURIComponent(sessionId)}`,
        ),
      ),
    prepare: async (input: PrepareInteraction) =>
      InteractionResultSchema.parse(
        await request('', 'POST', PrepareInteractionSchema.parse(input)),
      ),
    update: async (id: string, input: UpdateInteraction) =>
      InteractionResultSchema.parse(
        await request(
          `/${encodeURIComponent(id)}`,
          'PATCH',
          UpdateInteractionSchema.parse(input),
        ),
      ),
    reserve: async (id: string, input: ReserveInteraction) =>
      InteractionResultSchema.parse(
        await request(
          `/${encodeURIComponent(id)}/reserve`,
          'POST',
          ReserveInteractionSchema.parse(input),
        ),
      ),
    observe: async (id: string, input: ObserveInteraction) =>
      InteractionResultSchema.parse(
        await request(
          `/${encodeURIComponent(id)}/observe`,
          'POST',
          ObserveInteractionSchema.parse(input),
        ),
      ),
  };
}

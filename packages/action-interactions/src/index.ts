import { z } from 'zod';

const text = z.string().min(1).max(512);
const requestId = z.string().uuid();
const jsonValue = z.json();
export type JsonValue = z.infer<typeof jsonValue>;
const values = z.record(z.string().max(256), jsonValue);
const claimOwner = z.strictObject({
  kind: z.literal('flow-claim'),
  flowId: text,
  runId: text,
  stepId: text,
  collectionId: text,
  schemaDigest: text,
  network: text,
  accountDid: text,
});
export const InteractionOwnerSchema = z.discriminatedUnion('kind', [
  claimOwner,
  z.strictObject({ kind: z.literal('question'), requestId: text }),
  z.strictObject({ kind: z.literal('artifact'), artifactId: text }),
]);
const context = { version: z.literal(1), requestId, sessionId: text };
export const PrepareInteractionSchema = z.strictObject({
  ...context,
  owner: InteractionOwnerSchema,
  values,
});
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
  }),
  z.strictObject({
    ...mutation,
    operationKey: requestId,
    outcome: z.literal('reported'),
    ownerExecutionRef: text,
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
export type CheckClaimDispatch = z.infer<typeof CheckClaimDispatchSchema>;
export const ClaimDispatchResultSchema = z.strictObject({
  allowed: z.literal(true),
  managed: z.boolean(),
});
export const InteractionSchema = z.strictObject({
  version: z.literal(1),
  id: requestId,
  revision: z.number().int().positive(),
  sessionId: text,
  oracleDid: text,
  owner: InteractionOwnerSchema,
  values,
  updatedByUser: z.array(z.string()),
  status: z.enum([
    'draft',
    'reserved',
    'outcome-unknown',
    'observed',
    'cancelled',
  ]),
  createdAt: z.number().int(),
  expiresAt: z.number().int(),
  reservation: z
    .strictObject({ operationKey: requestId, valuesDigest: text })
    .optional(),
  ownerExecutionRef: text.optional(),
});
export const InteractionResultSchema = z.strictObject({
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
    const body: unknown = await response.json();
    if (!response.ok) {
      const error = z
        .object({ code: z.string(), message: z.string() })
        .safeParse(body);
      throw new ActionInteractionError(
        response.status,
        error.success ? error.data.code : 'request_failed',
        error.success ? error.data.message : 'Interaction request failed',
      );
    }
    return body;
  }
  return {
    checkClaimDispatch: async (input: CheckClaimDispatch) =>
      ClaimDispatchResultSchema.parse(
        await request(
          '/claim-dispatch',
          'POST',
          CheckClaimDispatchSchema.parse(input),
        ),
      ),
    list: async (sessionId: string) =>
      z
        .array(InteractionSchema)
        .parse(await request(`?sessionId=${encodeURIComponent(sessionId)}`)),
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

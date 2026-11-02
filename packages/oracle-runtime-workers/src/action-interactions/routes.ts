import {
  ActionInteractionError,
  PrepareInteractionSchema,
  UpdateInteractionSchema,
  ReserveInteractionSchema,
  ObserveInteractionSchema,
} from '@ixo/action-interactions';
import { z } from 'zod';
import type { InteractionCommand } from './store';

const InteractionIdSchema = z.string().uuid();
const InteractionSessionIdSchema = z.string().min(1).max(512);

/**
 * Structural parsing happens before the authenticated per-user object is
 * called. Only these shapes exist: `POST /` prepares, `PATCH /:id` updates
 * or cancels, `POST /:id/reserve` and `POST /:id/observe` are the host's.
 * Anything else, including a path id that is not a UUID, is not found.
 */
export async function parseInteractionCommand(
  request: Request,
  id?: string,
  hostOperation?: string,
): Promise<InteractionCommand> {
  const notFound = () =>
    new ActionInteractionError(
      404,
      'not_found',
      'Unknown interaction operation',
    );
  if (id !== undefined && !InteractionIdSchema.safeParse(id).success)
    throw notFound();
  const method = request.method;
  const body: unknown = await request.json().catch(() => null);
  if (method === 'POST' && id === undefined && hostOperation === undefined)
    return { kind: 'prepare', input: PrepareInteractionSchema.parse(body) };
  if (method === 'PATCH' && id !== undefined && hostOperation === undefined)
    return { kind: 'update', id, input: UpdateInteractionSchema.parse(body) };
  if (method === 'POST' && id !== undefined && hostOperation === 'reserve')
    return { kind: 'reserve', id, input: ReserveInteractionSchema.parse(body) };
  if (method === 'POST' && id !== undefined && hostOperation === 'observe')
    return { kind: 'observe', id, input: ObserveInteractionSchema.parse(body) };
  throw notFound();
}

/** A read: `GET /?sessionId=` lists, `GET /:id?sessionId=` reads one. */
export function parseInteractionRead(
  sessionId: string | undefined,
  id?: string,
  operation?: string,
): { sessionId: string; id?: string } {
  if (
    operation !== undefined ||
    (id !== undefined && !InteractionIdSchema.safeParse(id).success)
  )
    throw new ActionInteractionError(404, 'not_found', 'Interaction not found');
  const session = InteractionSessionIdSchema.safeParse(sessionId);
  if (!session.success)
    throw new ActionInteractionError(
      400,
      'invalid_request',
      'sessionId is required',
    );
  return { sessionId: session.data, ...(id !== undefined ? { id } : {}) };
}

/** The HTTP status for an owner refusal; anything unexpected is a conflict. */
export function interactionStatus(
  status: number,
): 400 | 403 | 404 | 409 | 410 | 413 {
  return status === 400 ||
    status === 403 ||
    status === 404 ||
    status === 410 ||
    status === 413
    ? status
    : 409;
}

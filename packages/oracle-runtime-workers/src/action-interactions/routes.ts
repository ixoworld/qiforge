import {
  ActionInteractionError,
  PrepareInteractionSchema,
  UpdateInteractionSchema,
  ReserveInteractionSchema,
  ObserveInteractionSchema,
} from '@ixo/action-interactions';
import type { InteractionCommand } from './store';

/** Structural parsing happens before the authenticated per-user object is called. */
export async function parseInteractionCommand(
  request: Request,
  id?: string,
  hostOperation?: string,
): Promise<InteractionCommand> {
  const body: unknown = await request.json().catch(() => null);
  if (!id)
    return { kind: 'prepare', input: PrepareInteractionSchema.parse(body) };
  if (request.method === 'PATCH')
    return { kind: 'update', id, input: UpdateInteractionSchema.parse(body) };
  if (hostOperation === 'reserve')
    return { kind: 'reserve', id, input: ReserveInteractionSchema.parse(body) };
  if (hostOperation === 'observe')
    return { kind: 'observe', id, input: ObserveInteractionSchema.parse(body) };
  throw new ActionInteractionError(
    404,
    'not_found',
    'Unknown interaction operation',
  );
}

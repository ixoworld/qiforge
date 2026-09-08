/**
 * The Node runtime's `logActionToMatrix`: a best-effort `ixo.action.log`
 * room event recording a frontend action (browser tool / AG-UI action) and
 * its outcome, posted only when the turn has a room. Never throws.
 */
import type { RuntimeContext } from '../../plugin-api/types';

export const ACTION_LOG_EVENT_TYPE = 'ixo.action.log';

export interface LoggedAction {
  name: string;
  args: Record<string, unknown>;
  result: unknown;
  error?: string;
  success: boolean;
}

export function logActionToMatrix(
  ctx: Pick<RuntimeContext, 'matrix' | 'session' | 'logger'>,
  action: LoggedAction,
): void {
  const roomId = ctx.session.roomId;
  if (!roomId) return;
  void ctx.matrix
    .postEvent(roomId, ACTION_LOG_EVENT_TYPE, {
      action,
      threadId: ctx.session.id,
    })
    .catch((err: unknown) => {
      ctx.logger.warn?.(
        `[portal] action log for ${action.name} not posted: ${err instanceof Error ? err.message : String(err)}`,
      );
    });
}

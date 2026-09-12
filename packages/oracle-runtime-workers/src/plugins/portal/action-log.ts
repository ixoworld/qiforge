/**
 * The Node runtime's `logActionToMatrix`: a best-effort `ixo.action.log`
 * room event recording a frontend action (browser tool / AG-UI action) and
 * its outcome, posted only when the turn has a room. Never throws.
 *
 * Retried across a gateway restart (the gateway object is replaced on every
 * deploy and can be drained mid-turn) and handed to the host to keep alive
 * past the turn, so the audit trail does not lose entries to resets. A
 * custom event carries no transaction id in the SDK, so the one window that
 * can duplicate an entry is a response lost between the homeserver's ack and
 * the reply to the gateway — sub-second, and a duplicate audit line is
 * harmless.
 */
import { retryGateway, type RetryGatewayOptions } from '../../do/gateway-retry';
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
  ctx: Pick<RuntimeContext, 'matrix' | 'session' | 'logger' | 'background'>,
  action: LoggedAction,
  retry?: Pick<RetryGatewayOptions, 'delaysMs' | 'sleep' | 'isTransient'>,
): void {
  const roomId = ctx.session.roomId;
  if (!roomId) return;
  const errorText = (err: unknown): string =>
    err instanceof Error ? err.message : String(err);
  const work = retryGateway(
    () =>
      ctx.matrix.postEvent(roomId, ACTION_LOG_EVENT_TYPE, {
        action,
        threadId: ctx.session.id,
      }),
    {
      ...retry,
      onRetry: (err, attempt, delayMs) =>
        ctx.logger.warn?.(
          `[portal] action log for ${action.name} failed (attempt ${attempt}) — retrying in ${delayMs} ms: ${errorText(err)}`,
        ),
    },
  ).then(
    () => undefined,
    (err: unknown) => {
      ctx.logger.warn?.(
        `[portal] action log for ${action.name} not posted: ${errorText(err)}`,
      );
    },
  );
  ctx.background?.(work);
}

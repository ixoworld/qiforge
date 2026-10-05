import {
  ActionCallEvent,
  BrowserToolCallEvent,
  rootEventEmitter,
} from '@ixo/oracles-events';
import {
  frontendInvocationId,
  frontendOutcomeUnknown,
  reportsUnknownOutcome,
} from '../frontend-bridge/index.js';

export type { FrontendOutcomeUnknown } from '../frontend-bridge/index.js';

export interface IFrontendToolCallerParams {
  sessionId: string;
  toolId: string;
  toolName: string;
  args: Record<string, unknown>;
  toolType: 'browser' | 'agui';
  timeout?: number;
  /** Receives the invocation id the call was sent with (for diagnostics). */
  onInvocation?: (invocationId: string) => void;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

/**
 * Call a frontend tool (browser tool or AG-UI action) over the WebSocket
 * bridge and wait for its result.
 *
 * Every call gets its own invocation id and only a result carrying that id
 * AND the call's session settles it. The listener is attached before the
 * call is emitted, so an immediate answer cannot be missed. A deadline
 * resolves with `FRONTEND_OUTCOME_UNKNOWN` rather than rejecting: the browser
 * may still have performed the write.
 */
export async function callFrontendTool({
  sessionId,
  toolId,
  toolName,
  args,
  toolType,
  timeout = 15000,
  onInvocation,
}: IFrontendToolCallerParams): Promise<unknown> {
  const invocationId = frontendInvocationId(toolId);
  onInvocation?.(invocationId);
  const resultEventName =
    toolType === 'browser' ? 'browser_tool_result' : 'action_call_result';

  return new Promise((resolve, reject) => {
    const cleanup = () => {
      clearTimeout(timeoutHandle);
      rootEventEmitter.removeListener(resultEventName, resultHandler);
    };
    const resultHandler = (...events: unknown[]) => {
      const data = events[0];
      if (!isRecord(data)) return;
      if (data.sessionId !== sessionId || data.toolCallId !== invocationId)
        return;
      cleanup();
      const result = data.result;
      if (typeof data.error === 'string' && data.error) {
        reject(new Error(data.error));
      } else if (
        toolType === 'agui' &&
        isRecord(result) &&
        result.success === false &&
        !reportsUnknownOutcome(result)
      ) {
        reject(
          new Error(
            typeof result.error === 'string' && result.error
              ? result.error
              : 'Action failed',
          ),
        );
      } else {
        resolve(result);
      }
    };

    // Armed before the listener: `cleanup` is only reachable through the
    // listener, the timer or the dispatch failure below, all of which run
    // after this line.
    const timeoutHandle = setTimeout(() => {
      cleanup();
      resolve(frontendOutcomeUnknown(invocationId));
    }, timeout);
    rootEventEmitter.on(resultEventName, resultHandler);

    try {
      const payload = {
        sessionId,
        requestId: toolId,
        toolCallId: invocationId,
        toolName,
        args,
      };
      if (toolType === 'browser') new BrowserToolCallEvent(payload).emit();
      else new ActionCallEvent({ ...payload, status: 'isRunning' }).emit();
    } catch (error) {
      cleanup();
      reject(error instanceof Error ? error : new Error(String(error)));
    }
  });
}

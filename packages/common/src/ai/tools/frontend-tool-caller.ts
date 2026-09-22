import { randomUUID } from 'node:crypto';
import {
  ActionCallEvent,
  BrowserToolCallEvent,
  rootEventEmitter,
} from '@ixo/oracles-events';

export interface IFrontendToolCallerParams {
  sessionId: string;
  toolId: string;
  toolName: string;
  args: Record<string, unknown>;
  toolType: 'browser' | 'agui';
  timeout?: number;
  onInvocation?: (invocationId: string) => void;
}

/** A transport deadline cannot establish whether a browser-side write persisted. */
export type FrontendOutcomeUnknown = {
  success: false;
  code: 'FRONTEND_OUTCOME_UNKNOWN';
  outcome: 'unknown';
  invocationId: string;
  message: string;
};

export async function callFrontendTool({
  sessionId,
  toolId,
  toolName,
  args,
  toolType,
  timeout = 15000,
  onInvocation,
}: IFrontendToolCallerParams): Promise<unknown> {
  const invocationId = `${toolId}:${randomUUID()}`;
  onInvocation?.(invocationId);
  const resultEventName =
    toolType === 'browser' ? 'browser_tool_result' : 'action_call_result';

  return new Promise((resolve, reject) => {
    let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
    const cleanup = () => {
      clearTimeout(timeoutHandle);
      rootEventEmitter.removeListener(resultEventName, resultHandler);
    };
    const resultHandler = (...events: unknown[]) => {
      const value = events[0];
      if (!value || typeof value !== 'object') return;
      const data = value as Record<string, unknown>;
      if (data.sessionId !== sessionId || data.toolCallId !== invocationId)
        return;
      cleanup();
      if (typeof data.error === 'string' && data.error) {
        reject(new Error(data.error));
      } else if (
        toolType === 'agui' &&
        data.result !== null &&
        typeof data.result === 'object' &&
        'success' in data.result &&
        data.result.success === false
      ) {
        const result = data.result;
        if ('outcome' in result && result.outcome === 'unknown')
          resolve(result);
        else
          reject(
            new Error(
              'error' in result && typeof result.error === 'string'
                ? result.error
                : 'Action failed',
            ),
          );
      } else {
        resolve(data.result);
      }
    };

    rootEventEmitter.on(resultEventName, resultHandler);
    timeoutHandle = setTimeout(() => {
      cleanup();
      resolve({
        success: false,
        code: 'FRONTEND_OUTCOME_UNKNOWN',
        outcome: 'unknown',
        invocationId,
        message:
          'The frontend result did not arrive. The operation may still complete. Read command status using the original command ID before retrying; do not issue a replacement mutation.',
      } satisfies FrontendOutcomeUnknown);
    }, timeout);

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
      reject(error);
    }
  });
}

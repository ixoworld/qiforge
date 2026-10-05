import { callFrontendTool } from './frontend-tool-caller.js';

export interface AgActionResult {
  result?: unknown;
  error?: string;
  success: boolean;
}

export interface IAgActionCallerParams {
  sessionId: string;
  toolCallId: string;
  toolName: string;
  args: Record<string, unknown>;
  timeout?: number;
  /** Receives the invocation id the call was sent with (for diagnostics). */
  onInvocation?: (invocationId: string) => void;
}

/**
 * Call an AG-UI action that executes on the frontend and wait for the result
 * @param params - The parameters for the AG-UI action call
 * @returns Promise that resolves with the action result
 */
export async function callAgAction({
  sessionId,
  toolCallId,
  toolName,
  args,
  timeout = 10000, // 10 seconds for UI actions
  onInvocation,
}: IAgActionCallerParams): Promise<unknown> {
  return callFrontendTool({
    sessionId,
    toolId: toolCallId,
    toolName,
    args,
    toolType: 'agui',
    timeout,
    onInvocation,
  });
}

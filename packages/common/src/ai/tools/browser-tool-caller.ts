import { callFrontendTool } from './frontend-tool-caller.js';

export interface BrowserToolResult {
  result?: unknown;
  error?: string;
  success: boolean;
}

export interface IBrowserToolCallerParams {
  sessionId: string;
  toolCallId: string;
  toolName: string;
  args: Record<string, unknown>;
  timeout?: number;
  onInvocation?: (invocationId: string) => void;
}

/**
 * Call a tool that executes on the browser client and wait for the result
 * @param params - The parameters for the browser tool call
 * @returns Promise that resolves with the tool result
 */
export async function callBrowserTool({
  sessionId,
  toolCallId,
  toolName,
  args,
  timeout = 15000,
  onInvocation,
}: IBrowserToolCallerParams): Promise<unknown> {
  return callFrontendTool({
    sessionId,
    toolId: toolCallId,
    toolName,
    args,
    toolType: 'browser',
    timeout,
    onInvocation,
  });
}

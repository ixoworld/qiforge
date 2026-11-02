import type { Socket } from 'socket.io-client';
import { type IBrowserToolParams } from '../../types/browser-tool.type.js';

export interface ToolExecutionConfig {
  socket: Pick<Socket, 'emit'>;
  toolId: string;
  eventName: 'tool_result' | 'action_call_result';
  sessionId: string;
}

export interface BrowserToolCall {
  sessionId: string;
  toolCallId: string;
  toolName: string;
  args: Record<string, unknown>;
}

/**
 * Execute a tool/action and emit the result via WebSocket
 * This unified function handles both browser tools and AG-UI actions
 * @param config Configuration for tool execution and result emission
 * @param executor Function that executes the tool/action
 */
export async function executeToolAndEmitResult<T>(
  config: ToolExecutionConfig,
  executor: () => Promise<T>,
): Promise<void> {
  try {
    const result = await executor();

    // Emit success result
    config.socket.emit(config.eventName, {
      toolCallId: config.toolId,
      sessionId: config.sessionId,
      result,
    });
  } catch (error) {
    // Emit error result
    config.socket.emit(config.eventName, {
      toolCallId: config.toolId,
      sessionId: config.sessionId,
      result:
        config.eventName === 'action_call_result'
          ? {
              success: false,
              error: error instanceof Error ? error.message : 'Unknown error',
            }
          : null,
      error: error instanceof Error ? error.message : 'Unknown error',
    });
  }
}

/**
 * Answer a browser tool call with a definite error, without running
 * anything: the same `tool_result` frame a tool that threw sends
 * (`result: null` and the message as `error`), so the runtime fails the
 * call instead of waiting for an answer that never comes.
 */
export function refuseBrowserToolCall(
  socket: Pick<Socket, 'emit'>,
  data: BrowserToolCall,
  error: string,
): void {
  socket.emit('tool_result', {
    toolCallId: data.toolCallId,
    sessionId: data.sessionId,
    result: null,
    error,
  });
}

/**
 * Run a browser tool and return its result to the exact Oracle session that
 * issued the call. Browser tools use the same session correlation contract as
 * AG-UI actions. A call of a tool the registry lacks is answered with a
 * definite error, also when the registry is empty or absent (`Tool <name>
 * not found: no browser tools registered`): the runtime sends a call to one
 * socket only, so leaving it unanswered would end it as an unknown outcome.
 */
export async function executeBrowserToolCall(
  socket: Pick<Socket, 'emit'>,
  browserTools: Record<string, Pick<IBrowserToolParams, 'fn'>> | undefined,
  data: BrowserToolCall,
): Promise<void> {
  if (!browserTools || Object.keys(browserTools).length === 0) {
    refuseBrowserToolCall(
      socket,
      data,
      `Tool ${data.toolName} not found: no browser tools registered`,
    );
    return;
  }
  await executeToolAndEmitResult(
    {
      socket,
      toolId: data.toolCallId,
      eventName: 'tool_result',
      sessionId: data.sessionId,
    },
    async () => {
      const tool = browserTools[data.toolName];
      if (!tool) {
        throw new Error(`Tool ${data.toolName} not found`);
      }
      return tool.fn(data.args);
    },
  );
}
